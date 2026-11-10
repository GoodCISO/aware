// AWARE 2.0 coordinator service — entry point
// Per ADR (internal) Decision 1: persistent coordinator session + lightweight task workers
// Per ADR (internal) Decision 3: 3-tier model fallback (provider → Ollama)
//
// rl-pipeline is a sibling repo. The dev layout imports it via a relative
// path. The Docker image layout (see Dockerfile.coordinator) puts rl-pipeline
// at ./rl-pipeline/, so we resolve the import dynamically based on the
// AWARE_RL_PIPELINE_PATH env var, falling back to the dev layout.

import { awareRlPipeline } from './rl-pipeline-bridge-integration.js';
import { makeModelRouter, makeOllamaHealth } from './model-router.js';
import { makeLoraReloader } from './lora-reloader.js';
import { resolveKFromPluginConfig, validatePluginConfig, K_PLUGIN_CONFIG_VERSION } from './plugin-config.js';
import config from '../config/index.cjs';

export const COORDINATOR_VERSION = '0.3.0-phase-1-pluginconfig';
export const COORDINATOR_BUILD_PHASE = 'phase-1-passthrough';

export { resolveKFromPluginConfig, validatePluginConfig, K_PLUGIN_CONFIG_VERSION } from './plugin-config.js';

/**
 * Resolve the filesystem path to the rl-pipeline package.
 *
 * Resolution order:
 *   1. `opts.rlPipelinePath` (explicit injection; used by tests)
 *   2. `config.rlPipeline.path` (reads process.env.AWARE_RL_PIPELINE_PATH,
 *      falls back to the dev layout)
 *
 * The config module owns the env-var lookup so the coordinator doesn't
 * have to know the env-var name. Tests that want to override set
 * `opts.rlPipelinePath` directly.
 */
function resolveRlPipelinePath(opts = {}) {
  if (opts.rlPipelinePath) return opts.rlPipelinePath;
  return config.rlPipeline.path;
}

/**
 * Backwards-compatible `coordinate()` wrapper.
 *
 * Phase 1: defaults to a stub client. Callers wanting real model routing
 * should use `buildDefaultRouter()` and pass its `generate` as the client.
 *
 * Phase 1 passthrough: `pluginConfig` is the per-call plugin-local
 * config (parsed `plugins.entries.<id>.config` object, e.g. from the
 * rl-pipeline-bridge OC shim's `api.pluginConfig`). When present, the
 * coordinator uses it to resolve K (priority: explicit `K` >
 * `pluginConfig.agentDefaults.K` when enabled > `pluginConfig.defaultK`
 * > `defaultKForTaskType(task_type)`). The validated pluginConfig is
 * also passed through to `awareRlPipeline` for downstream use and is
 * echoed in the result envelope for audit.
 *
 * @param {Object} options
 * @param {string} options.problem
 * @param {string} [options.task_type='standard']
 * @param {Object} [options.context]
 * @param {number} [options.K]
 * @param {Object} [options.client] — rl_pipeline-compatible client
 * @param {string} [options.sessionId]
 * @param {string} [options.agentId]
 * @param {string} [options.pairsDir] — override AWARE_PAIRS_DIR for this call
 * @param {Object} [options.pluginConfig] — per-plugin config (ADR (internal)
 *   plugin-local config surface). Shape: `{ defaultK?: number,
 *   autoEnable?: boolean, agentDefaults?: { enabled?: boolean, K?: number } }`.
 *   Unknown keys are stripped (strict validation). A bad shape is
 *   silently treated as "no pluginConfig" so a misbehaving caller
 *   doesn't break the request path; the validation is logged on the
 *   envelope for observability.
 * @param {string} [options.system_prompt] — MR-HIGH-002 fix: when present,
 *   the system prompt is forwarded to rl_pipeline as a separate role
 *   instead of being concatenated into the user message. This is the
 *   architectural fix for the prompt-injection structural ambiguity.
 *   If absent, derived from `task_type` via TASK_GUIDANCE (preserves the
 *   legacy behavior of having system guidance in the prompt at all).
 */
