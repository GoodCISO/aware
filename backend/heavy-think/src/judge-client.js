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
 * The result key a judge client uses to report WHICH MODEL ACTUALLY SERVED
 * the call (kanban t_49d955b7).
 *
 * WHY THIS EXISTS
 * ---------------
 * The effective-model resolution (`resolveEffectiveJudgeModel`) reasons about
 * INTENT: it picks `prmConfig.model` over the serving client's default. That
 * is only the served model if the client HONOURS `opts.model` — and a client
 * is free not to. AWARE's Ollama judge client did not: it posted its own
 * configured model and never read `genOpts.model`, so the record named a
 * model that did not serve the score.
 *
 * The record must be able to name the model that SERVED, not the model that
 * was ASKED FOR. A client that knows which model it served reports it under
 * this key, and the record prefers it over the resolved intent.
 *
 * A client that does NOT report a served model is not wrong — it is simply
 * silent, and the resolved intent stands. The contract is opt-in and
 * additive: `result.served_model` is an extra key on the generate result,
 * never a replacement for `reasoning` / `cost_usd`.
 */
export const SERVED_MODEL_KEY = 'served_model';

/**
 * Read the model a judge client reported as having served the call.
 *
 * @param {*} result — the generate() result.
 * @returns {string|null} the served model id, or null when the client did
 *          not report one (or reported a blank one).
 */
export function readServedModel(result) {
  if (!result || typeof result !== 'object') return null;
  const served = result[SERVED_MODEL_KEY];
  if (typeof served !== 'string') return null;
  const trimmed = served.trim();
  return trimmed || null;
}

/**
 * The model that SERVED a set of judge scores, when the scores report one.
 *
 * A judge client's report is authoritative — it knows what it did on the
 * wire. The scores are consulted in order, so the caller passes the score
 * that backs the record's primary verdict first.
 *
 * @param {Object} [opts]
 * @param {Array} [opts.scores] — score objects carrying `served_model`.
 * @param {string|null} [opts.fallback] — the intended model, used when no
 *        score reported a served model.
 * @returns {string|null}
 */
export function resolveServedJudgeModel({ scores = [], fallback = null } = {}) {
  for (const score of scores) {
    const served = readServedModel(score);
    if (served) return served;
  }
  return fallback;
}

/**
 * The model a judge client says it WILL serve for a given call.
 *
 * A judge client MAY implement `resolveServedModel(genOpts)` to answer this
 * question BEFORE the call is made — which is what the PRM cache key needs,
 * because the key must be computed before any score exists. A client that
 * does not implement it is not wrong: it is silent, and the caller falls
 * back to the intended model.
 *
 * This is the pre-call half of the served-model contract; `served_model` on
 * the generate result is the post-call half. When both are available they
 * agree, and the post-call report is the one the record trusts.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.client] — the judge client.
 * @param {Object} [opts.genOpts] — the generate options the call will carry.
 * @param {string|null} [opts.fallback] — the intended model, used when the
 *        client cannot say what it will serve.
 * @returns {string|null}
 */
export function resolveClientServedModel({ client = null, genOpts = {}, fallback = null } = {}) {
  if (!client || typeof client.resolveServedModel !== 'function') return fallback;
  let resolved;
  try {
    resolved = client.resolveServedModel(genOpts);
  } catch {
    // A client that cannot answer must not break the call path.
    return fallback;
  }
  if (typeof resolved !== 'string') return fallback;
  const trimmed = resolved.trim();
  return trimmed || fallback;
}

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
 * The model that will ACTUALLY serve a judge call.
 *
 * `options.prm.model` is the documented per-call judge model override. It
 * travels into the generate options (`src/prm.js`: `genOpts.model =
 * prmConfig.model`) and the clients that HONOUR `opts.model` serve the
 * override instead of their own default — so for those clients the override
 * really does decide which model serves the score.
 *
 * NOT every client honours it. A client is free to ignore `opts.model`, and
 * one that does would serve its OWN model while this helper reported the
 * override — the record would then name a model that did not serve
 * (kanban t_49d955b7). This helper therefore resolves the INTENDED model;
 * the SERVED model, when a client reports one, wins over it (see
 * `readServedModel` and `src/prm.js`).
 *
 * This is the ONE place the effective judge model is resolved, so the score
 * (`src/prm.js`) and the pair record's judge tags (`src/index.js`) cannot
 * disagree about which model produced the verdict (kanban t_dc053dc2).
 *
 * Before this helper the two sides resolved it DIFFERENTLY: `prm.js` always
 * preferred the override, while `index.js` preferred it only when a
 * `judgeClient` was configured. In the no-`judgeClient` branch — AWARE's
 * production default — the override changed the serving model while the
 * record named the producer's model, so `prm_score_judge_model` was a false
 * statement and the independence verdict was computed against the wrong
 * model.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.prmConfig] — the per-call PRM config (`options.prm`).
 * @param {Object} [opts.judgeRoute] — the resolved judge route (see
 *        `resolveJudgeClient`), whose `model` is the serving client's model.
 * @returns {string|null} the effective judge model id, or null when unknown.
 */
export function resolveEffectiveJudgeModel({ prmConfig = null, judgeRoute = null } = {}) {
  const override = prmConfig && typeof prmConfig.model === 'string'
    ? prmConfig.model.trim()
    : '';
  if (override) return override;
  const routeModel = judgeRoute && typeof judgeRoute.model === 'string'
    ? judgeRoute.model.trim()
    : '';
  return routeModel || null;
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
