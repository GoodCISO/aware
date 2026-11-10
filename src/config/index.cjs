// AWARE 2.0 — centralized configuration
//
// Single source of truth for every v2 env var the AWARE stack reads.
// Reads are LAZY (every property access re-reads process.env) so:
//   - Tests can override env between requests without import-cache gymnastics
//   - The gateway's per-request COORDINATOR_URL pattern keeps working
//   - The kill-switch toggle takes effect immediately (already a requirement)
//
// Validation runs at access time on the things that can fail loudly at boot
// (numeric parsing, mode enum, secret presence for online mode). Soft
// warnings (e.g. OLLAMA_URL when mode=offline) are surfaced via a sidecar
// `validation` snapshot — see snapshot() below.
//
// Out of scope:
//   - v1 code (src/server.js, src/api/*, src/audit/*, src/routing/*, src/ui/*)
//     stays on its own ad-hoc process.env reads; v1.0.0 is shipped and live.
//   - v1-style layered config (YAML file < env) — that's the Centralized Configuration ADR (internal) territory.
//
// Public API:
//   import config from './config/index.cjs';         // ESM consumers (coordinator)
//   const config = require('./config/index.cjs');    // CJS consumers (gateway, tests)
//   config.gateway.host            // '0.0.0.0' (or process.env.GATEWAY_HOST)
//   config.model.providerApiKey    // process.env.LLM_API_KEY (string | undefined)
//   config.model.providerHost      // process.env.LLM_API_HOST (string | undefined)
//   config.model.mode              // 'online' | 'hybrid' | 'offline'
//   config.ollama.url              // 'http://127.0.0.1:11434'
//   config.snapshot()              // redacted JSON for logging
//   config.validate()              // throws on hard failures
//   config.warnings()              // string[] of soft warnings

const path = require('node:path');
const os = require('node:os');

// --- helpers ------------------------------------------------------------

function str(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

function num(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `Config: ${name}=${JSON.stringify(raw)} is not a finite number`
    );
  }
  if (n < min || n > max) {
    throw new Error(
      `Config: ${name}=${n} is out of range [${min}, ${max}]`
    );
  }
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

function enumOf(name, allowed, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (!allowed.includes(v)) {
    throw new Error(
      `Config: ${name}=${JSON.stringify(v)} is not one of [${allowed.join(', ')}]`
    );
  }
  return v;
}

const SECRET_NAMES = new Set(['providerApiKey', 'password', 'modalTokenId', 'modalTokenSecret']);

function redact(name, value) {
  if (SECRET_NAMES.has(name)) {
    if (value === undefined || value === null || value === '') return '<unset>';
    return `<redacted length=${String(value.length)}>`;
  }
  return value;
}

// --- dev-layout fallback path for rl-pipeline ---------------------------

function defaultRlPipelinePath() {
  // src/config/index.js → ../../../rl-pipeline/src/index.js
  // The AWARE repo lives at [REDACTED-PATH] and rl-pipeline is
  // a sibling at [REDACTED-PATH] From this file:
  //   src/config/index.js → ../  → src
  //                          ../../  → AWARE repo root
  //                          ../../../  → [REDACTED-PATH] (parent of both repos)
  //                          ../../../rl-pipeline/src/index.js
  // __filename is the CJS path to this file.
  const here = path.dirname(__filename);
  return path.resolve(here, '..', '..', '..', 'rl-pipeline', 'src', 'index.js');
}

// --- the config object (lazy via getters) -------------------------------

