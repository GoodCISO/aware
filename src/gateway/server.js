// AWARE 2.0 gateway — thin BFF in front of the coordinator.
//
// Per ADR (internal) Phase 1, gateway extraction is option A: a thin HTTP proxy
// that adds the v1-style middleware (helmet, cors, rate-limit, raw body)
// in front of the coordinator, and a kill-switch that takes precedence
// over the coordinator's kill-switch (defense in depth).
//
// What this service does:
//   - Adds helmet, cors, express-rate-limit, raw-body middleware
//   - Adds a per-request X-Request-Id (or echoes the inbound one)
//   - Forwards /coordinate, /health, /version to the coordinator
//   - Exposes its own /version (gateway version, not coordinator version)
//   - Honors AWARE_GATEWAY_KILL_SWITCH=1 (returns 503 immediately, even
//     if the coordinator's kill-switch is off)
//
// What this service does NOT do:
//   - Auth / JWT (Phase 5 decision; matches v1's auth posture today)
//   - Local state (the coordinator is the model layer)
//   - Model fallback (the coordinator owns the 3-tier router)
//   - Persistent preferences / DPO / training (Phase 2+)
//
// The gateway is intentionally a small dependency footprint (express,
// helmet, cors, express-rate-limit) so its image can stay small and
// auditable. No http-proxy-middleware: the proxy is implemented with
// node:http directly, no third-party trust chain.
//
// In docker compose, the gateway sits behind `profiles: ["full"]` so
// the bring-up script's default 4-service stack works without it; the
// full 5-service stack runs with `--profile full`.
//
// --- Passthrough wrap (ADR (internal) §Plugin-Local Config + proxy contract) ---
//
// The previous version used `express.json` to consume every request body
// on the proxy path and then re-serialized the parsed object. That had
// three failure modes that ADR (internal) closes:
//
//   1. **Mangle**: re-serializing JSON loses key order, comments (if
//      the client sent a strict subset), and is lossy for non-JSON
//      content types (text/plain, application/octet-stream, multipart,
//      etc.). The upstream saw a body that was not byte-equivalent to
//      what the client sent.
//   2. **1 MiB cap**: `express.json({ limit: '1mb' })` rejected anything
//      larger with 413, even when the coordinator's own 100 KiB
//      `problem` cap and per-request cost cap would have allowed it.
//   3. **No streaming**: the body was always fully buffered before
//      forwarding, so streaming uploads were impossible.
//
// This version replaces the JSON parser with a path-scoped raw-body
// middleware (`express.raw({ type: () => true, limit: '10mb' })`) on
// the proxy path. The body is captured as a raw Buffer and forwarded
// to the upstream byte-for-byte — content-type, charset, encoding, and
// all bytes are preserved. For bodies > 10 MiB, the middleware returns
// 413 (with the gateway's standard error envelope) before the proxy
// fires; the limit is configurable via `AWARE_GATEWAY_MAX_BODY_BYTES`.

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const config = require('../config/index.cjs');

// C-step finding #16 (AR-HIGH-001 partial — v2 surface): the v2 gateway
// exposes the audit HTTP API on its public surface so an operator
// running v2 can query the hash-chained decision log, verify chain
// integrity, and export audit data — the same routes the v1 API
// mounts at /api/audit/* (src/api/index.js:264).
//
// The audit module is CJS; we lazy-require it so the gateway can boot
// even if /data/audit isn't mounted (offline dev mode) and so the
// require cost is paid only when an audit route is actually hit.
// `createRequire` from `node:module` is the canonical Node ESM↔CJS
// bridge for environments where the surrounding module is ESM.
const { createRequire } = require('node:module');
const _auditRequire = createRequire(__filename);
let _auditHandlers = null;
function getAuditHandlers() {
  if (!_auditHandlers) {
    _auditHandlers = _auditRequire('../api/routes/audit.js');
  }
  return _auditHandlers;
}

const GATEWAY_VERSION = '0.2.0-phase-1-passthrough';
const GATEWAY_BUILD_PHASE = 'phase-1-passthrough';

