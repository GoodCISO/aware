// AWARE 2.0 coordinator service — HTTP API
// Per ADR (internal) Decision 1: persistent coordinator session + lightweight task workers
// Per ADR (internal) Decision 3: 3-tier model fallback (provider → Ollama)
// Per ADR (internal) Decision 4: T0-T4 enforcement (timeout, retry, cost-cap, fallback, kill-switch)
//
// This module is the *service surface* for the coordinator. It exposes:
//   - POST /coordinate  → run rl-pipeline on a problem, return selected answer
//   - GET  /health      → router health snapshot (200 healthy, 503 degraded)
//   - GET  /version     → coordinator version + build phase
//
// It uses Node's built-in `http` module — no Express — so the surface stays
// small and the deployable artifact is just `node src/coordinator/http-server.js`.
//
// T0-T4 enforcement (this layer):
//   - T0 timeout:    per-request wall-clock cap (env AWARE_REQUEST_TIMEOUT_MS, default 120_000)
//   - T2 cost-cap:   per-request USD cap (env AWARE_REQUEST_COST_CAP_USD, default 1.00)
//   - T4 kill-switch: global env AWARE_KILL_SWITCH=1 returns 503 immediately
// T3 fallback lives in the router. T1 retry is handled by rl-pipeline itself.

import http from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { coordinate, buildDefaultRouter, COORDINATOR_VERSION, COORDINATOR_BUILD_PHASE } from './index.js';
import config from '../config/index.cjs';
import { logConversationFireAndCodert } from '../db/logger.js';
import { runMigrations } from '../db/index.js';
import { checkBudget, getBudgetStatus, isEnabled as isBudgetEnabled } from '../budget/watchdog.js';
import { makeLoraReloader } from './lora-reloader.js';
import { createRequire } from 'node:module';

// C-step finding #16 (AR-HIGH-001 partial — v2 surface): the hash-chained
// decision logger is the canonical compliance audit trail. Without a
// write hook here, the audit HTTP API on the gateway would surface an
// empty chain.
//
// decision-logger.js is CJS and `src/coordinator/http-server.js` is ESM,
// so we bridge via `createRequire` rather than `await import()` — the
// latter puts the CJS module.exports under `.default` and would force
// an awkward destructure. `createRequire` is the canonical Node ESM↔CJS
// bridge and lets us treat the audit module like a normal dependency.
//
// The module is loaded lazily so the coordinator can still boot in
// unit tests without /data/audit present (the logger opens a file on load).
const _decisionLoggerRequire = createRequire(import.meta.url);
function getDecisionLogger() {
  return _decisionLoggerRequire('../audit/decision-logger.js');
}