const config = {
  // Coordinator HTTP service
  coordinator: {
    get port() { return num('COORDINATOR_PORT', 8080, { min: 0, max: 65535 }); },
    get host() { return str('COORDINATOR_HOST', '127.0.0.1'); },
    get requestTimeoutMs() { return num('AWARE_REQUEST_TIMEOUT_MS', 120_000, { min: 1000, max: 600_000 }); },
    get requestCostCapUsd() { return num('AWARE_REQUEST_COST_CAP_USD', 1.0, { min: 0, max: 1000 }); },
    get killSwitch() { return bool('AWARE_KILL_SWITCH', false); },
    // Phase 4 (the AWARE 2.0 Architecture ADR (internal) 618-627) LoRA weight-reload hook (decision
    // Y: HTTP/Ollama adapter reload). The coordinator watches
    // `${weightsDir}/active` and re-POSTs to Ollama's /api/create
    // when the symlink target changes. Operators can disable the
    // reloader entirely by setting AWARE_LORA_RELOADER_ENABLED=0
    // (useful for test environments where the symlink doesn't
    // exist). The poll interval defaults to 5s — fast enough that
    // a swap is picked up within ~pollIntervalMs, slow enough to
    // not hammer Ollama.
    get loraReloaderEnabled() { return bool('AWARE_LORA_RELOADER_ENABLED', true); },
    get loraReloaderPollIntervalMs() { return num('AWARE_LORA_RELOADER_POLL_INTERVAL_MS', 5_000, { min: 100, max: 600_000 }); },
    get loraReloaderTimeoutMs() { return num('AWARE_LORA_RELOADER_TIMEOUT_MS', 30_000, { min: 1_000, max: 600_000 }); },
    get loraReloaderModelName() { return str('AWARE_LORA_RELOADER_MODEL_NAME', 'trained-model'); },
    // Phase 2.4 (the AWARE 2.0 Architecture ADR (internal) 618-627) preference-pair output directory.
    // Default = $HOME/.<runtime>/redacted-internal-project/preference-pairs so the path is
    // always writable (homedir is /home/aware inside the container, the
    // test cwd in unit tests). Operator override AWARE_PAIRS_DIR=/data/awareness-pairs
    // (the path the compose file bind-mounts the host preference-pairs
    // dir to). The default home-relative path is intentionally NOT the
    // path the compose file mounts the host dir to, so that a host bind
    // mount to a non-image-baked path can be used without shadowing.
    get pairsDir() { return str('AWARE_PAIRS_DIR', path.join(os.homedir(), '.<runtime>', 'redacted-internal-project', 'preference-pairs')); },
    // SEC-002: Bearer token
    // required for /coordinate + /budget/status. Fails-closed at boot
    // when NODE_ENV=production if unset or shorter than 32 chars.
    // Test runs opt out by setting AWARE_COORDINATOR_AUTH_DISABLED=1
    // (the test bootstrap does this in test/unit/coordinator/http-server.test.js).
    // Reads AWARE_COORDINATOR_TOKEN; falls through to undefined if unset
    // so validate() can decide based on NODE_ENV.
    get authToken() { return str('AWARE_COORDINATOR_TOKEN', undefined); },
    // SEC-MOD-001: per-principal rate limiting on /coordinate.
    // Token bucket with sliding window — keeps an in-memory record of
    // recent request timestamps keyed by token (or by client IP when
    // auth is disabled). Defaults: 60 requests / 60s per principal.
    // Operators tune via env vars. Tests can opt out via
    // AWARE_COORDINATOR_RATE_LIMIT_DISABLED=1.
    get rateLimitMax() { return num('AWARE_COORDINATOR_RATE_LIMIT_MAX', 60, { min: 1, max: 100_000 }); },
    get rateLimitWindowMs() { return num('AWARE_COORDINATOR_RATE_LIMIT_WINDOW_MS', 60_000, { min: 1_000, max: 3_600_000 }); },
    get rateLimitDisabled() { return bool('AWARE_COORDINATOR_RATE_LIMIT_DISABLED', false); },
  },

  // Gateway HTTP service
  gateway: {
    get port() { return num('GATEWAY_PORT', 18080, { min: 0, max: 65535 }); },
    get host() { return str('GATEWAY_HOST', '0.0.0.0'); },
    get proxyTimeoutMs() { return num('GATEWAY_PROXY_TIMEOUT_MS', 120_000, { min: 1000, max: 600_000 }); },
    get coordinatorUrl() { return str('COORDINATOR_URL', 'http://coordinator:8080'); },
    get killSwitch() { return bool('AWARE_GATEWAY_KILL_SWITCH', false); },
  },

  // Model layer
  model: {
    get mode() { return enumOf('AWARE_MODE', ['online', 'hybrid', 'offline'], 'hybrid'); },
    get providerApiKey() { return str('LLM_API_KEY', undefined); },
    get providerHost() { return str('LLM_API_HOST', undefined); },
    // Provider model name. 2026-11-10 (scribe): the model was previously
    // hard-coded to 'MiniMax-M3' inside the pinned rl-pipeline dependency
    // (src/clients/minimax.js DEFAULT_MODEL), so it could not be changed
    // without republishing that library. rl-pipeline's makeMinimaxClient
    // already honours options.model, so the only gap was that AWARE
    // called makeProviderClient() with no arguments. This env var closes
    // that gap and makes the model an operator setting.
    // MiniMax-M3.1-Flash is the current default: it is the fastest tier
    // and the cheapest per call, and the PRM judge is only ranking
    // attempts — not producing them.
    get providerModel() { return str('AWARE_PROVIDER_MODEL', 'MiniMax-M3.1-Flash'); },
    get ollamaUrl() { return str('OLLAMA_URL', 'http://127.0.0.1:11434'); },
    // Timeout for a single Ollama generation request.
    // The previous hardcoded 5_000ms default was a coin-flip against
    // Qwen3.5-9B on Apple Silicon: measured 4.1-4.8s for a solution
    // generation, so roughly half of all requests aborted mid-flight
    // and the router fell through to the (unauthenticated) provider.
    // 60s gives real headroom; the coordinator's own request timeout
    // (AWARE_REQUEST_TIMEOUT_MS) still bounds the overall call.
    get ollamaTimeoutMs() { return num('AWARE_OLLAMA_TIMEOUT_MS', 60_000, { min: 1000, max: 600_000 }); },
  },

  // rl-pipeline (sibling repo) — path is computed but not validated here;
  // resolution is left to the coordinator so we can return a clean error
  // from the request handler if the file is missing.
  rlPipeline: {
    get path() { return str('AWARE_RL_PIPELINE_PATH', defaultRlPipelinePath()); },
  },

  // Postgres (Phase 2.1 conversation logger)
  // `enabled=false` makes the logger a no-op; useful for offline dev.
  // `password` is in SECRET_NAMES so it's redacted in snapshot().
  db: {
    get host() { return str('AWARE_DB_HOST', '127.0.0.1'); },
    get port() { return num('AWARE_DB_PORT', 5432, { min: 1, max: 65535 }); },
    get database() { return str('AWARE_DB_DATABASE', 'aware2'); },
    get user() { return str('AWARE_DB_USER', 'aware'); },
    get password() { return str('AWARE_POSTGRES_PASSWORD', undefined); },
    get enabled() { return bool('AWARE_DB_ENABLED', true); },
    get connectionTimeoutMs() { return num('AWARE_DB_CONNECTION_TIMEOUT_MS', 2000, { min: 100, max: 30_000 }); },
  },

  // PRM score cache (Phase 2.2)
  // Architecture decision P (content-hash key) + X (env-var kill switch).
  // When enabled=false the cache is a no-op and every /coordinate call
  // hits the live PRM judge. When enabled=true (default), the cache
  // short-circuits the LLM call for repeated {problem, reasoning, ...} inputs.
  prmCache: {
    get enabled() { return bool('AWARE_PRM_CACHE_ENABLED', true); },
    get ttlDays() { return num('AWARE_PRM_CACHE_TTL_DAYS', 30, { min: 1, max: 3650 }); },
    get table() { return str('AWARE_PRM_CACHE_TABLE', 'aware_prm_cache'); },
  },

  // Budget watchdog (Phase 2.3)
  // Architecture decisions: A1 (Postgres aggregate on aware_conversations),
  // B3 (tiered soft@softLimitUsd / hard@hardLimitUsd), C2 (rolling windowDays).
  // No secrets in this namespace; the watchdog is read-only.
  budget: {
    get enabled() { return bool('AWARE_BUDGET_ENABLED', true); },
    get windowDays() { return num('AWARE_BUDGET_WINDOW_DAYS', 30, { min: 1, max: 365 }); },
    get softLimitUsd() { return num('AWARE_BUDGET_SOFT_LIMIT_USD', 80.0, { min: 0, max: 1_000_000 }); },
    get hardLimitUsd() { return num('AWARE_BUDGET_HARD_LIMIT_USD', 100.0, { min: 0, max: 1_000_000 }); },
  },

  // Trainer (Phase 3 — AZR self-play on Modal).
  // Architecture decision: B (env-var kill switch), X (token from
  // canonical credential store, never in repo).
  // The `enabled` flag is the AWARE_TRAINER_ENABLED kill switch; when
  // false the trainer is a no-op (the bring-up script's
  // `--profile training` exercises it).
  trainer: {
    get enabled() { return bool('AWARE_TRAINER_ENABLED', false); },
    get pollIntervalSec() { return num('AWARE_TRAINER_POLL_INTERVAL_SEC', 300, { min: 10, max: 86400 }); },
    get minPairsPerRun() { return num('AWARE_TRAINER_MIN_PAIRS_PER_RUN', 100, { min: 1, max: 1000000 }); },
    get configPath() { return str('AWARE_TRAINER_CONFIG', 'config/modal-training.json'); },
    // The default weights dir matches the compose file's override
    // (AWARE_TRAINER_WEIGHTS_DIR=/opt/aware/weights/active), and the
    // dir is pre-created + chown'd in Dockerfile.coordinator's
    // runtime stage so the trainer can atomic-symlink-swap without
    // hitting the non-root user's write-permission wall on /opt/.
    // See docs/audits/aware-2.0-trainer-env-audit-2026-06-13.md
    // MEDIUM-2.
    get weightsDir() { return str('AWARE_TRAINER_WEIGHTS_DIR', '/opt/aware/weights/active'); },
    get baseModel() { return str('AWARE_TRAINER_BASE_MODEL', 'Qwen/trained-model'); },
    get gpuType() { return str('AWARE_TRAINER_GPU_TYPE', 'A100-80GB'); },
    get jobTimeoutSec() { return num('AWARE_TRAINER_JOB_TIMEOUT_SEC', 18000, { min: 60, max: 86400 }); },
    // Phase 4 (the AWARE 2.0 Architecture ADR (internal) 618-627) outcome filter rule. The trainer
    // applies this to every preference pair before packaging it into
    // the DPO dataset. Default changed 2026-06-22 (the Trainer Re-enable Runbook ADR (internal) Repair 1)
    // from 'noop' to 'min_score_gap' to guard against PRM-inverted
    // pairs in production data. Operators can still opt back into
    // 'noop' explicitly via env var override. See
    // src/trainer/outcome-filter.js for the full rule set.
    get filterRule() { return str('AWARE_TRAINER_FILTER_RULE', 'min_score_gap'); },
    // Companion to filterRule='min_score_gap'. Drop records where
    // (chosen.prm_score - rejected.prm_score) < filterMinGap. Default
    // raised 2026-06-22 (the Trainer Re-enable Runbook ADR (internal) Repair 1) from 0.05 to 0.20 to be
    // stricter than rl-pipeline's toDpoDataset() default. The strict
    // default guards against low-confidence pairs that may be PRM
    // artifacts (see the Quality Gate Reality Check ADR (internal) §Finding 1 — PRM scoring is currently
    // inverted on hedging-vs-hallucination, so wide gaps may not
    // mean what they used to). Operators who want a more lenient
    // corpus can override via env var.
    get filterMinGap() { return num('AWARE_TRAINER_FILTER_MIN_GAP', 0.20, { min: 0, max: 1 }); },
    // Companion to filterRule='tag_match'. Allow-list of task_type
    // values to keep (comma-separated env var). Empty default =
    // "operator hasn't decided yet" → keep all (see outcome-filter.js).
    get filterAllowedTaskTypes() { return str('AWARE_TRAINER_FILTER_ALLOWED_TASK_TYPES', ''); },
    // Phase 4 (the AWARE 2.0 Architecture ADR (internal) 618-627) AZR self-play corpus path. When set,
    // the trainer records it on aware_training_runs.azr_corpus_path
    // and ingests per-record results into aware_azr_results at
    // run-completion time. Empty default = "--gen-azr-corpus not
    // enabled" → no AZR results → the azr_result filter rule has
    // no index to consult (lenient policy keeps all records).
    get azrCorpusPath() { return str('AWARE_TRAINER_AZR_CORPUS_PATH', ''); },
    // Modal auth — read from the canonical credential store
    // (redacted-credential-file) at runtime. NEVER in the repo.
    get modalTokenId() { return str('MODAL_TOKEN_ID', undefined); },
    get modalTokenSecret() { return str('MODAL_TOKEN_SECRET', undefined); },
  },
};