// --- Body-size limit ----------------------------------------------------
//
// The proxy path is the only place a request body can land. We keep the
// limit generous (10 MiB default) and configurable via env. This is the
// cap ADR (internal) specifies; the coordinator's own per-request caps
// (problem length, cost cap, request timeout) still apply downstream.
//
// The limit is re-read from the env on every access so tests and
// operators can change it without restarting the gateway. The
// `express.raw` middleware below captures the limit at module-load
// time (it can't be re-set on an existing middleware instance);
// for hot re-config, the gateway would need to be re-required.
// Tests that need a non-default limit set the env before require().
function getMaxBodyBytes() {
  const raw = process.env.AWARE_GATEWAY_MAX_BODY_BYTES;
  if (raw == null || raw === '') return 10 * 1024 * 1024; // 10 MiB
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 10 * 1024 * 1024;
  return Math.floor(n);
}

// All env reads live in src/config/index.js. We validate at boot so a
// bad value (e.g. non-numeric GATEWAY_PORT) fails fast here, not on
// the first request. The kill-switch, COORDINATOR_URL, etc. are
// re-read on every access (config getters are lazy) so toggling
// process.env at runtime still works — that's how the tests work,
// and how the gateway's per-request upstream switch could work.
config.validate();

function isKilled() {
  return config.gateway.killSwitch;
}

const app = express();

// --- Middleware: in the same order as the v1 server.js ------------------
app.disable('x-powered-by');
app.use(helmet());

// CORS posture (C-step finding #15, [date-redacted]).
//
// The previous `cors()` with no options defaulted to
// `Access-Control-Allow-Origin: *` — wildcard, which removed the
// browser-side defense for users who happen to be logged in. The
// v1 API (src/api/index.js:91) already uses an explicit allowlist;
// this brings the v2 gateway to the same posture.
//
// Allowed origins:
//   - `AWARE_GATEWAY_ALLOWED_ORIGINS` (comma-separated env var)
//   - `FRONTEND_URL` (single origin, for parity with v1)
//   - `http://localhost:3001` (development default)
//
// The allowlist is re-read on every access so tests and operators can
// change it without restarting the gateway. Like other env-driven
// config in this file, it falls back to a safe local-dev default
// when no env var is set.
function getAllowedOrigins() {
  const fromList = process.env.AWARE_GATEWAY_ALLOWED_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromList && fromList.length > 0) return fromList;
  const single = process.env.FRONTEND_URL?.trim();
  if (single) return [single];
  return ['http://localhost:3001'];
}

app.use(cors({
  origin: getAllowedOrigins(),
  credentials: true,
  optionsSuccessStatus: 200,
}));

// NOTE: no global express.json(). The proxy path installs its own
// raw-body middleware (see below). Adding express.json here would
// re-introduce the buffer-and-reserialize leak that the passthrough
// wrap fixes.

// Rate limit: 600 requests / minute / IP. Same posture as the v1 server
// (express-rate-limit default is much higher; we set this so a misbehaving
// client cannot saturate the coordinator with retries).
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Request id: use inbound X-Request-Id if it parses as a UUID v4,
// else generate one. Propagated to the coordinator so a single request
// can be traced end-to-end through gateway -> coordinator -> router -> model client.
// SC-HIGH-002 : the previous length-only check
// still allowed arbitrary strings through, which the coordinator's
// db/logger.js then wrote into aware_conversations.request_id and log
// lines — a log-poisoning vector. UUID v4 contains only hex + dashes,
// so header content can't smuggle newlines, escape codes, or terminal-control bytes.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuidV4(s) {
  return typeof s === 'string' && UUID_V4_RE.test(s);
}
app.use((req, res, next) => {
  const inbound = req.header('x-request-id');
  const id = isValidUuidV4(inbound) ? inbound : randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
});

// --- Health & version (gateway's own) ---------------------------------
app.get('/health', (req, res) => {
  const killed = isKilled();
  res.status(killed ? 503 : 200).json({
    status: killed ? 'down' : 'ok',
    service: 'aware-gateway',
    version: GATEWAY_VERSION,
    kill_switch: killed,
    upstream: config.gateway.coordinatorUrl,
    max_body_bytes: getMaxBodyBytes(),
    request_id: req.id,
  });
});