export async function coordinate({ problem, task_type, context, K, client, sessionId, agentId, pairsDir, pluginConfig, system_prompt }) {
  // MR-HIGH-001 / MR-HIGH-002: Input-side prompt-injection defense.
  // The user-supplied `problem` is forwarded to the model. With MR-HIGH-002
  // fixed architecturally (system-prompt isolation), the rule-based filter
  // here is defense-in-depth: a belt-and-suspenders measure for attacks
  // that try to alter `problem` itself (rather than impersonate the system).
  if (typeof problem === 'string' && detectPromptInjection(problem)) {
    const err = new Error('problem rejected by injection filter');
    err.code = 'invalid_input';
    err.category = 'prompt_injection_suspected';
    err.pattern = 'rule_based_v1';
    throw err;
  }

  // Validate the pluginConfig shape (silent on failure — we don't want
  // a misconfigured caller to break the coordinator's request path).
  // The validator returns { ok, value, errors? }; `value` is the
  // sanitized object (unknown keys stripped) or null on failure.
  const pcValidation = validatePluginConfig(pluginConfig);

  // Resolve K through the priority order. When pluginConfig is invalid
  // we fall through to the per-task-type default (i.e., behave as if
  // pluginConfig were absent).
  const resolvedK = resolveKFromPluginConfig({
    explicitK: K,
    pluginConfig: pcValidation.value,
    taskType: task_type || 'standard',
  });

  // MR-HIGH-002 fix: derive system_prompt from task_type if caller didn't
  // provide one. This ensures the rl-pipeline-side receives an explicit
  // system_prompt and uses { system, user } isolation — without changing
  // the behavior for legacy callers (same wording, just architecturally
  // separated from the user input).
  const effectiveSystemPrompt = system_prompt || TASK_GUIDANCE[task_type || 'standard'] || TASK_GUIDANCE.standard;

  return await awareRlPipeline({
    problem,
    task_type: task_type || 'standard',
    context: { ...context, sessionId, agentId },
    K: resolvedK.K,
    client,
    pairsDir: pairsDir || config.coordinator.pairsDir,
    pluginConfig: pcValidation.value,
    pluginConfigValidation: pcValidation,
    system_prompt: effectiveSystemPrompt,
  });
}

// MR-HIGH-001: rule-based prompt-injection detection. Conservative —
// matches a small set of high-confidence patterns. False positives are
// possible; the caller can inspect `category: 'prompt_injection_suspected'`
// to decide whether to retry with sanitized input.
//
// TIGHTENED 2026-07-15 (Issue 4, t_76b69066): patterns were over-flagging
// ordinary business narrative. Four rules now require injection-shaped
// CONTEXT (not just a bare keyword) so that:
//   - "DAN LOWES MEETING" / "Dan Lowes" no longer trips the DAN rule
//   - "you are now expected to..." no longer trips the role-play rule
//   - "ignore previous instructions from the prior standup" no longer trips
//     when used in business-narrative framing
//   - "system prompt: please ensure..." no longer trips when "system prompt"
//     is being *referenced*, not *set* (now requires assignment-shaped follow-up)
// The `act as (?:a|an|the)` rule is intentionally UNCHANGED: dropping `the`
// would create a privilege-escalation false-negative (real "act as the
// admin" injections). Operator decision 1b on t_76b69066.
const PROMPT_INJECTION_PATTERNS = [
  // "ignore previous instructions" — require imperative framing with output verb
  /\bignore (?:all )?previous (?:instructions|prompts|rules)\b[^.\n]{0,40}(?:and|to)\b/i,
  // "disregard prior instructions" — same imperative framing
  /\bdisregard (?:all )?(?:prior|previous|above) (?:instructions|prompts|rules)\b[^.\n]{0,40}(?:and|to)\b/i,
  // "you are now" — require role/identity assignment (a/an/the/my/in)
  /\byou are now (?:a|an|the|my|in)\b/i,
  // "forget everything" — unchanged, rare in business text
  /\bforget everything\b/i,
  // "act as" — UNCHANGED. Keep `the` to catch "act as the admin" injections.
  /\bact as (?:a|an|the)\b/i,
  // "pretend to be/you are" — unchanged
  /\bpretend (?:to be|you are)\b/i,
  // "jailbreak" — unchanged, rare in business text
  /\bjailbreak\b/i,
  // "DAN" — require DAN-style jailbreak context (DAN mode / DAN jailbreak),
  // not bare DAN token (which matches names like "Dan Lowes")
  /\bDAN\b[^.\n]{0,30}\b(?:mode|jailbreak|prompt|unrestricted|unlock)\b/i,
  // "system prompt" — require assignment colon followed by imperative,
  // not a reference phrase like "system prompt: please ensure..."
  /\bsystem\s*prompt\s*[:=]\s*(?:ignore|disregard|forget|override|you are)\b/i,
  // ChatML token smuggling — unchanged (high-confidence signal)
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
];

