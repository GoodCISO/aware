// src/prm.js — Process Reward Model judge
// Scores an agent's reasoning attempt on quality (process, not outcome).
// Default: minimax-M3 via Anthropic-compatible API.
//
// The PRM judge is deliberately lighter-weight than the reasoning model. We use it
// K+1 times per heavy_think call (K parallel attempts + 1 for the refinement).
// Per AWARE 2.0 ADR-020: cheap model, batch scoring, JSON output.

import { resolveJudgeClient, callJudge } from './judge-client.js';

const DEFAULT_PRM_PROMPT = `You are a reasoning quality evaluator. Score the agent's reasoning on a scale of 1-10.

Focus on REASONING PROCESS, not outcome. A correct answer reached by flawed reasoning should score low.

Score rubric:
- 1-3: Flawed logic, hallucination, irrelevant or circular reasoning
- 4-6: Adequate but incomplete, minor gaps, some hand-waving
- 7-8: Strong reasoning, clear structure, addressed main cases
- 9-10: Excellent, anticipates edge cases, self-corrects, justified claims

Output strict JSON: { "score": <1-10>, "strengths": [...], "weaknesses": [...], "confidence": 0.0-1.0 }`;

export async function scoreWithPRM({ problem, reasoning, task_type, context, prmConfig = {}, client, judgeClient }) {
  // MR-HIGH-002 fix: pass system_prompt through to buildPRMPrompt so the
  // PRM judge gets true { system, user } isolation too. The PRM judge is
  // especially vulnerable to prompt injection (it sees both the agent's
  // reasoning AND the original problem as user input) — system-role
  // separation makes the score robust.
  const systemOverride = prmConfig.system_prompt;
  const prompt = buildPRMPrompt({ problem, reasoning, task_type, context, systemOverride });
  // WHICH client serves the judge, and WHICH model (kanban t_89720a07).
  //
  // judgeClient is an INDEPENDENT judge; when it is present the score
  // comes from it and NEVER from the producer's client. When it is
  // absent the producer's client is the judge (legacy behaviour) and the
  // caller records that fact on the pair record, so the pair is never
  // mistaken for an independently judged one.
  //
  // prmConfig.model is the model override index.js has always documented
  // ("PRM judge config (model override, custom prompt)") but never
  // implemented. It travels in the generate options, which every AWARE
  // client honours (opts.model wins over the client's default).
  const judge = resolveJudgeClient({ client, judgeClient });
  const genOpts = { task_type, phase: 'prm_score' };
  if (prmConfig.model) {
    genOpts.model = prmConfig.model;
  }
  const result = await callJudge(
    () => judge.client.generate(prompt, genOpts),
    { configured: judge.configured, model: judge.model || prmConfig.model || null },
  );

  const text = result.reasoning || result.text || '';
  const parsed = parsePRMResponse(text, result);

  return {
    score: clampScore(parsed.score),
    strengths: parsed.strengths || [],
    weaknesses: parsed.weaknesses || [],
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    cost_usd: result.cost_usd || 0,
    raw: text,
    // WHICH client served this score, and WHICH model. These are the
    // inputs the pair record's judge tags are built from (kanban
    // t_89720a07 / t_155a95a1). judge_source is 'judge' when an
    // independent judge client served the call and 'producer_fallback'
    // when the producer's own client did.
    judge_source: judge.source,
    judge_model: prmConfig.model || judge.model || null,
    // Additive: retry metadata from the provider client. See
    // t_22a34f6d design §3.4.2.
    __retriedAttempts: result.__retriedAttempts || 0,
  };
}

function buildPRMPrompt({ problem, reasoning, task_type, context, systemOverride }) {
  // MR-HIGH-002 fix: always return { system, user } so the PRM judge
  // gets architectural isolation. The system prompt is the scoring rubric
  // (which the agent must NOT be able to influence via its reasoning);
  // the user message carries the problem + the agent's reasoning (which
  // IS user input from the model's perspective).
  const system = systemOverride || DEFAULT_PRM_PROMPT;
  const ctxStr = context && Object.keys(context).length
    ? `\n\nContext:\n${JSON.stringify(context, null, 2)}`
    : '';
  const user = `Task category: ${task_type || 'standard'}
Problem: ${problem}${ctxStr}

Agent's reasoning:
"""
${reasoning}
"""`;
  return { system, user };
}

function parsePRMResponse(text, result) {
  // Prefer structured fields if the client returned them (some LLM APIs do)
  if (typeof result.score === 'number') {
    return {
      score: result.score,
      strengths: result.strengths || [],
      weaknesses: result.weaknesses || [],
      confidence: result.confidence,
    };
  }

  // Otherwise extract JSON from the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed;
    } catch {
      // fall through
    }
  }

  // Last resort: heuristic — look for "score: N" pattern
  const scoreMatch = text.match(/score\s*[:=]\s*(\d+)/i);
  if (scoreMatch) {
    return { score: parseInt(scoreMatch[1], 10), strengths: [], weaknesses: [] };
  }

  return { score: 5, strengths: [], weaknesses: [], confidence: 0.3 };
}

function clampScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, n)) / 10;  // normalize to 0-1
}