app.get('/version', (req, res) => {
  res.json({
    service: 'aware-gateway',
    version: GATEWAY_VERSION,
    coordinator_url: config.gateway.coordinatorUrl,
    build_phase: GATEWAY_BUILD_PHASE,
    max_body_bytes: getMaxBodyBytes(),
    request_id: req.id,
  });
});

// --- Audit HTTP API (C-step finding #16) --------------------------------
//
// Mirror the v1 API audit routes (src/api/index.js:264) on the v2
// gateway surface. The audit module is CJS and the routes are exposed
// as named handler functions, not as an Express router; we wrap them
// in a small Router here so the path shape matches v1 exactly:
//   POST /api/audit/log
//   GET  /api/audit/chain/:decisionId
//   GET  /api/audit/verify
//   GET  /api/audit/export
//   GET  /api/audit/records/:decisionId
//
// We mount a path-scoped express.json() so the POST handler can read
// `req.body` without re-introducing a global body parser (which would
// break the proxy path's raw-body passthrough below).
const auditRouter = express.Router();
function mountAudit() {
  const h = getAuditHandlers();
  // 2026-11-10 (scribe): POST /api/audit/log used to write to the chain
  // from the gateway process. The gateway mounts aware-2-audit-data
  // READ-ONLY (docker-compose.coordinator.yml:151 — `:/data/audit:ro`)
  // so that a compromised gateway cannot rewrite the audit trail. The
  // write therefore failed with EROFS: read-only file system.
  //
  // The fix keeps the read-only guarantee and makes the gateway PROXY
  // the write to the coordinator, which mounts the same volume
  // read-write (line 334) and already appends to it after each
  // /coordinate. The chain stays tamper-resistant from the gateway's
  // perspective, and the write path works.
  auditRouter.post('/log', express.json({ limit: '1mb' }), (req, res) => {
    const target = new URL(config.gateway.coordinatorUrl);
    const upstream = http.request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port || 80,
      path: '/api/audit/log',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(req.rawBody || JSON.stringify(req.body || {})),
      },
      timeout: config.gateway.proxyTimeoutMs,
    }, (upstreamRes) => {
      res.status(upstreamRes.statusCode || 502);
      upstreamRes.pipe(res);
    });
    upstream.on('error', (err) => {
      console.error('[gateway] audit log proxy failed:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ success: false, error: 'audit upstream unavailable' });
      }
    });
    const payload = req.rawBody && req.rawBody.length > 0
      ? req.rawBody
      : Buffer.from(JSON.stringify(req.body || {}));
    upstream.end(payload);
  });
  auditRouter.get('/chain/:decisionId', h.getChainRoute);
  auditRouter.get('/verify', h.verifyChainRoute);
  auditRouter.get('/export', h.exportChainRoute);
  auditRouter.get('/records/:decisionId', h.getRecordRoute);
}
mountAudit();
app.use('/api/audit', auditRouter);

// --- Compliance HTTP API --------------------------------------------------
//
// 2026-11-10 (scribe): the compliance UI was reading fabricated numbers.
// The UI called GET /api/compliance/{coverage,readiness}, but those routes
// only exist in the v1 mock backend (src/server.js), which is not running.
// The real compliance engine lives in src/api/routes/compliance.js and is
// mounted by the v1 APIGateway (src/api/index.js:257) — so it was
// unreachable from the v2 gateway surface, where the UI actually talks.
//
// Mounting the same router here, mirroring the /api/audit pattern above.
// The router is CJS and exports an Express Router directly, so it mounts
// as-is. It is lazy-required so a broken compliance module cannot stop
// the gateway from booting (the audit router does the same via
// getAuditHandlers()).
const complianceRouter = express.Router();
function mountCompliance() {
  let r;
  try {
    r = require('../api/routes/compliance');
  } catch (err) {
    console.error('[gateway] compliance routes unavailable:', err.message);
    return;
  }
  // Path-scoped JSON parser: the POST handlers (/assessments,
  // /evidence/collect, /gaps, /reports) read req.body, and the gateway
  // deliberately has no global express.json() so the proxy path can do a
  // raw-body passthrough. Scoping the parser to /api/compliance preserves
  // that property for every other route.
  //
  // The router is mounted as-is rather than per-path: the inner router
  // owns its own path table, and pre-registering each path here would
  // strip the prefix before the inner router could match it.
  complianceRouter.use(express.json({ limit: '1mb' }));
  complianceRouter.use(r);
}
mountCompliance();
app.use('/api/compliance', complianceRouter);