// --- validation ---------------------------------------------------------

/**
 * Validate the current config. Throws on hard failures. Returns the same
 * config object on success.
 *
 * Hard failures (boot-blocking):
 *   - mode=online without LLM_API_KEY
 *   - any numeric / enum parse error (already throws at access)
 *
 * Soft warnings (returned by warnings(), not thrown):
 *   - mode=offline without OLLAMA_URL reachable at startup is not checked
 *     here — that's a runtime check when the first request lands
 *   - rlPipeline path doesn't exist on disk is not checked here
 */
config.validate = function validate() {
  if (config.model.mode === 'online' && !config.model.providerApiKey) {
    throw new Error(
      'Config: AWARE_MODE=online requires LLM_API_KEY (set it via env_file or compose env)'
    );
  }
  if (config.gateway.port === config.coordinator.port) {
    throw new Error(
      `Config: GATEWAY_PORT (${config.gateway.port}) must differ from COORDINATOR_PORT (${config.coordinator.port})`
    );
  }
  // SEC-002: the coordinator
  // binds 127.0.0.1 by default (localhost-only) but is reachable through
  // the gateway which binds 0.0.0.0. With no auth on /coordinate, anyone
  // reaching the gateway could drive the primary LLM provider API costs and inject prompts.
  // Fail-closed at boot when running in production: AWARE_COORDINATOR_TOKEN
  // must be set and at least 32 chars. Tests opt out by setting
  // AWARE_COORDINATOR_AUTH_DISABLED=1 (the coordinator http-server.js
  // module-level check skips the env-read in that case).
  const authDisabled = (process.env.AWARE_COORDINATOR_AUTH_DISABLED === '1');
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !authDisabled) {
    const tok = config.coordinator.authToken;
    if (!tok || typeof tok !== 'string' || tok.length < 32) {
      throw new Error(
        'Config: AWARE_COORDINATOR_TOKEN is required and must be ≥32 chars when NODE_ENV=production (SEC-002; production hardening). Set it in the env_file / compose service env, or run with NODE_ENV≠production (development only).'
      );
    }
  }
  // Force-evaluate all lazy accessors so a bad value fails at validate(),
  // not at first request.
  void config.coordinator.requestTimeoutMs;
  void config.coordinator.requestCostCapUsd;
  void config.coordinator.loraReloaderPollIntervalMs;
  void config.coordinator.loraReloaderTimeoutMs;
  void config.coordinator.authToken;
  void config.gateway.proxyTimeoutMs;
  void config.budget.windowDays;
  void config.budget.softLimitUsd;
  void config.budget.hardLimitUsd;
  void config.trainer.pollIntervalSec;
  void config.trainer.minPairsPerRun;
  void config.trainer.jobTimeoutSec;
  return config;
};

