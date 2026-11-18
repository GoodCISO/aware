// src/index.js — Public entry point for HeavySkill
// HeavySkill: K parallel reasoning attempts → deep refinement → verification → preference pair
// Reference: AWARE 2.0 ADR-020, Decision 7

import { createHash } from 'node:crypto';
import { parallelReasoning } from './parallel.js';
import { refine } from './refine.js';
import { scoreWithPRM } from './prm.js';
import { verify } from './verify.js';
import { writePreferencePair, shouldSkipDuplicate } from './preference-pair.js';
import { describeJudge } from './judge-role.js';
import { resolveJudgeClient, resolveEffectiveJudgeModel, JUDGE_UNAVAILABLE_CODE } from './judge-client.js';
import { defaultKForTaskType, K_CONFIGS } from './config.js';

/**
 * Heavy reasoning primitive. System-provided, available to all agents.
 *
 * @param {Object} options
 * @param {string} options.problem - The task or question
 * @param {number} [options.K] - Parallel attempts (default: per task_type)
 * @param {string} [options.task_type='standard'] - 'simple' | 'standard' | 'security' | 'financial' | 'creative'
 * @param {Object} [options.context] - Additional context (repo, files, conversation)
 * @param {Object} [options.verification] - { method: 'exec'|'test_suite'|'citation_check'|'kg_consistency', ...args }
 * @param {Object} [options.prm] - PRM judge config (model override, custom prompt)
 * @param {Object} [options.client] - LLM client (for test injection). Must implement { generate(prompt, opts) }
 * @param {Object} [options.judgeClient] - INDEPENDENT judge client. When present every judge
 *   call (PRM scoring, refined-trace PRM scoring, the llm-judge verification) is served by
 *   it and NEVER by options.client. When absent the producer's client is the judge (legacy
 *   behaviour) and the pair record records that fact, so a same-family judge is never
 *   mistaken for an independent one. A configured judge client that is UNAVAILABLE fails
 *   closed — it never falls back to the candidate's model.
 * @param {string} [options.preferencePairPath] - JSONL output path; if omitted, no pair is written
 * @param {Object} [options.cache] - Optional PRM score cache (AWARE 2.0 Phase 2.2).
 *   Must implement { buildCacheKey, getCachedScore, putCachedScore }.
 *   If present, scoreWithPRM is called via a wrapper that checks the cache
 *   first and only calls the live PRM on miss. If absent, behavior is
 *   identical to the pre-cache version (live PRM every time).
 * @returns {Promise<{
 *   refined_trace: string,
 *   confidence: number,
 *   refined_prm_score: number|null,   // judge score of the refined trace
 *   attempts: Array<{ reasoning: string, prm_score: number, selected: boolean }>,
 *   verification: { passed: boolean, method: string, details?: any, duration_ms: number },
 *   cost: { attempts_usd: number, refinement_usd: number, judge_usd: number },
 *   pair_written: boolean,
 *   cache: { hits: number, misses: number, enabled: boolean },
 * }>}
 */
