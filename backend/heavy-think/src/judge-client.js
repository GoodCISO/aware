// src/judge-client.js — WHICH client serves the judge (kanban t_89720a07).
//
// WHY THIS EXISTS
// ---------------
// One client served BOTH the producer and the judge, so the judge was the
// candidate's own model: the judge graded its own house style. Audit
// t_8f049433 (3.1, 5.1) measured that AWARE had no mechanism by which a
// judge could be independent of the candidate — the documented judge model
// override (options.prm.model) did not exist, and the only alternative
// backend was the AWARE-trained LoRA artefact (the model the preference
// pairs train).
//
// The rule being honoured is
// measurement-experimentation-ops/references/04-ai-product-evaluation.md
// (:157-160): "If judge and candidate share a model family, the judge is
// grading its own house style... Run it again with an independent judge
// before it gates anything."
//
// THE CONTRACT
// ------------
//   options.judgeClient — an INDEPENDENT judge client. When present, EVERY
//   judge call (PRM scoring of the attempts, PRM scoring of the refined
//   trace, the llm-judge verification) is served by it and NEVER by
//   options.client.
//
//   options.client     — the PRODUCER's client. It keeps producing the
//   reasoning attempts and the refinement.
//
// When NO judge client is configured the judge falls back to the producer's
// client (the legacy behaviour) — but the fact is RECORDED, so a pair scored
// that way is never mistaken for an independently judged pair.
//
// FAIL-CLOSED
// -----------
// A judge client that is configured but UNAVAILABLE must not fall back to
// the candidate's client: a silent fallback reintroduces exactly the defect
// this module exists to remove. callJudge() turns such a failure into a
// distinguishable, tagged error and never re-routes the call.

/**
 * Which client served a judge score.
 *
 *   JUDGE             — an independent judge client served the score.
 *   PRODUCER_FALLBACK — no judge client was configured; the producer's own
 *                       client served the judge, so the verdict is same-family
 *                       by construction and is a DIAGNOSTIC, never a gate.
 */
export const JUDGE_CLIENT_SOURCE = Object.freeze({
  JUDGE: 'judge',
  PRODUCER_FALLBACK: 'producer_fallback',
});

/**
 * The error code carried by a judge failure caused by an unavailable
 * (configured) judge client.
 */
export const JUDGE_UNAVAILABLE_CODE = 'judge_client_unavailable';

/**
 * Resolve the judge for a heavy_think call.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.client]      — the producer's client.
 * @param {Object} [opts.judgeClient] — the independent judge client (optional).
 * @returns {{client: Object|null, configured: boolean, source: string, model: string|null}}
 */
export function resolveJudgeClient({ client = null, judgeClient = null } = {}) {
  const configured = Boolean(judgeClient);
  const judge = configured ? judgeClient : client;
  const model = judge && typeof judge.model === 'string' && judge.model.trim()
    ? judge.model.trim()
    : null;
  return {
    client: judge || null,
    configured,
    source: configured ? JUDGE_CLIENT_SOURCE.JUDGE : JUDGE_CLIENT_SOURCE.PRODUCER_FALLBACK,
    model,
  };
}

/**
 * Run a judge call, failing CLOSED when an independent judge client is
 * configured but unavailable.
 *
 * The fallback to the candidate's client happens only when NO judge client
 * was configured at all — that case is a configuration choice, not a
 * failure, and the caller records it on the pair record. A judge client
 * that is configured and then fails is an ERROR: the score is lost, the
 * pair says so, and nothing is silently scored by the candidate's model.
 *
 * @param {Function} fn  — the judge call.
 * @param {Object} [opts]
 * @param {boolean} [opts.configured] — whether an independent judge client was configured.
 * @param {string}  [opts.model]      — the judge's model id (for the error message).
 * @returns {Promise<any>}
 */
export async function callJudge(fn, { configured = false, model = null } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!configured) throw err;
    const message =
      `judge client unavailable (${model || 'unknown model'}): ${err && err.message ? err.message : String(err)}`;
    const wrapped = new Error(message, err ? { cause: err } : undefined);
    wrapped.code = JUDGE_UNAVAILABLE_CODE;
    wrapped.judgeModel = model;
    throw wrapped;
  }
}