/**
 * Soft warnings (do not block boot).
 */
config.warnings = function warnings() {
  const out = [];
  if (config.model.mode === 'offline' && !config.ollamaUrl) {
    out.push('AWARE_MODE=offline but OLLAMA_URL is not set — fallback will be unavailable');
  }
  if (!config.model.providerApiKey && config.model.mode !== 'offline') {
    // Not a hard fail (we have a stub client) but worth flagging.
    out.push('LLM_API_KEY is not set — primary tier will fail and fall through to Ollama');
  }
  return out;
};

/**
 * Return a redacted JSON-serializable snapshot of the current config.
 * Use this for /version logging, debug endpoints, and `npm run config:show`.
 */
config.snapshot = function snapshot() {
  const c = config;
  return {
    coordinator: {
      port: c.coordinator.port,
      host: c.coordinator.host,
      requestTimeoutMs: c.coordinator.requestTimeoutMs,
      requestCostCapUsd: c.coordinator.requestCostCapUsd,
      killSwitch: c.coordinator.killSwitch,
      loraReloaderEnabled: c.coordinator.loraReloaderEnabled,
      loraReloaderPollIntervalMs: c.coordinator.loraReloaderPollIntervalMs,
      loraReloaderTimeoutMs: c.coordinator.loraReloaderTimeoutMs,
      loraReloaderModelName: c.coordinator.loraReloaderModelName,
      pairsDir: c.coordinator.pairsDir,
      // SEC-002: redacted in
      // snapshot — only show presence + length, never the value.
      authTokenSet: Boolean(c.coordinator.authToken),
      authTokenLength: c.coordinator.authToken ? c.coordinator.authToken.length : 0,
    },
    gateway: {
      port: c.gateway.port,
      host: c.gateway.host,
      proxyTimeoutMs: c.gateway.proxyTimeoutMs,
      coordinatorUrl: c.gateway.coordinatorUrl,
      killSwitch: c.gateway.killSwitch,
    },
    model: {
      mode: c.model.mode,
      providerApiKey: redact('providerApiKey', c.model.providerApiKey),
      providerHost: c.model.providerHost,
      providerModel: c.model.providerModel,
      ollamaUrl: c.model.ollamaUrl,
      ollamaTimeoutMs: c.model.ollamaTimeoutMs,
    },
    rlPipeline: {
      path: c.rlPipeline.path,
    },
    db: {
      host: c.db.host,
      port: c.db.port,
      database: c.db.database,
      user: c.db.user,
      password: redact('password', c.db.password),
      enabled: c.db.enabled,
      connectionTimeoutMs: c.db.connectionTimeoutMs,
    },
    prmCache: {
      enabled: c.prmCache.enabled,
      ttlDays: c.prmCache.ttlDays,
      table: c.prmCache.table,
    },
    budget: {
      enabled: c.budget.enabled,
      windowDays: c.budget.windowDays,
      softLimitUsd: c.budget.softLimitUsd,
      hardLimitUsd: c.budget.hardLimitUsd,
    },
    trainer: {
      enabled: c.trainer.enabled,
      pollIntervalSec: c.trainer.pollIntervalSec,
      minPairsPerRun: c.trainer.minPairsPerRun,
      configPath: c.trainer.configPath,
      weightsDir: c.trainer.weightsDir,
      baseModel: c.trainer.baseModel,
      gpuType: c.trainer.gpuType,
      jobTimeoutSec: c.trainer.jobTimeoutSec,
      // Phase 4 (the AWARE 2.0 Architecture ADR (internal) 618-627) outcome filter knobs. Surfaced in
      // snapshot() so the operator can see the active filter
      // configuration via `npm run config:show` without grepping env.
      filterRule: c.trainer.filterRule,
      filterMinGap: c.trainer.filterMinGap,
      filterAllowedTaskTypes: c.trainer.filterAllowedTaskTypes,
      azrCorpusPath: c.trainer.azrCorpusPath,
      modalTokenId: redact('modalTokenId', c.trainer.modalTokenId),
      modalTokenSecret: redact('modalTokenSecret', c.trainer.modalTokenSecret),
    },
    warnings: c.warnings(),
  };
};

module.exports = config;
module.exports.default = config;