async function logDecisionFireAndCodert(decision) {
  let logDecision;
  try {
    ({ logDecision } = getDecisionLogger());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[aware-coordinator] decision-logger unavailable, audit chain disabled:', err.message);
    return;
  }
  try {
    await logDecision(decision);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[aware-coordinator] logDecision failed (best-effort):', err.message);
  }
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — coordinator inputs are prompts, not file uploads

// SEC-002: Bearer-token auth
// on /coordinate + /budget/status. The coordinator binds 127.0.0.1 by
// default but is reachable through the gateway (which binds 0.0.0.0).
// Without auth, anyone reaching the gateway could drive the primary LLM provider API
// costs + inject prompts + read budget status.
//
// Auth-disabled opt-out is for tests + development only. config.validate()
// already enforces the token in NODE_ENV=production. The runtime check
// here also short-circuits when AWARE_COORDINATOR_AUTH_DISABLED=*** is set.
//
// IMPORTANT: lazy getter (not const) because Node caches ESM module
// top-level — a const capture would be pinned to whatever the env was at
// first import. Tests need to flip this between calls without re-importing.
function isAuthDisabled() {
  return (process.env.AWARE_COORDINATOR_AUTH_DISABLED === '1');
}

// Public routes that don't need auth (liveness probes must work for
// orchestrators / load balancers).
const PUBLIC_ROUTES = new Set(['GET /health', 'GET /version']);

// Constant-time token compare. Returns true iff the request carries
// Authorization: Bearer <expected> matching config.coordinator.authToken.
// Returns false on every other shape (no header, wrong scheme, wrong token).
function isAuthorizedCoordinatorRequest(req) {
  if (isAuthDisabled()) return true;
  const expected = config.coordinator.authToken;
  if (!expected || typeof expected !== 'string') return false;
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const presented = m[1];
  // timingSafeEqual requires equal-length buffers; pad to expected.length
  // so a wrong-length token takes the same time as a right-length one.
  const a = Buffer.from(presented.padEnd(expected.length, '\0'), 'utf8');
  const b = Buffer.from(expected.padEnd(presented.length, '\0'), 'utf8');
  // Length-equalize by comparing against the expected-length form of `presented`
  // and the expected-length form of `expected`. If lengths differ, fall
  // through to a length check + still do a constant-time-ish compare.
  if (presented.length !== expected.length) {
    // Force the same number of compares either way to avoid leaking length
    // via early-return timing.
    const pad = Buffer.alloc(Math.max(presented.length, expected.length));
    timingSafeEqual(pad, pad);
    return false;
  }
  return timingSafeEqual(a, b);
}

// T0-T4 limits live in the centralized config module (src/config/index.js).
// Lazy getters re-read env on each access so toggling AWARE_KILL_SWITCH
// or AWARE_REQUEST_TIMEOUT_MS at runtime does not require a restart.
// Validate at boot so bad env values fail fast, not on first request.
config.validate();

// Phase 2.1: run Postgres migrations on boot. Best-effort — if the DB is
// unreachable, log a warning to stderr and continue. The logger itself is
// a no-op when AWARE_DB_ENABLED=false.
if (config.db.enabled) {
  runMigrations().then((r) => {
    if (!r.ran && r.reason !== 'already-run') {
      // eslint-disable-next-line no-console
      console.warn(`[aware-coordinator] db migrations did not run: ${r.reason}${r.error ? ` (${r.error})` : ''}`);
    }
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[aware-coordinator] db migrations threw:', err.message);
  });
}

function isKilled() {
  return config.coordinator.killSwitch;
}

// UUID v4 canonical form: 8-4-4-4-12 hex chars, version nibble = 4,
// variant nibble = 8/9/a/b. Accepting only UUID v4 from client-supplied
// x-request-id headers means attackers cannot smuggle newlines, escape
// codes, or terminal-control bytes through the log-correlation channel.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuidV4(s) {
  return typeof s === 'string' && UUID_V4_RE.test(s);
}

// SC-MOD-001 : per-principal
// sliding-window rate limiting on /coordinate. Keyed by the
// authenticated token (a SHA-256 hex of the token bytes, not the raw
// token, so logs stay safe) when auth is enabled; falls back to the
// client IP when auth is disabled (test/local-dev). In-memory store
// is bounded: at most MAX_BUCKETS principals tracked, oldest entries
// are evicted on overflow so an attacker can't blow up memory by
// spraying unique tokens.
const RATE_LIMIT_MAX_BUCKETS = 10_000;
const _rateLimitBuckets = new Map(); // key → array of timestamps (ms)

function _rateLimitPrune() {
  // Evict oldest entries if we're over the cap. O(N) walk but only
  // triggered on overflow, and 10k entries is cheap.
  if (_rateLimitBuckets.size <= RATE_LIMIT_MAX_BUCKETS) return;
  const overflow = _rateLimitBuckets.size - RATE_LIMIT_MAX_BUCKETS;
  const keys = _rateLimitBuckets.keys();
  for (let i = 0; i < overflow; i++) {
    const k = keys.next().value;
    if (k === undefined) break;
    _rateLimitBuckets.delete(k);
  }
}

function _rateLimitKey(req) {
  // Prefer token fingerprint when auth is enabled. We hash the raw
  // bearer token (if present and valid) to avoid storing the raw
  // secret in process memory any longer than necessary.
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const tok = auth.slice(7).trim();
    if (tok.length > 0) {
      // Stable, collision-resistant key without exposing the raw token.
      // v2.5.4: use the imported createHash (ESM), not require() (CJS).
      // The previous require() worked under CJS-loaded http-server.js but
      // the runtime is ESM (package.json type=module), so require is
      // undefined and the call path crashed when auth was enabled.
      return 'tok:' + createHash('sha256').update(tok).digest('hex').slice(0, 16);
    }
  }
  // Fall back to client IP.
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  return 'ip:' + ip;
}

