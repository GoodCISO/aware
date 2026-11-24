// src/refine.js — Heavy refinement of the best initial attempt
// Single deep pass that takes the strongest initial attempt and pushes it further:
// self-critique → identify weaknesses → produce improved version with explicit
// justification for the changes.

// SCORE-INSTRUMENT CONTRACT (2026-11-11, kanban t_99423c45)
// ---------------------------------------------------------------------
// This module NEVER produces a PRM (judge) score. It used to expose
// `refined_score`, which held either the provider's self-reported
// `confidence` or a length-ratio heuristic bucket, and src/index.js copied
// that value straight into `chosen.prm_score` — a field the DPO gate
// compares against a JUDGE-scored `rejected.prm_score`.
//
// The consequence was that the gate subtracted two different instruments:
// the heuristic tops out at 0.75 while the judge routinely returns
// 0.8-1.0, so the gap was systematically negative and the trainer's
// directionality check dropped better-refined pairs as "PRM-inverted".
//
// The refined trace is now scored by the SAME PRM judge that scores the
// initial attempts (see src/index.js). This module therefore exposes only
// a CONFIDENCE-shaped value, under a name that cannot be mistaken for a
// judge score:
//
//   refinement_confidence — provider-reported confidence, or the legacy
//                            length heuristic as a fallback. NOT a judge
//                            score. Never compare it with a judge score.
//
// The heuristic is kept (not deleted) because the coordinator maps
// `confidence` onto its L1/L2/L3 autonomy levels. It is simply no longer
// reachable from any field the DPO gate treats as a judge score.

export async function refine({ problem, best_attempt, task_type, context, client, system_prompt }) {
  // MR-HIGH-002 fix: pass system_prompt through to buildRefinementPrompt so
  // the caller can request { system, user } shape for true isolation.
  const refinementPrompt = buildRefinementPrompt({ problem, best_attempt, task_type, context, system_prompt });

  const result = await client.generate(refinementPrompt, { task_type, phase: 'refine' });

  const refined_trace = result.reasoning || result.text || best_attempt;
  // SCORE-INSTRUMENT CONTRACT: see the header note above. The
  // provider's self-reported `confidence` is NOT a judge score and
  // must never reach a prm_score field.
  const providerConfidence = typeof result.confidence === 'number'
    ? result.confidence
    : null;
  const refinementConfidence = providerConfidence ?? scoreHeuristic(refined_trace, best_attempt);
  const cost_usd = result.cost_usd || 0;

  return {
    refined_trace,
    // NOT a PRM score — see the score-instrument contract above.
    refinement_confidence: Math.max(0, Math.min(1, refinementConfidence)),
    // Backwards-compatible alias for the same value (the coordinator
    // maps `confidence` onto its L1/L2/L3 autonomy levels).
    confidence: Math.max(0, Math.min(1, refinementConfidence)),
    cost_usd,
    // Additive: retry metadata from the provider client. See
    // t_22a34f6d design §3.4.2.
    __retriedAttempts: result.__retriedAttempts || 0,
  };
}

function buildRefinementPrompt({ problem, best_attempt, task_type, context, system_prompt }) {
  const ctxStr = context && Object.keys(context).length
    ? `\n\nContext:\n${JSON.stringify(context, null, 2)}`
    : '';

  // MR-HIGH-002 fix: when system_prompt is provided, return { system, user }
  // shape so the client builds two-role messages. Legacy callers get the
  // single-string concatenated shape.
  if (system_prompt) {
    const user = `Original problem: ${problem}${ctxStr}

Best initial attempt:
"""
${best_attempt}
"""

Steps:
1. Identify the 2-3 weakest parts of the attempt (logical gaps, missed edge cases, unjustified claims, structural issues)
2. For each, state the weakness explicitly
3. Produce a refined, improved version that addresses all weaknesses
4. Briefly justify each change

Output format:
WEAKNESSES:
- <weakness 1>
- <weakness 2>

REFINED SOLUTION:
<your improved reasoning/solution>

CHANGES JUSTIFIED:
- <change 1 — why>
- <change 2 — why>`;
    return { system: system_prompt, user };
  }

  return `You are refining a reasoning attempt that was the strongest of K parallel attempts. Your job is to make it stronger.

Original problem: ${problem}${ctxStr}

Best initial attempt:
"""
${best_attempt}
"""

Steps:
1. Identify the 2-3 weakest parts of the attempt (logical gaps, missed edge cases, unjustified claims, structural issues)
2. For each, state the weakness explicitly
3. Produce a refined, improved version that addresses all weaknesses
4. Briefly justify each change

Output format:
WEAKNESSES:
- <weakness 1>
- <weakness 2>

REFINED SOLUTION:
<your improved reasoning/solution>

CHANGES JUSTIFIED:
- <change 1 — why>
- <change 2 — why>`;
}

function scoreHeuristic(refined, original) {
  // Fallback when client doesn't return confidence. Length-aware heuristic.
  if (refined === original) return 0.5;
  if (refined.length < original.length * 0.5) return 0.4;  // too short → probably stripped
  if (refined.length > original.length * 4) return 0.6;    // very long → verbose
  return 0.75;
}