// 2026-11-10 (scribe): start automatic evidence collection.
//
// The EvidenceCollector had registerSchedule(), getIntervalMs() and a
// registerSchedule() call for every default control, but nothing ever
// started the timer — evidence only appeared when a human POSTed to
// /api/compliance/evidence/collect. Start it here so the compliance
// posture reflects the running system rather than the last manual run.
//
// Failures here must not stop the gateway booting: the compliance
// engine is a reporting surface, not the request path.
try {
  const { getEvidenceCollector } = require('../compliance/evidence-collector');
  const collector = getEvidenceCollector();
  collector.startScheduler();
  // Collect once at boot so a fresh deployment has evidence without
  // waiting for the first tick.
  collector.runDueCollections().catch((err) => {
    console.error('[gateway] initial evidence collection failed:', err.message);
  });
} catch (err) {
  console.error('[gateway] could not start evidence scheduler:', err.message);
}

// --- Proxy: passthrough wrap to the coordinator -------------------------
//
// The proxy is generic: any path that isn't handled above gets forwarded.
// This means new coordinator routes work without gateway code changes.
//
// Body handling (the passthrough wrap):
//   - `rawBody` captures the body as a raw Buffer (no JSON parsing).
//   - For requests without a body (GET, DELETE, or POST with no body),
//     `req.body` is `{}` and we strip Content-Length on the way out.
//   - For requests with a body, we forward the Buffer byte-for-byte
//     with a fresh Content-Length. The original Content-Type, charset,
//     and encoding are preserved on the upstream hop.
//   - The raw body limit (default 10 MiB) caps a single request body;
//     bodies above the cap are rejected with 413 and the gateway's
//     standard error envelope (no partial forward).
const rawBody = express.raw({
  type: () => true,  // accept every content type as raw bytes
  limit: getMaxBodyBytes(),
});

app.all(
  /^\/(coordinate|coordinate\/.*|.*)$/,
  (req, res, next) => {
    // Gateway kill-switch takes precedence over coordinator kill-switch.
    // Defense in depth: an operator who only knows the gateway env var
    // can still halt traffic.
    if (isKilled()) {
      res.status(503).json({
        error: 'gateway kill-switch engaged',
        kind: 'killed',
        request_id: req.id,
      });
      return;
    }

    // /health and /version are handled above with .get(); a POST to
    // either falls through to the catch-all and is treated as "not
    // found" without a proxy hop. This avoids accidentally proxying
    // POSTs to those paths and confusing the coordinator.
    if (req.path === '/health' || req.path === '/version') {
      res.status(404).json({ error: 'not found', request_id: req.id });
      return;
    }

    // C-step finding #16: /api/audit/* is a gateway-local surface
    // (audit HTTP API mounted above). Returning 404 here — without
    // proxying — prevents the audit handler from running twice and
    // avoids leaking request bodies to the coordinator's audit endpoint
    // (which doesn't exist). Anything not matched by the audit router
    // above has already 404'd by Express's default; this is belt-and-
    // suspenders for paths the catch-all would otherwise catch.
    if (req.path.startsWith('/api/audit')) {
      res.status(404).json({ error: 'not found', request_id: req.id });
      return;
    }

    // Install the raw body parser for the proxy path. express.raw is
    // applied per-route (not globally) so the /health and /version
    // routes never read a body — they don't need one and the cost of
    // buffering is wasted work for them.
    rawBody(req, res, (err) => {
      if (err) {
        // express.raw emits a typed error (entity.too.large for the
        // size cap, entity.parse.failed for malformed bodies). We
        // surface both as the gateway's standard 4xx envelope.
        if (err.type === 'entity.too.large') {
          return res.status(413).json({
            error: `request body exceeds gateway max (${getMaxBodyBytes()} bytes)`,
            kind: 'body_too_large',
            max_body_bytes: getMaxBodyBytes(),
            request_id: req.id,
          });
        }
        return res.status(400).json({
          error: err.message || 'failed to read request body',
          kind: 'request',
          request_id: req.id,
        });
      }
      next();
    });
  },
  (req, res) => {
    proxyToCoordinator(req, res);
  },
);

