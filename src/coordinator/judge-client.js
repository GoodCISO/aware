// src/coordinator/judge-client.js — build the INDEPENDENT judge client
// (kanban t_89720a07).
//
// WHY THIS EXISTS
// ---------------
// Audit t_8f049433 (§3.1, §5.1) measured that AWARE had NO mechanism by
// which a judge could be independent of the candidate: the same client
// served producer and judge, the documented judge model override did not
// exist, and the only alternative backend was the AWARE-trained LoRA
// artefact — the model the preference pairs train.
//
// The rule being honoured is
// `measurement-experimentation-ops/references/04-ai-product-evaluation.md`
// (:157-160): "If judge and candidate share a model family, the judge is
// grading its own house style... Run it again with an independent judge
// before it gates anything."
//
// WHAT THIS BUILDS
// ----------------
// A judge client from the operator's judge settings:
//
//   AWARE_JUDGE_MODEL          — the judge model id (required to enable a judge)
//   AWARE_JUDGE_API_KEY        — the judge's credential (falls back to LLM_API_KEY)
//   AWARE_JUDGE_API_HOST       — the judge's endpoint
//   AWARE_JUDGE_OLLAMA_MODEL   — an Ollama-hosted judge model
//
// The judge is a DIRECT client, not a router: a router would fall back to
// the producer's backend, and a silent fallback to the candidate's family
// reintroduces exactly the defect this card exists to remove. The judge
// therefore fails CLOSED — see `src/coordinator/model-router.js`.
//
// Returns `null` when no judge is configured, which the pipeline reads as
// "no judge client": the producer's client is the judge and the pair record
// says so.

import config from '../config/index.cjs';

/**
 * Build the independent judge client, or `null` when no judge is configured.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.providerClient] — the producer's provider client, used
 *        only to reuse the provider's endpoint shape when the judge has no
 *        explicit host of its own.
 * @param {Function} [opts.makeProviderClient] — factory for an Anthropic-compatible
 *        client. Defaults to rl-pipeline's `makeMinimaxClient`.
 * @param {string}  [opts.ollamaUrl] — the Ollama base URL for an Ollama judge.
 * @returns {Promise<Object|null>} the judge client, or null when unconfigured.
 */
export async function buildDefaultJudgeClient(opts = {}) {
  const judgeModel = (opts.judgeModel ?? config.model.judgeModel ?? '').trim();
  const judgeOllamaModel = (opts.judgeOllamaModel ?? config.model.judgeOllamaModel ?? '').trim();

  // An Ollama-hosted judge. The model id is carried on the client so the
  // pair record names the serving model.
  if (judgeOllamaModel) {
    return {
      name: 'judge-ollama',
      model: judgeOllamaModel,
      offline: true,
      async generate(prompt, genOpts = {}) {
        const baseUrl = opts.ollamaUrl || config.model.ollamaUrl;
        const res = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: judgeOllamaModel,
            prompt,
            stream: false,
            think: genOpts.think === undefined ? false : genOpts.think,
          }),
          signal: AbortSignal.timeout(genOpts.timeout_ms || config.model.ollamaTimeoutMs),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Judge Ollama API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
        }
        const data = await res.json();
        return { reasoning: data.response || '', cost_usd: 0 };
      },
    };
  }

  // A provider-hosted judge. No judge model means NO judge client: the
  // producer's client is the judge (same-family by construction) and the
  // pair record records that fact.
  if (!judgeModel) return null;

  const makeProviderClient = opts.makeProviderClient || (await resolveProviderClientFactory(opts));
  if (typeof makeProviderClient !== 'function') return null;

  const apiKey = opts.judgeApiKey ?? config.model.judgeApiKey ?? config.model.providerApiKey;
  const baseUrl = opts.judgeApiHost ?? config.model.judgeApiHost;

  // The client is built ONCE and reused: constructing it per call would
  // re-read the key and defeat the credential separation.
  const client = makeProviderClient({
    model: judgeModel,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });
  return {
    name: 'judge',
    model: judgeModel,
    // The judge must NEVER be routed to the producer's backend. A router
    // here would reintroduce the same-family fallback this card removes.
    async generate(prompt, genOpts = {}) {
      return await client.generate(prompt, genOpts);
    },
  };
}

/**
 * Resolve rl-pipeline's Anthropic-compatible client factory. The library
 * is loaded lazily from `config.rlPipeline.path` — the same resolution the
 * coordinator uses for the producer's client.
 */
async function resolveProviderClientFactory(opts = {}) {
  if (opts.rlPipelinePath) {
    const mod = await import(opts.rlPipelinePath);
    return mod.makeProviderClient || mod.makeMinimaxClient;
  }
  const mod = await import(config.rlPipeline.path);
  return mod.makeProviderClient || mod.makeMinimaxClient;
}

export default buildDefaultJudgeClient;