function detectPromptInjection(text) {
  if (typeof text !== 'string' || text.length > 100_000) return false;
  for (const re of PROMPT_INJECTION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// MR-HIGH-002 fix: TASK_GUIDANCE mirrors the same map in
// rl-pipeline/src/parallel.js. AWARE uses this to derive system_prompt
// from task_type when the caller doesn't pass one explicitly. The wording
// MUST stay in sync with rl-pipeline's map; if you change one, change the
// other. Tested by test/unit/coordinator/system-prompt-isolation.test.js.
export const TASK_GUIDANCE = {
  simple: 'You are a careful, concise problem-solver. Aim for the most direct correct answer.',
  standard: 'You are a thorough, careful problem-solver. Consider multiple angles. Show your reasoning.',
  security: 'You are a security-focused expert. Identify threats, attack vectors, and mitigations. Be exhaustive.',
  financial: 'You are a financial/audit expert. Show calculations, cite constraints, flag risks explicitly.',
  creative: 'You are a creative thinker. Explore non-obvious approaches. Prefer novel solutions to conventional ones.',
};

/**
 * Build the default AWARE 2.0 model router.
 *
 * The router is constructed lazily so tests and offline development don't
 * require a live model. Callers can pass their own router via `router` to
 * override the default.
 *
 * @param {Object} [opts]
 * @param {string} [opts.mode='hybrid'] — 'online' | 'hybrid' | 'offline'
 * @param {Object} [opts.providerClient] — pre-built provider client (defaults to env-driven makeProviderClient from rl-pipeline)
 * @param {Object} [opts.ollamaClient] — pre-built Ollama client (defaults to a stub when not running)
 * @param {string} [opts.ollamaUrl='http://127.0.0.1:11434'] — Ollama base URL
 * @returns {Object} router
 */
export async function buildDefaultRouter(opts = {}) {
  const rlPipelinePath = resolveRlPipelinePath(opts);
  const rlPipelineMod = await import(rlPipelinePath);
  // The sibling library exports `makeMinimaxClient` (its public API name);
  // AWARE references it as `makeProviderClient` on the public-facing surface.
  const makeProviderClient = rlPipelineMod.makeProviderClient || rlPipelineMod.makeMinimaxClient;

  const mode = opts.mode || config.model.mode;
  const ollamaUrl = opts.ollamaUrl || config.model.ollamaUrl;

  // Online: provider (or whatever's passed in)
  let provider;
  if (opts.providerClient) {
    provider = opts.providerClient;
  } else if (config.model.providerApiKey) {
    provider = {
      name: 'provider',
      generate: async (prompt, genOpts) => {
        // 2026-11-10 (scribe): pass the operator-configured model through.
        // rl-pipeline's makeMinimaxClient already honours options.model;
        // previously AWARE called it with no arguments, so the model was
        // pinned to the library's DEFAULT_MODEL ('MiniMax-M3') and could
        // only be changed by republishing the dependency.
        const client = makeProviderClient({ model: config.model.providerModel });
        return await client.generate(prompt, genOpts);
      },
    };
  } else {
    // No API key — provide a stub that fails loudly so the router knows
    // to fall back (in hybrid/offline mode) or to error (in online mode).
    provider = {
      name: 'provider',
      generate: async () => {
        throw new Error('provider API client: LLM_API_KEY is not set; cannot generate');
      },
    };
  }

  // Offline: Ollama (always present, even in online mode it's just unused)
  // The Ollama client wraps the Ollama HTTP API.
  const ollama = opts.ollamaClient || buildDefaultOllamaClient(ollamaUrl, opts.ollamaTimeoutMs);

  return makeModelRouter({
    clients: [provider, ollama],
    mode,
    // 2026-11-10 (scribe): expose the provider model on the router object.
    // rl-pipeline reads `client.model` when it builds the PRM cache key
    // (rl-pipeline/src/index.js: `prm_model: client?.model || ...`). The
    // router was previously returned without a `model` property, so that
    // read was always undefined and every cache row was labelled
    // 'primary-model' — which is why all 515,320 rows in aware_prm_cache
    // carry that label regardless of the model that actually scored them.
    model: config.model.providerModel,
  });
}

/**
 * Build a minimal Ollama client (the /api/generate endpoint).
 * Uses Node's built-in fetch (Node 18+).
 */
function buildDefaultOllamaClient(baseUrl, timeoutMs) {
  return {
    name: 'ollama',
    offline: true,
    healthy: makeOllamaHealth({ baseUrl }),
    async generate(prompt, opts = {}) {
      // Default model: the AWARE-tuned qwen3.5-9b that lives in Ollama as
      // `aware-qwen35-9b:latest` (Q4_K_M, AWARE-LoRA merged at create time).
      // Override via opts.model for tests or alternate surfaces.
      //
      // t_aa407e5e (architect, 2026-07-12) moved us off the generic qwen2.5:7b
      // baseline: same Ollama daemon hosts the AWARE-flavored model, and the
      // downstream coordinator pair-generator expects `reasoning` to come back
      // without a "Thinking Process:" preamble. The `think: false` body field
      // (added 2026-07-12) is what suppresses that preamble for qwen3.5 in
      // Ollama 0.31.x — `num_think` / Modelfile PARAMETER think don't work.
      const model = opts.model || 'aware-qwen35-9b:latest';
      // Timeout: config.model.ollamaTimeoutMs (AWARE_OLLAMA_TIMEOUT_MS),
      // overridable per-call via opts.timeout_ms.
      //
      // History: this was hardcoded to 5_000ms to fail fast on a stuck
      // Ollama inference. Measured against Qwen3.5-9B on Apple Silicon
      // that was too tight for a solution-generation prompt (4.1-4.8s),
      // so roughly half of all requests aborted and the router fell
      // through to the provider backend. The fail-fast intent is kept by
      // the coordinator's own AWARE_REQUEST_TIMEOUT_MS bound; this
      // per-generation timeout only needs to be generous enough for a
      // real generation to finish.
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          // Suppress qwen3.5 chain-of-thought preamble (per-request, not Modelfile).
          // Ollama 0.31.x: this boolean toggles thinking-mode for qwen3.5.
          think: opts.think === undefined ? false : opts.think,
        }),
        signal: AbortSignal.timeout(opts.timeout_ms || timeoutMs || config.model.ollamaTimeoutMs),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
      }
      const data = await res.json();
      return {
        reasoning: data.response || '',
        cost_usd: 0,  // local inference
      };
    },
  };
}