export async function heavy_think(options) {
  if (!options || !options.problem) {
    throw new Error('heavy_think: options.problem is required');
  }

  const K = options.K ?? defaultKForTaskType(options.task_type || 'standard');
  const task_type = options.task_type || 'standard';
  const problem = options.problem;
  const context = options.context || {};
  const verification = options.verification || null;
  const prmConfig = options.prm || {};
  const client = options.client;  // injected for tests; production: build default minimax client
  // The INDEPENDENT judge client (kanban t_89720a07). options.judgeClient
  // is the separate judge client; when it is absent the producer's client
  // is the judge (legacy behaviour) and the pair record records that fact,
  // so the pair is never mistaken for an independently judged one.
  const judgeClient = options.judgeClient || null;
  // WHICH client serves the judge, and WHICH model it uses.
  const judgeRoute = resolveJudgeClient({ client, judgeClient });
  // The model that ACTUALLY serves every judge call in this heavy_think
  // call: `prmConfig.model || judgeRoute.model`. The per-call override
  // travels into the generate options and every client honours `opts.model`
  // over its own default, so the override decides which model produces the
  // score. Resolved ONCE, here, so the cache key, the score's own
  // `judge_model` and the pair record's judge tags cannot disagree about
  // which model produced the verdict (kanban t_dc053dc2).
  //
  // The cache key MUST use this model too: a key built from the serving
  // client's default while the score is produced by the override would
  // serve a score produced by one model under a record that names another.
  const effectiveJudgeModel = resolveEffectiveJudgeModel({
    prmConfig,
    judgeRoute,
  });
  const pairPath = options.preferencePairPath || null;
  const cache = options.cache || null;  // Phase 2.2 — optional PRM score cache
  // MR-HIGH-002 fix: forward system_prompt through the heavy_think pipeline
  // so parallel reasoning + refinement + PRM scoring all use { system, user }
  // message shape when the caller opts in. Legacy callers (no system_prompt)
  // get the original concatenated-string shape.
  const system_prompt = options.system_prompt || null;

  if (K < 1) {
    throw new Error(`heavy_think: K must be >= 1, got ${K}`);
  }

  // 1. PARALLEL REASONING: K independent attempts
  const parallelResult = await parallelReasoning({
    problem, K, task_type, context, client, system_prompt,
  });

  // 2. PRM SCORING: each attempt → score (parallel)
  // parallelReasoning returns attempts as { reasoning, attempt_index } objects
  // Phase 2.2: if a cache is injected, check it first; on miss, call live
  // PRM and write the result back to the cache.
  const cacheStats = { hits: 0, misses: 0, enabled: cache !== null };
  const scored = await Promise.all(
    parallelResult.attempts.map(async (attempt) => {
      let score;
      try {
      if (cache) {
        const key = cache.buildCacheKey({
          problem, reasoning: attempt.reasoning, task_type, context,
          prm_model: effectiveJudgeModel || 'minimax-M3',
        });
        const hit = await cache.getCachedScore(key);
        if (hit) {
          cacheStats.hits++;
          score = { ...hit, cost_usd: 0 };  // cached reads have zero PRM cost
        } else {
          cacheStats.misses++;
          score = await scoreWithPRM({
            problem, reasoning: attempt.reasoning, task_type, context, prmConfig, client, judgeClient,
          });
          // Fire-and-forget cache write — must not block the scoring path.
          // Cache errors are silently swallowed inside putCachedScore.
          cache.putCachedScore(key, score).catch(() => { /* ignore */ });
        }
      } else {
        score = await scoreWithPRM({
          problem, reasoning: attempt.reasoning, task_type, context, prmConfig, client, judgeClient,
        });
      }
      } catch (err) {
        // A CONFIGURED but unavailable judge fails CLOSED (kanban
        // t_89720a07): the score is lost rather than taken from the
        // candidate's client. The attempt keeps a null score so the pair
        // records the loss instead of silently scoring the candidate
        // with itself.
        if (!err || err.code !== JUDGE_UNAVAILABLE_CODE) throw err;
        score = {
          score: null,
          cost_usd: 0,
          judge_source: 'judge_unavailable',
          judge_model: effectiveJudgeModel,
          raw: '',
        };
      }
      return { ...attempt, prm_score: score.score, prm_meta: score };
    })
  );

  // 3. PICK BEST initial attempt
  const sortedByScore = [...scored].sort((a, b) => b.prm_score - a.prm_score);
  const bestInitial = sortedByScore[0];
  const attemptsWithSelection = scored.map(a => ({ ...a, selected: a === bestInitial }));

  // 4. HEAVY REFINEMENT of best attempt
  const refinement = await refine({
    problem, best_attempt: bestInitial.reasoning, task_type, context, client, system_prompt,
  });

  // 4b. JUDGE-SCORE THE REFINED TRACE — the SAME instrument that scored
  //     the initial attempts.
  //
  // src/prm.js documents K+1 PRM calls per heavy_think call (K attempts + 1
  // for the refinement); that call was never actually made, and the
  // refinement's score was faked with a length heuristic instead. The
  // trainer's `min_score_gap` gate then subtracted a heuristic value
  // (capped at 0.75) from a judge value (routinely 0.8-1.0), so the gap
  // was systematically negative and better-refined pairs were dropped as
  // "PRM-inverted" (kanban t_99423c45).
  //
  // If the judge call fails we do NOT fall back to a heuristic: the pair is
  // written with prm_score=null and prm_score_source='unavailable', and the
  // trainer's existing missing-scores policy drops it. A missing score is
  // honest; a fake score silently corrupts the training set.
  let refinedJudge = null;
  try {
    if (cache) {
      const key = cache.buildCacheKey({
        problem, reasoning: refinement.refined_trace, task_type, context,
        prm_model: effectiveJudgeModel || 'minimax-M3',
      });
      const hit = await cache.getCachedScore(key);
      if (hit) {
        cacheStats.hits++;
        refinedJudge = { ...hit, cost_usd: 0 };  // cached reads have zero PRM cost
      } else {
        cacheStats.misses++;
        refinedJudge = await scoreWithPRM({
          problem, reasoning: refinement.refined_trace, task_type, context, prmConfig, client, judgeClient,
        });
        cache.putCachedScore(key, refinedJudge).catch(() => { /* ignore */ });
      }
    } else {
      refinedJudge = await scoreWithPRM({
        problem, reasoning: refinement.refined_trace, task_type, context, prmConfig, client, judgeClient,
      });
    }
  } catch (err) {
    refinedJudge = null;
  }
  const refinedJudgeCost = refinedJudge?.cost_usd || 0;

  // 5. VERIFICATION (optional)
  let verificationResult = { passed: true, method: 'none', duration_ms: 0 };
  if (verification) {
    // `client` and `problem` are forwarded so LLM-based verification methods
    // (e.g. 'llm-judge') can run. `client` is the judge itself; `problem` gives
    // the judge the task the trace was produced for — without it the judge can
    // only assess internal consistency, not correctness against the task.
    verificationResult = await verify({
      trace: refinement.refined_trace, verification, context, client, judgeClient, problem,
    });
  }

  // 6. WRITE PREFERENCE PAIR (only if not duplicate)
  //
  // Judge identity + role (kanban t_155a95a1). The pair must say WHO judged
  // it and WHAT ROLE that verdict plays before anything downstream is allowed
  // to gate on it (04-ai-product-evaluation.md:35-36, :187-190). The role is
  // 'diagnostic' unless the judge is an independent model family AND the
  // caller declared a gating role.
  //
  // THE EFFECTIVE JUDGE MODEL (kanban t_dc053dc2). The model that served the
  // score is `prmConfig.model || judgeRoute.model`: the per-call override
  // travels into the generate options and every client honours `opts.model`
  // over its own default, so the override really does decide which model
  // produced the verdict. The judge tags must therefore be computed from
  // THAT model — not from the serving client's default.
  //
  // Before this, the override was honoured only when a `judgeClient` was
  // configured. In the no-`judgeClient` branch — AWARE's production default,
  // since a judge client is built only when AWARE_JUDGE_MODEL is set — the
  // override changed the serving model while the record named the
  // producer's model. Two consequences, both on the fields the trainer
  // trusts (`mayJudgeGate()` in AWARE's src/trainer/judge-role.js):
  //   * `prm_score_judge_model` was a FALSE statement about which model
  //     produced the score; and
  //   * the independence verdict was computed against the WRONG model, so a
  //     genuinely independent override (`qwen3-32b`) was not recognised as
  //     independent and the override was silently useless for its purpose.
  //
  // The effective model is resolved through the ONE shared helper
  // (`resolveEffectiveJudgeModel`), the same one the score's own
  // `judge_model` uses, so the record can never name a model that did not
  // serve the score.
  //
  // FAIL CLOSED ON A SAME-FAMILY JUDGE. `describeJudge()` compares model
  // FAMILIES (kanban t_2a91cc4b), so a same-family effective judge — the
  // identical model, a cheaper sibling such as `MiniMax-M3` next to
  // `MiniMax-M3.1-Flash`, or the AWARE-trained LoRA artefact — is
  // demoted to 'diagnostic' with `prm_score_independent=false`, whatever
  // role the caller requested. A per-call override must not be able to
  // RAISE a judge's authority above what the family rule allows.
  //
  // THE CHOICE (AC4 of t_dc053dc2): DEMOTE THE VERDICT, DO NOT REFUSE THE
  // CALL. The override is honoured for SCORING — an operator may
  // legitimately want a cheaper judge — and only the verdict's AUTHORITY is
  // demoted. 04-ai-product-evaluation.md:240-243 is about the verdict's
  // authority ("Same family -> the verdict is a DIAGNOSTIC, never a launch
  // gate ... Run it again with an independent judge before it gates
  // anything"), not about whether the verdict may be computed; refusing the
  // call would discard a score the operator asked for without making the
  // verdict any safer.
  //
  // `effectiveJudgeModel` is resolved once, near the top of this function
  // (see `resolveEffectiveJudgeModel` above), so the cache key, the score's
  // own `judge_model` and these tags all name the same model.
  const judge = describeJudge({
    candidateModel: client?.model || null,
    judgeModel: effectiveJudgeModel,
    role: prmConfig.role || null,
  });
  let pair_written = false;
  if (pairPath) {
    const contentHash = hashAttempt(problem, bestInitial.reasoning, refinement.refined_trace);
    const isDup = await shouldSkipDuplicate({ path: pairPath, contentHash });
    if (!isDup) {
      await writePreferencePair({
        path: pairPath,
        record: {
          ts: new Date().toISOString(),
          problem,
          task_type,
          // Judge role + independence (kanban t_155a95a1). The verdict's
          // ROLE is declared on the record so nothing downstream can gate
          // on a score whose role was never named. See src/judge-role.js.
          prm_score_role: judge.prm_score_role,
          prm_score_independent: judge.prm_score_independent,
          prm_score_judge_model: judge.prm_score_judge_model,
          // WHICH client served the judge (kanban t_89720a07): 'judge' when
          // an independent judge client served the score,
          // 'producer_fallback' when the producer's own client did — i.e.
          // the verdict is same-family by construction.
          prm_score_judge_client_source: judgeRoute.source,
          chosen: {
            reasoning: refinement.refined_trace,
            // Judge-sourced — the SAME instrument as `rejected.prm_score`.
            prm_score: refinedJudge ? refinedJudge.score : null,
            prm_score_source: refinedJudge ? 'prm_judge' : 'unavailable',
            // The refinement's own confidence (provider-reported, or the
            // legacy length heuristic). NOT a PRM score — never compare it
            // against a judge score.
            refinement_confidence: refinement.refinement_confidence,
            ...judge,
          },
          rejected: {
            reasoning: bestInitial.reasoning,
            prm_score: bestInitial.prm_score,
            // 'unavailable' when the judge call failed outright (a missing
            // score is honest; a fake score corrupts the training set).
            prm_score_source: bestInitial.prm_score === null ? 'unavailable' : 'prm_judge',
            ...judge,
          },
          all_attempts: attemptsWithSelection.map(a => ({
            reasoning: a.reasoning,
            prm_score: a.prm_score,
            selected: a.selected,
          })),
          verification: {
            method: verificationResult.method,
            passed: verificationResult.passed,
            duration_ms: verificationResult.duration_ms,
          },
          cost: {
            attempts_usd: parallelResult.cost_usd || 0,
            refinement_usd: refinement.cost_usd || 0,
            judge_usd: scored.reduce((s, a) => s + (a.prm_meta?.cost_usd || 0), 0) + refinedJudgeCost,
          },
        },
        contentHash,
      });
      pair_written = true;
    }
  }

  // 7. RETURN
  return {
    refined_trace: refinement.refined_trace,
    confidence: refinement.confidence,
    // Judge score of the refined trace (null when the judge call failed).
    refined_prm_score: refinedJudge ? refinedJudge.score : null,
    attempts: attemptsWithSelection,
    verification: verificationResult,
    cost: {
      attempts_usd: parallelResult.cost_usd || 0,
      refinement_usd: refinement.cost_usd || 0,
      judge_usd: scored.reduce((s, a) => s + (a.prm_meta?.cost_usd || 0), 0) + refinedJudgeCost,
    },
    pair_written,
    pair_path: pairPath,        // absolute path to the JSONL line, or null if not written
    cache: cacheStats,
  };
}

function hashAttempt(problem, rejected, chosen) {
  return createHash('sha256')
    .update(problem)
    .update('\u0000')
    .update(rejected)
    .update('\u0000')
    .update(chosen)
    .digest('hex')
    .slice(0, 16);
}

export { hashAttempt };
export { parallelReasoning } from './parallel.js';
export { refine } from './refine.js';
export { scoreWithPRM } from './prm.js';
export { verify } from './verify.js';
export { writePreferencePair, shouldSkipDuplicate } from './preference-pair.js';
export { toDpoRow, toDpoDataset, convertFile } from './dpo-format.js';
export { defaultKForTaskType, K_CONFIGS } from './config.js';
export { makeMinimaxClient, DEFAULT_BASE_URL, DEFAULT_MODEL, ANTHROPIC_VERSION } from './clients/minimax.js';