/**
 * SC-MOD-001 rate-limit check. Returns { allowed, remaining, resetMs }
 * where:
 *   - allowed: true if this request fits inside the window
 *   - remaining: number of requests left in the current window
 *   - resetMs: ms until the oldest timestamp in the window expires
 * The bucket is updated (oldest expiry shifted) on every call so the
 * sliding-window behavior is correct.
 */
function checkRateLimit(req) {
  if (config.coordinator.rateLimitDisabled) {
    return { allowed: true, remaining: Infinity, resetMs: 0 };
  }
  const max = config.coordinator.rateLimitMax;
  const windowMs = config.coordinator.rateLimitWindowMs;
  const key = _rateLimitKey(req);
  const now = Date.now();
  const cutoff = now - windowMs;
  let timestamps = _rateLimitBuckets.get(key) || [];
  // Drop expired entries from the front of the list. The list is
  // small (bounded by `max`) so this is O(max) worst case.
  let drop = 0;
  while (drop < timestamps.length && timestamps[drop] <= cutoff) drop++;
  if (drop > 0) timestamps = timestamps.slice(drop);
  if (timestamps.length >= max) {
    _rateLimitBuckets.set(key, timestamps);
    const oldest = timestamps[0];
    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.max(0, oldest + windowMs - now),
    };
  }
  timestamps.push(now);
  _rateLimitBuckets.set(key, timestamps);
  _rateLimitPrune();
  const oldest = timestamps[0];
  return {
    allowed: true,
    remaining: max - timestamps.length,
    resetMs: Math.max(0, oldest + windowMs - now),
  };
}

// Test-only helper: reset the rate-limit store between tests. Not
// exported from the module's public surface.
function _resetRateLimitBucketsForTests() {
  _rateLimitBuckets.clear();
}

/**
 * Read the full request body as a UTF-8 string, up to MAX_BODY_BYTES.
 * Rejects with a 413 if the body exceeds the cap.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Send a JSON response. `status` defaults to 200.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Send a plain-text response. Used for 404s.
 */
function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * Run the HTTP server. Resolves with a `close()` function that gracefully
 * shuts the server down. The server is bound to `opts.host`:`opts.port`.
 *
 * @param {Object} [opts]
 * @param {number} [opts.port=8080]
 * @param {string} [opts.host='127.0.0.1']
 * @param {Object} [opts.router] — pre-built router (defaults to buildDefaultRouter())
 * @param {Function} [opts.coordinateFn] — override the coordinate function (used in tests)
 * @param {boolean} [opts.disableLoraReloader=false] — skip wiring the
 *   lora-reloader on startup. Used by tests so the reloader's poll
 *   interval doesn't keep the test process alive.
 * @returns {Promise<{server: http.Server, port: number, host: string, close: () => Promise<void>, loraReloader: object|null}>}
 */