function proxyToCoordinator(req, res) {
  return new Promise((resolve) => {
    proxyRequest(req, res, resolve);
  });
}

function proxyRequest(req, res, done) {
  const target = new URL(config.gateway.coordinatorUrl);
  // `req.body` is a Buffer (express.raw) or {} (no body). We forward
  // the raw bytes byte-for-byte — no parsing, no re-serialization.
  // This is the passthrough wrap ADR (internal) specifies: the upstream sees
  // a body that is byte-equivalent to what the client sent.
  const bodyBuf = Buffer.isBuffer(req.body) && req.body.length > 0
    ? req.body
    : null;

  const fwdHeaders = { ...req.headers };
  // Strip the inbound Content-Length — we'll re-derive it from the
  // body we have. If the body is empty, we drop the header entirely
  // so the upstream doesn't wait for bytes the client didn't send.
  delete fwdHeaders['content-length'];
  delete fwdHeaders.host;  // host:port is meaningless to the upstream
  Object.assign(fwdHeaders, {
    'x-request-id': req.id,
    'x-forwarded-host': req.header('host') || '',
    'x-forwarded-proto': req.protocol,
    'x-forwarded-by': 'aware-gateway',
  });
  if (bodyBuf) {
    fwdHeaders['content-length'] = String(bodyBuf.length);
  }

  const opts = {
    method: req.method,
    hostname: target.hostname,
    port: target.port || 80,
    path: req.originalUrl,
    headers: fwdHeaders,
    timeout: config.gateway.proxyTimeoutMs,
  };

  const upstream = http.request(opts, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
    upstreamRes.on('end', () => done && done());
  });

  upstream.on('timeout', () => {
    upstream.destroy(new Error('upstream timeout'));
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({
        error: `upstream error: ${err.message}`,
        kind: 'upstream',
        request_id: req.id,
      });
      done && done();
    } else {
      res.destroy();
    }
  });

  req.on('aborted', () => upstream.destroy());

  // Forward the body buffer. If empty, .end() (no args) sends a body-
  // less request with chunked transfer or no body per HTTP/1.1.
  upstream.end(bodyBuf || undefined);
}

// --- Start server ----------------------------------------------------
//
// The gateway's production entry is the `require.main === module` block
// below. We do not extract this into a testable function because:
//   - app.listen() is already trivially callable in tests via the
//     `startGateway()` helper in test/unit/gateway/server.test.js
//   - The `process.on('SIGTERM'/'SIGINT')` handlers call process.exit()
//     which is not safe to invoke from a test runner
//   - The `console.log` boot lines are observable but not contract
if (require.main === module) {
  const server = app.listen(config.gateway.port, config.gateway.host, () => {
    // eslint-disable-next-line no-console
    console.log(`[aware-gateway] listening on http://${config.gateway.host}:${config.gateway.port}`);
    // eslint-disable-next-line no-console
    console.log(`[aware-gateway] upstream: ${config.gateway.coordinatorUrl}`);
    // eslint-disable-next-line no-console
    console.log(`[aware-gateway] max body: ${getMaxBodyBytes()} bytes`);
    // eslint-disable-next-line no-console
    console.log(`[aware-gateway] kill-switch: ${isKilled() ? 'ENGAGED' : 'off'}`);
  });

  // Graceful shutdown: the coordinator's Dockerfile uses node:22-alpine
  // and sends SIGTERM on `docker stop`. Drain in-flight requests, then
  // close. (Phase 1 bring-up tears down with `down -v`; this matters
  // for Phase 2+ rolling restarts.)
  const shutdown = (signal) => () => {
    // eslint-disable-next-line no-console
    console.log(`[aware-gateway] received ${signal}, draining...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

module.exports = {
  app,
  GATEWAY_VERSION,
  GATEWAY_BUILD_PHASE,
  getMaxBodyBytes,
  isKilled,
};