export { makeModelRouter, makeOllamaHealth, buildDefaultOllamaClient };
export { makeLoraReloader, resolveActiveTarget, shouldReload, buildModelfile, postOllamaCreate } from './lora-reloader.js';
export { awareRlPipeline } from './rl-pipeline-bridge-integration.js';

// APTS-MR-019 (T1 GAP from ADR-049 §5): credential classifier re-export.
// The actual tool-output interception lives in src/policies/tool-observation-proxy.js
// — every tool-output payload crosses that proxy on its way back to the
// coordinator / model, and the proxy invokes the classifier before
// returning the result. Re-exporting from the coordinator surfaces the
// classifier as a first-class MR-domain API (per ADR-049 §3, MR is
// mapped to src/coordinator/index.js) and lets tests / callers
// import it from a single canonical location.
export {
  classify,
  redact,
  buildDecisionRecord,
  CLASSIFIER_VERSION,
} from '../policies/credential-classifier.js';

// ADR-051 — OWASP MCP Top 10 (2025) protocol adapter entry point.
//
// The MCP wire-protocol parser (`src/coordinator/adapters/mcp.js`) does
// not own a network transport — it parses JSON-RPC 2.0 envelopes that
// AWARE observes in front of any MCP client/server. Per ADR-040 the
// adapter is fail-open: parse errors and audit-write failures are
// logged to stderr and never propagated to the caller, so a busted
// adapter cannot break the originating MCP traffic flow.
//
// `observeMcpMessage(envelope, actor)` is the single coordinator-shell
// entry point. The MCP adapter is lazy-required on first call so a
// missing adapter module does not break coordinator require-time. The
// adapter's own MCPAdapter class is re-exported for tests and for the
// downstream classifier card (separate kanban) that will read
// `mcp_message` source events and emit MCP0N:2025 annotations.
import { createRequire as _createRequire } from 'node:module';
const _require = _createRequire(import.meta.url);
let _mcpAdapterModule = null;
function _loadMcpAdapter() {
  if (_mcpAdapterModule) return _mcpAdapterModule;
  _mcpAdapterModule = _require('./adapters/mcp.js');
  return _mcpAdapterModule;
}

/**
 * Parse + emit a single MCP JSON-RPC envelope (or batched array of
 * envelopes — see JSON-RPC 2.0 §6). Per ADR-040 fail-open: returns
 * `{ ok, error? }` and never throws.
 *
 * @param {Object|Array} envelope
 * @param {Object} actor  { agentId, trustScore?, role? }
 * @returns {Promise<{ok: boolean, error?: Error}>}
 */
export async function observeMcpMessage(envelope, actor) {
  try {
    const mod = _loadMcpAdapter();
    const adapter = new mod.MCPAdapter();
    const result = await adapter.emitMessage(envelope, actor);
    return { ok: result.ok, error: result.error };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[coordinator/observeMcpMessage] adapter failed: ${err.code || err.message}`);
    return { ok: false, error: err };
  }
}

/**
 * Lazily expose the MCPAdapter class for tests + downstream wiring.
 * Returns the class without instantiating it. Use this in preference
 * to importing mcp.js directly when going through the coordinator
 * shell is appropriate.
 *
 * @returns {Function}
 */
export function getMCPAdapter() {
  const mod = _loadMcpAdapter();
  return mod.MCPAdapter;
}