export async function startServer(opts = {}) {
  const host = opts.host ?? config.coordinator.host;
  // `opts.port === 0` is a valid request (OS picks a free port) — use ??
  // not || so the fallback doesn't kick in for the zero value.
  const port = opts.port ?? config.coordinator.port;
  const router = opts.router || (await buildDefaultRouter(opts.routerOpts || {}));
  const coordinateFn = opts.coordinateFn || coordinate;

  const server = http.createServer(async (req, res) => {
    // Per-request id for log correlation.
    // SC-HIGH-002 : accept client-supplied
    // x-request-id ONLY if it parses as a UUID v4 — otherwise generate
    // a fresh one. Prevents log poisoning via header injection (e.g.
    // '\n[FAKE] admin action' landing in aware_conversations.request_id
    // and structured log lines).
    const headerId = req.headers['x-request-id'];
    const requestId = isValidUuidV4(headerId) ? headerId : randomUUID();
    res.setHeader('x-request-id', requestId);
    try {
      // SEC-002: auth gate.
      // Public routes (/health, /version) skip the check so orchestrators
      // can probe liveness. /coordinate + /budget/status require
      // `Authorization: Bearer <AWARE_COORDINATOR_TOKEN>` matching
      // config.coordinator.authToken (constant-time compare).
      const routeKey = `${req.method} ${req.url}`;
      if (!PUBLIC_ROUTES.has(routeKey) && !isAuthorizedCoordinatorRequest(req)) {
        // Generic 401 — don't leak whether the token was malformed,
        // missing, or wrong. Body shape matches the existing
        // error envelope (request_id for log correlation).
        return sendJson(res, 401, {
          error: 'unauthorized',
          kind: 'auth',
          request_id: requestId,
        });
      }
      // SC-MOD-001: rate limit /coordinate only (skip /health,
      // /version, /budget/status — those are cheap liveness/introspection
      // probes that orchestrators may poll). Keyed by token-fingerprint
      // (auth on) or client IP (auth off, e.g. local-dev). Standard
      // X-RateLimit-* headers surface the budget for callers that care.
      if (req.method === 'POST' && req.url === '/coordinate') {
        const rl = checkRateLimit(req);
        res.setHeader('X-RateLimit-Limit', String(config.coordinator.rateLimitMax));
        res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(rl.resetMs / 1000)));
        if (!rl.allowed) {
          res.setHeader('Retry-After', String(Math.ceil(rl.resetMs / 1000)));
          return sendJson(res, 429, {
            error: 'rate limit exceeded',
            kind: 'rate_limited',
            limit: config.coordinator.rateLimitMax,
            window_ms: config.coordinator.rateLimitWindowMs,
            retry_after_ms: rl.resetMs,
            request_id: requestId,
          });
        }
      }
      // Routing
      if (req.method === 'GET' && req.url === '/health') {
        return handleHealth(req, res, router, requestId);
      }
      if (req.method === 'GET' && req.url === '/version') {
        return sendJson(res, 200, {
          version: COORDINATOR_VERSION,
          build_phase: COORDINATOR_BUILD_PHASE,
          kill_switch: isKilled(),
          request_id: requestId,
        });
      }
      if (req.method === 'GET' && req.url === '/budget/status') {
        return await handleBudgetStatus(req, res, requestId);
      }
      if (req.method === 'POST' && req.url === '/coordinate') {
        return await handleCoordinate(req, res, router, coordinateFn, requestId);
      }
      return sendJson(res, 404, { error: 'not found', kind: 'request', request_id: requestId });
    } catch (err) {
      // Internal error envelope
      const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
      const body = {
        error: err.message || 'internal error',
        kind: status === 500 ? 'internal' : 'request',
        request_id: requestId,
      };
      return sendJson(res, status, body);
    }
  });

  // v2026-07-12 fix raised serverTimeout from 0 (Node default) to 35s. The
  // HTTP server previously had no socket-level timeout, so a request that
  // hung downstream (e.g. Ollama inference stuck at GPU) would keep the
  // socket open forever, exhausting the server's max-open-sockets and
  // producing `kind=unreachable` floods at the gateway plugin layer.
  //
  // 2026-07-13 bump (kanban t_588d8b89): 35s -> 60s. Default-mode (K=4,
  // standard) /coordinate calls measure ~29.4s end-to-end with tail
  // variance that occasionally crossed the 35s ceiling and was closed at
  // the socket, surfacing as `kind=unreachable`. 60s = outer hook
  // timeout (30000ms) + inner fetch budget (28000ms) + ~2s of socket-
  // idle tail, with comfortable headroom for the p99 of the slow path.
  // Anything beyond that is a genuinely hung request we want to abort at
  // the socket.
  //
  // Note: must be set as a property on the server instance, not via the
  // createServer options object — verified 2026-07-12 that the options
  // variant is silently ignored (server.timeout stays 0).
  server.timeout = 60_000;

  // Listen on the requested port; resolve when ready.
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  // Bug #15 (2026-06-13): the lora-reloader module was previously
  // exported from coordinator/index.js but never invoked from the
  // server's startup path. The reloader is the thing that watches
  // the trainer's active-weights symlink and tells Ollama to
  // /api/create with the new adapter. Without it, a successful
  // training run never produces an inference-usable LoRA on the
  // gateway.
  //
  // Wire it up here, gated on config.coordinator.loraReloaderEnabled
  // (default true). The reloader's start() begins polling on a
  // timer; the close() returned below stops it on shutdown.
  //
  // Tests can opt out via `opts.disableLoraReloader` (the
  // reloader would otherwise keep the test process alive on its
  // 5-second poll interval). The OLLAMA_URL-missing case below
  // is the dev-env fallback for when the reloader is wanted but
  // the env var isn't set.
  //
  // Note: this fix only wires the reloader into the coordinator
  // process. Bug #14 (the trainer's symlink swap targets a Modal
  // Volume path the host can't see) is a separate, architectural
  // issue and is documented in redacted-internal-doc. With bug #14 still open,
  // the reloader will poll forever and never see a target change —
  // which is the correct, safe behavior: the gateway stays on the
  // base model instead of serving a broken LoRA. Once #14 is
  // fixed, this wiring becomes the load-bearing piece that
  // actually delivers a trained LoRA to the gateway.
  const loraReloaderEnabled = config.coordinator.loraReloaderEnabled;
  let loraReloader = null;
  if (loraReloaderEnabled && !opts.disableLoraReloader) {
    // The actual opt-out is AWARE_LORA_RELOADER_ENABLED=false.
    // config.model.ollamaUrl always falls back to a default via
    // str() so we don't need a defensive empty-URL guard here.
    const ollamaUrl = config.model?.ollamaUrl;
    loraReloader = makeLoraReloader({
      weightsDir: config.trainer.weightsDir,
      ollamaUrl,
      modelName: config.coordinator.loraReloaderModelName,
      baseModel: config.trainer.baseModel,
      pollIntervalMs: config.coordinator.loraReloaderPollIntervalMs,
      reloadTimeoutMs: config.coordinator.loraReloaderTimeoutMs,
      logger: {
        info: (...a) => console.log('[aware-coordinator:lora]', ...a),
        warn: (...a) => console.warn('[aware-coordinator:lora]', ...a),
        error: (...a) => console.error('[aware-coordinator:lora]', ...a),
        debug: () => {},
      },
    });
    loraReloader.start();
  }

  const actualPort = server.address().port;

  const close = async () => {
    // F-003: stop the reloader BEFORE closing the server. The
    // previous version ran loraReloader.stop() fire-and-forget and
    // server.close() synchronously, which could leave a half-
    // completed Ollama POST in flight when the process tears down.
    if (loraReloader) {
      try {
        await loraReloader.stop();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[aware-coordinator] lora-reloader.stop() failed during close: ${e?.message || e}`);
      }
      loraReloader = null;
    }
    return await new Promise((resolve) => server.close(() => resolve()));
  };

  return { server, port: actualPort, host, close, loraReloader };
}

/**
 * GET /budget/status — read-only budget watchdog status.
 *
 * Returns the current rolling-window spend, the configured soft/hard
 * limits, the tier (ok | soft | hard), and the projected reset time.
 * Read-only; never mutates anything.
 */
async function handleBudgetStatus(req, res, requestId) {
  let status;
  try {
    status = await getBudgetStatus();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[aware-coordinator] getBudgetStatus threw:', err.message);
    return sendJson(res, 500, {
      error: 'budget status query failed',
      kind: 'internal',
      request_id: requestId,
    });
  }
  return sendJson(res, 200, { ...status, request_id: requestId });
}

/**
 * GET /health — router health snapshot.
 * - 200 if at least one backend is healthy (or if the router has no health probes)
 * - 503 if all backends are unhealthy
 * - 500 if the router itself throws (degraded but server stays up)
 */
async function handleHealth(req, res, router, requestId) {
  let snapshot;
  try {
    snapshot = await router.health();
  } catch (err) {
    return sendJson(res, 500, {
      status: 'degraded',
      error: err.message || 'router health() threw',
      kind: 'internal',
      request_id: requestId,
    });
  }
  // The router's health() returns { mode, ok, at, clients: { [name]: { ok, cached, at } } }.
  // The legacy `backends` field is also accepted for back-compat.
  const entries = snapshot.clients || snapshot.backends || {};
  const backends = Object.entries(entries).map(([name, info]) => ({
    name,
    healthy: !!info.ok,
    cached: !!info.cached,
    checked_at: info.at || snapshot.at || new Date().toISOString(),
  }));
  const allDown = backends.length > 0 && backends.every((b) => !b.healthy);
  const status = allDown ? 503 : 200;
  return sendJson(res, status, {
    status: allDown ? 'down' : 'ok',
    mode: snapshot.mode,
    backends,
    kill_switch: isKilled(),
    checked_at: snapshot.at || new Date().toISOString(),
    request_id: requestId,
  });
}

/**
 * POST /coordinate — run rl-pipeline on a problem.
 *
 * Request body: { problem: string, task_type?: string, K?: number, context?: object, sessionId?: string, agentId?: string, timeout_ms?: number, cost_cap_usd?: number }
 *
 * Response shape (success):  200 with the coordinate() result envelope
 * Response shape (failure):  400 / 402 / 503 / 504 / 500 with the error envelope
 *
 * The coordinator returns `{ok: false, error: {type, message}}` on failure (does not throw).
 * We map `error.type` to HTTP status:
 *   - 'invalid_input'         → 400
 *   - 'upstream_rate_limited' → 503 (NEW: 429 after retries exhausted — t_22a34f6d)
 *   - 'upstream_error'        → 503 (the upstream model API failed non-429)
 *   - 'internal_error'        → 500
 * A thrown error is treated as 500 unless the message matches a known pattern.
 *
 * T0-T4 enforcement:
 *   - T4 kill-switch: 503 immediately, no work done
 *   - T0 timeout:    Promise.race against REQUEST_TIMEOUT_MS (or body.timeout_ms); 504 on timeout
 *   - T2 cost-cap:   per-request USD ceiling (default REQUEST_COST_CAP_USD); 402 on overrun
 */
async function handleCoordinate(req, res, router, coordinateFn, requestId) {
  const startMs = Date.now();
  const log = (extra) => logConversationFireAndCodert({
    requestId,
    problem: extra && extra.problem,
    taskType: extra && extra.taskType,
    k: extra && extra.k,
    sessionId: extra && extra.sessionId,
    agentId: extra && extra.agentId,
    result: extra && extra.result,
    durationMs: Date.now() - startMs,
    errorKind: extra && extra.errorKind,
    errorMessage: extra && extra.errorMessage,
  });

  if (isKilled()) {
    log({ errorKind: 'killed', errorMessage: 'kill-switch is engaged' });
    return sendJson(res, 503, {
      error: 'kill-switch is engaged (AWARE_KILL_SWITCH=1)',
      kind: 'killed',
      request_id: requestId,
    });
  }

  // Phase 2.3 — Budget watchdog: read rolling-window spend BEFORE
  // doing work. Hard tier → 402. Soft tier → proceed + warn header.
  // On watchdog failure: log + fail-open (tier=ok). Never break the path.
  let budget;
  try {
    budget = await checkBudget();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[aware-coordinator] checkBudget threw, failing open:', err.message);
    budget = { ok: true, tier: 'ok', spendUsd: 0 };
  }
  res.setHeader('x-budget-tier', budget.tier);
  if (budget.tier === 'hard') {
    log({ errorKind: 'budget_exhausted', errorMessage: `rolling-window spend $${budget.spendUsd} >= hard limit $${budget.hardLimitUsd}` });
    return sendJson(res, 402, {
      error: 'budget exhausted — rolling-window spend has reached the hard limit',
      kind: 'budget_exhausted',
      spend_usd: budget.spendUsd,
      soft_limit_usd: budget.softLimitUsd,
      hard_limit_usd: budget.hardLimitUsd,
      window_days: budget.windowDays,
      resets_at: budget.resetsAt,
      request_id: requestId,
    });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    log({ errorKind: 'request', errorMessage: err.message });
    return sendJson(res, err.statusCode || 400, { error: err.message, kind: 'request', request_id: requestId });
  }

  let body;
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw);
  } catch (err) {
    log({ errorKind: 'request', errorMessage: 'invalid JSON in request body' });
    return sendJson(res, 400, { error: 'invalid JSON in request body', kind: 'request', request_id: requestId });
  }

  if (typeof body.problem !== 'string' || body.problem.length === 0) {
    log({ problem: body.problem, errorKind: 'request', errorMessage: '`problem` is required and must be a non-empty string' });
    return sendJson(res, 400, {
      error: '`problem` is required and must be a non-empty string',
      kind: 'request',
      request_id: requestId,
    });
  }
  if (body.problem.length > 100_000) {
    log({ problem: body.problem, errorKind: 'request', errorMessage: '`problem` exceeds 100,000 chars' });
    return sendJson(res, 413, { error: '`problem` exceeds 100,000 chars', kind: 'request', request_id: requestId });
  }

  // Per-request T0/T2 limits (defaults from env)
  const timeoutMs = clampMs(body.timeout_ms, config.coordinator.requestTimeoutMs, 100, 600_000);
  const costCapUsd = clampNumber(body.cost_cap_usd, config.coordinator.requestCostCapUsd, 0, 1000);

  // Phase 1 passthrough (ADR (internal)): `pluginConfig` is the per-call
  // plugin-local config from the OC shim. It's a free-form object
  // — the coordinator validates it in `coordinate()` and uses it
  // for K resolution. Unknown keys are silently dropped; bad
  // shapes are logged on the envelope but don't break the call.
  const pluginConfig = body.pluginConfig;

  // T0: race the work against a wall-clock deadline
  let result;
  try {
    result = await raceWithTimeout(
      coordinateFn({
        problem: body.problem,
        task_type: body.task_type,
        K: body.K,
        context: { ...(body.context || {}), cost_cap_usd: costCapUsd },
        sessionId: body.sessionId,
        agentId: body.agentId,
        // The HTTP layer is the wiring point: the router lives at the
        // service surface, and we pass the router itself as the
        // rl-pipeline-compatible client. rl-pipeline expects a client
        // *object* with a `generate(prompt, opts)` method, and that's
        // exactly what `router` is. By passing the router here we get
        // the 3-tier fallback (the provider → Ollama) for free, and tests
        // can still override `coordinateFn` to bypass the router.
        client: router,
        // ADR (internal) pluginConfig passthrough. The coordinator validates
        // and uses this; we pass it through unchanged so the
        // validator is the single source of truth for the shape.
        pluginConfig,
      }),
      timeoutMs,
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      log({ problem: body.problem, taskType: body.task_type, k: body.K, sessionId: body.sessionId, agentId: body.agentId, errorKind: 'timeout', errorMessage: `request exceeded ${timeoutMs}ms timeout` });
      return sendJson(res, 504, {
        error: `request exceeded ${timeoutMs}ms timeout`,
        kind: 'timeout',
        request_id: requestId,
      });
    }
    const message = err && err.message ? err.message : 'coordinate failed';
    const isBackend = /all .* backends failed|no healthy backends|cannot generate/i.test(message);
    const kind = isBackend ? 'backend' : 'internal';
    log({ problem: body.problem, taskType: body.task_type, k: body.K, sessionId: body.sessionId, agentId: body.agentId, errorKind: kind, errorMessage: message });
    return sendJson(res, isBackend ? 503 : 500, { error: message, kind, request_id: requestId });
  }

  // T2: cost-cap check — coordinate() should have honored it via context.cost_cap_usd,
  // but if a backend doesn't report cost, the result envelope can't enforce it. We surface
  // a 402 if the result reports a cost_usd that exceeds the cap.
  if (result && result.cost_usd != null && Number(result.cost_usd) > costCapUsd) {
    log({ problem: body.problem, taskType: body.task_type, k: body.K, sessionId: body.sessionId, agentId: body.agentId, result, errorKind: 'cost_cap', errorMessage: `cost_usd ${result.cost_usd} exceeded cap ${costCapUsd}` });
    return sendJson(res, 402, {
      error: `cost_usd ${result.cost_usd} exceeded cap ${costCapUsd}`,
      kind: 'cost_cap',
      cost_usd: result.cost_usd,
      cost_cap_usd: costCapUsd,
      request_id: requestId,
    });
  }

  // Normal envelope path
  if (result && result.ok === false) {
    const errType = (result.error && result.error.type) || 'internal_error';
    const errMessage = (result.error && result.error.message) || 'coordinate failed';
    log({ problem: body.problem, taskType: body.task_type, k: body.K, sessionId: body.sessionId, agentId: body.agentId, result, errorKind: errType, errorMessage: errMessage });
    const status = errType === 'invalid_input' ? 400
                 : errType === 'upstream_rate_limited' ? 503
                 : errType === 'upstream_error' ? 503
                 : 500;
    return sendJson(res, status, { error: errMessage, kind: errType, request_id: requestId });
  }

  // Success path
  log({ problem: body.problem, taskType: body.task_type, k: body.K, sessionId: body.sessionId, agentId: body.agentId, result });

  // C-step finding #16: append to the hash-chained audit chain so the
  // gateway's audit HTTP API surfaces real decisions. Fire-and-forget
  // so the audit write never blocks the response. The chain record
  // captures the decision metadata (actor, action, outcome) but NOT the
  // full prompt text — the prompt is already in db/logger.js
  // (aware_conversations); the chain is the audit-trail summary.
  logDecisionFireAndCodert({
    decisionId: requestId,
    parentDecisionId: null,  // root of a chain per request; future cross-request linking is out of scope
    timestamp: new Date().toISOString(),
    actor: {
      agentId: body.agentId || 'unknown',
      trustScore: 1.0,
    },
    action: {
      type: 'coordinate',
      target: 'aware-coordinator',
      reason: task_type_reason(body.task_type),
    },
    context: {
      taskType: body.task_type || 'standard',
      K: body.K || null,
      sessionId: body.sessionId || null,
    },
    outcome: {
      success: !!(result && result.ok !== false),
      latencyMs: Date.now() - startMs,
      errorMessage: result && result.ok === false ? (result.error && result.error.message) || 'coordinate returned ok=false' : null,
      // Additive audit fields for upstream 429 retry visibility (t_22a34f6d).
      // The hash chain re-hashes the row so additive keys are safe; existing
      // readers ignore unknown keys. `retriesExhausted` only true when this
      // call surfaced a fresh `upstream_rate_limited` — earlier transient
      // 429s that recovered within the retry budget do NOT set it.
      retriedAttempts: (result && typeof result.retried_attempts_total === 'number') ? result.retried_attempts_total : 0,
      retriesExhausted: !!(result && result.ok === false && result.error && result.error.type === 'upstream_rate_limited'),
    },
  });

  return sendJson(res, 200, { ...(result || {}), request_id: requestId });
}

function task_type_reason(task_type) {
  switch (task_type) {
    case 'standard': return 'standard reasoning task';
    case 'compliance': return 'compliance reasoning task';
    case 'analysis': return 'analysis task';
    default: return `${task_type || 'standard'} reasoning task`;
  }
}

/**
 * Race a promise against a timeout. Rejects with a TimeoutError on expiry.
 * Does not cancel the underlying promise (Node fetch has its own AbortController,
 * but rl_pipeline doesn't expose one). The abandoned promise will still settle
 * and may emit a result — the caller is responsible for the resource lifetime.
 */
function raceWithTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(makeTimeoutError(ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function makeTimeoutError(ms) {
  const err = new Error(`timeout after ${ms}ms`);
  err.code = 'AWARE_TIMEOUT';
  return err;
}

function isTimeoutError(err) {
  return err && (err.code === 'AWARE_TIMEOUT' || /timeout/i.test(err.message || ''));
}

function clampMs(value, fallback, min, max) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, fallback, min, max) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Allow direct execution: `node src/coordinator/http-server.js`
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer()
    .then(({ port, host }) => {
      // eslint-disable-next-line no-console
      console.log(`[aware-coordinator] listening on http://${host}:${port} (${COORDINATOR_VERSION})`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[aware-coordinator] failed to start:', err);
      process.exit(1);
    });
}
