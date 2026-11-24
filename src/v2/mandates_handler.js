// src/v2/mandates_handler.js
// AWARE v2 — POST /v2/mandates
//
// Implements the contract documented at
// docs/openapi.yaml#/paths/~1v2~1mandates.
//
// AWARE is the CONSUMER of the RiskMandate contract, not a client of it: this
// endpoint records that a Mandate acceptance was issued for one of AWARE's
// own events (typically a TierPromotion). There is deliberately no outbound
// call to riskmandate.ai here — see the card body and CHANGELOG "Out of
// scope (follow-up cards)".
//
// Schema source of truth: docs/openapi.yaml `MandateCreate` (request) and
// `MandateResponse` (response). The validation below mirrors those schemas
// by hand (no ajv in the dep tree); when the spec changes, update the schema
// here and the unit tests in lockstep.
//
// Why hand-rolled validation:
//   - Keeps the runtime dep set unchanged (no ajv added).
//   - Validation logic is small and stable: 8 required fields, 2 enums,
//     1 date-time format, 1 minItems.
//   - Hand-rolled error messages can be tailored for the OpenAPI Error shape
//     the spec requires on 400 (single object with error + details).
//
// Status codes (all from the spec):
//   201 — Mandate created; body is a MandateResponse.
//   400 — Malformed MandateCreate payload; body is the Error shape
//         (`error` + `details`).
//   409 — A mandate already exists for this `triggering_event_id`; body is
//         the EXISTING MandateResponse so the client can reconcile.
//
// Persistence:
//   - Delegates to the DB-backed writer at `src/db/mandates.js` via a
//     dynamic-import bridge (that module is ESM; this handler is CJS).
//   - Unlike /v2/tier-promotions, this endpoint does NOT degrade to a
//     best-effort accept on a DB failure. 201 means "created" and 409 means
//     "the idempotency guard held"; neither promise survives without
//     storage, so a persistence failure is reported as 503 (no connection)
//     or 500 (write failed) rather than a lie.

'use strict';

const { randomUUID } = require('node:crypto');

// ---------------------------------------------------------------------------
// Constants — kept in sync with openapi.yaml `MandateCreate`.
// ---------------------------------------------------------------------------

const VALID_INTERVALS = ['1h', '4h', '1d', '1w', '1m', '6m'];
const VALID_DIRECTIONS = ['get_more_data', 'reduce', 'increase', 'hold'];
const VALID_TRIGGER_TYPES = [
  'tier_promotion',
  'pre_tool_block',
  'cascade_revoke',
  'spawn_request',
];

// RFC3339 date-time: YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)
const RFC3339_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

// openapi.yaml `MandateCreate.additionalProperties: false`. The server-side
// fields (`grant_id`, `created_at`, `agent_constraint_tier`) are NOT in this
// set — a client that supplies them is rejected.
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'granted_by',
  'scope',
  'expiry',
  'interval',
  'direction',
  'underwriters',
  'control_ids',
  'lethal_trifecta_flag',
  'triggering_event_type',
  'triggering_event_id',
]);

// openapi.yaml `MandateCreate.required` — exactly these eight. `control_ids`
// and `lethal_trifecta_flag` are OPTIONAL properties in the current spec
// (openapi.yaml v1.1.0), even though an earlier revision of the card body
// listed them as required. The spec wins.
const REQUIRED_TOP_LEVEL_KEYS = [
  'granted_by',
  'scope',
  'expiry',
  'interval',
  'direction',
  'underwriters',
  'triggering_event_type',
  'triggering_event_id',
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a MandateCreate payload against the openapi.yaml schema.
 *
 * Returns { valid: true, value } on success, where `value` is the
 * canonicalised object (no extra keys, typed defaults).
 * Returns { valid: false, violations: [{ path, message }] } on failure.
 *
 * Exported separately from the handler so unit tests can drive it without an
 * HTTP round-trip.
 */
function validateMandateCreate(body) {
  const violations = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      violations: [{ path: '', message: 'request body must be a JSON object' }],
    };
  }

  // additionalProperties: false — root object
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      violations.push({ path: key, message: `unknown field "${key}"` });
    }
  }

  // required fields — a missing field is reported as "is required".
  // We do NOT short-circuit on missing-required: every per-field check runs
  // so the caller sees all violations at once.
  for (const field of REQUIRED_TOP_LEVEL_KEYS) {
    if (body[field] === undefined || body[field] === null) {
      violations.push({ path: field, message: `"${field}" is required` });
    }
  }

  // Per-field type / format checks. Each `if (body.x !== undefined)` guard
  // prevents duplicate errors when a field is also missing.

  if (body.granted_by !== undefined && typeof body.granted_by !== 'string') {
    violations.push({ path: 'granted_by', message: '"granted_by" must be a string' });
  }

  if (body.scope !== undefined) {
    if (!Array.isArray(body.scope)) {
      violations.push({ path: 'scope', message: '"scope" must be an array of strings' });
    } else if (!body.scope.every(s => typeof s === 'string')) {
      violations.push({ path: 'scope', message: '"scope" must contain only strings' });
    }
  }

  if (body.expiry !== undefined) {
    if (typeof body.expiry !== 'string' || !RFC3339_REGEX.test(body.expiry)) {
      violations.push({
        path: 'expiry',
        message: '"expiry" must be an RFC3339 date-time string',
      });
    } else {
      const ms = Date.parse(body.expiry);
      if (Number.isNaN(ms)) {
        violations.push({
          path: 'expiry',
          message: '"expiry" is not a valid calendar date',
        });
      }
    }
  }

  if (body.interval !== undefined && !VALID_INTERVALS.includes(body.interval)) {
    violations.push({
      path: 'interval',
      message: `"interval" must be one of: ${VALID_INTERVALS.join(', ')}`,
    });
  }

  if (body.direction !== undefined && !VALID_DIRECTIONS.includes(body.direction)) {
    violations.push({
      path: 'direction',
      message: `"direction" must be one of: ${VALID_DIRECTIONS.join(', ')}`,
    });
  }

  if (body.underwriters !== undefined) {
    if (!Array.isArray(body.underwriters)) {
      violations.push({
        path: 'underwriters',
        message: '"underwriters" must be an array of strings',
      });
    } else if (body.underwriters.length < 1) {
      violations.push({
        path: 'underwriters',
        message: '"underwriters" must contain at least 1 item',
      });
    } else if (!body.underwriters.every(u => typeof u === 'string')) {
      violations.push({
        path: 'underwriters',
        message: '"underwriters" must contain only strings',
      });
    }
  }

  if (body.control_ids !== undefined) {
    if (!Array.isArray(body.control_ids)) {
      violations.push({
        path: 'control_ids',
        message: '"control_ids" must be an array of strings',
      });
    } else if (!body.control_ids.every(c => typeof c === 'string')) {
      violations.push({
        path: 'control_ids',
        message: '"control_ids" must contain only strings',
      });
    }
  }

  if (
    body.lethal_trifecta_flag !== undefined &&
    typeof body.lethal_trifecta_flag !== 'boolean'
  ) {
    violations.push({
      path: 'lethal_trifecta_flag',
      message: '"lethal_trifecta_flag" must be a boolean',
    });
  }

  if (
    body.triggering_event_type !== undefined &&
    !VALID_TRIGGER_TYPES.includes(body.triggering_event_type)
  ) {
    violations.push({
      path: 'triggering_event_type',
      message: `"triggering_event_type" must be one of: ${VALID_TRIGGER_TYPES.join(', ')}`,
    });
  }

  if (body.triggering_event_id !== undefined) {
    if (typeof body.triggering_event_id !== 'string') {
      violations.push({
        path: 'triggering_event_id',
        message: '"triggering_event_id" must be a string',
      });
    } else if (body.triggering_event_id.length === 0) {
      violations.push({
        path: 'triggering_event_id',
        message: '"triggering_event_id" must not be empty',
      });
    }
  }

  if (violations.length > 0) {
    return { valid: false, violations };
  }

  // Canonical value: copy known keys in spec order so the recorded mandate
  // is stable across re-orderings of the request payload.
  const value = {};
  for (const k of ALLOWED_TOP_LEVEL_KEYS) {
    if (body[k] !== undefined) value[k] = body[k];
  }
  return { valid: true, value };
}

// ---------------------------------------------------------------------------
// Express handler factory
// ---------------------------------------------------------------------------

/**
 * Build the Express router for POST /v2/mandates.
 *
 * @param {object} [opts]
 * @param {() => Promise<{query: Function}|null>} [opts.getConn]
 *   Lazy factory returning the DB connection (or null if DB is disabled).
 *   Defaults to dynamic-importing `src/db/index.js`'s `getPool`.
 *   Tests pass a stub.
 * @param {(conn: object, mandate: object) => Promise<object>} [opts.recordMandate]
 *   Optional override for the persistence call. Defaults to
 *   dynamic-importing `src/db/mandates.js`'s `recordMandate`.
 * @param {(conn: object, eventId: string) => Promise<object|null>} [opts.findMandate]
 *   Optional override for the idempotency pre-check. Defaults to
 *   dynamic-importing `src/db/mandates.js`'s `findMandateByTriggeringEventId`.
 * @param {(conn: object, mandate: object) => Promise<{tier: string}>} [opts.resolveTier]
 *   Optional override for the constraint-tier resolution. Defaults to
 *   dynamic-importing `src/db/mandates.js`'s `resolveAgentConstraintTier`.
 */
function createMandatesRouter(opts = {}) {
  const express = require('express');
  const router = express.Router();

  router.post('/mandates', async (req, res) => {
    const result = validateMandateCreate(req.body);
    if (!result.valid) {
      return res.status(400).json({
        error: 'Malformed MandateCreate payload',
        details: result.violations
          .map(v => `${v.path}: ${v.message}`)
          .join('; '),
        violations: result.violations,
      });
    }

    const create = result.value;

    let conn;
    let record;
    let find;
    let resolveTier;
    try {
      [conn, record, find, resolveTier] = await Promise.all([
        opts.getConn ? opts.getConn() : defaultGetConn(),
        opts.recordMandate ? Promise.resolve(opts.recordMandate) : defaultRecordMandate(),
        opts.findMandate ? Promise.resolve(opts.findMandate) : defaultFindMandate(),
        opts.resolveTier ? Promise.resolve(opts.resolveTier) : defaultResolveTier(),
      ]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mandates] persistence modules unavailable:', err.message);
      return res.status(503).json({
        error: 'Mandate persistence unavailable',
        details: err.message,
      });
    }

    // Idempotency pre-check. The DB has a UNIQUE constraint on
    // `triggering_event_id`; this read lets us answer 409 without burning a
    // grant_id and without relying on the write to fail. The write path
    // re-checks (the pre-check is racy by nature).
    let existing = null;
    try {
      existing = await find(conn, create.triggering_event_id);
    } catch (err) {
      // A failed lookup is not fatal — the write's unique constraint is the
      // real guard. Fall through and let the insert decide.
    }
    if (existing) {
      return res.status(409).json(existing);
    }

    // Server-side fields. `grant_id` is server-generated; `created_at` is the
    // recording time; `agent_constraint_tier` is resolved from the recorded
    // AWARE event (see src/db/mandates.js for the fallback rule).
    let grantId;
    let createdAt;
    let constraintTier;
    try {
      grantId = buildGrantId();
      createdAt = new Date().toISOString();
      const resolved = await resolveTier(conn, {
        triggering_event_type: create.triggering_event_type,
        triggering_event_id: create.triggering_event_id,
      });
      constraintTier = resolved && resolved.tier ? resolved.tier : DEFAULT_CONSTRAINT_TIER;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mandates] could not prepare the mandate record:', err.message);
      return res.status(500).json({
        error: 'Mandate could not be prepared',
        details: err.message,
      });
    }

    const mandate = {
      grant_id: grantId,
      granted_by: create.granted_by,
      scope: create.scope,
      expiry: create.expiry,
      interval: create.interval,
      direction: create.direction,
      underwriters: create.underwriters,
      triggering_event_type: create.triggering_event_type,
      triggering_event_id: create.triggering_event_id,
      agent_constraint_tier: constraintTier,
      created_at: createdAt,
    };
    if (create.control_ids !== undefined) mandate.control_ids = create.control_ids;
    if (create.lethal_trifecta_flag !== undefined) {
      mandate.lethal_trifecta_flag = create.lethal_trifecta_flag;
    }

    let writeResult;
    try {
      writeResult = await record(conn, mandate);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mandates] persistence call threw:', err.message);
      return res.status(500).json({
        error: 'Mandate could not be recorded',
        details: err.message,
      });
    }

    if (!writeResult) {
      return res.status(500).json({
        error: 'Mandate could not be recorded',
        details: 'persistence returned no result',
      });
    }

    if (writeResult.recorded === true) {
      return res.status(201).json(writeResult.mandate || mandate);
    }

    if (writeResult.reason === 'duplicate') {
      // The race we hoped would not happen: another writer recorded the
      // mandate between our pre-check and our insert. The spec's 409 body is
      // the EXISTING grant so the client can reconcile.
      const conflict = writeResult.mandate || (await safeFind(find, conn, create.triggering_event_id));
      return res.status(409).json(conflict || mandate);
    }

    if (writeResult.reason === 'no-connection') {
      // 201 would be a lie: without storage neither the record nor the
      // idempotency guarantee exists.
      return res.status(503).json({
        error: 'Mandate persistence unavailable',
        details: 'database connection is not available',
      });
    }

    if (writeResult.reason && writeResult.reason.startsWith('invalid-')) {
      // The writer rejected the payload we just validated. That is a bug in
      // one of the two layers, not a client error — but the client sent
      // something the writer cannot store, so 400 is the honest answer.
      return res.status(400).json({
        error: 'Malformed MandateCreate payload',
        details: writeResult.reason,
      });
    }

    // eslint-disable-next-line no-console
    console.error('[mandates] persistence failed:', writeResult.reason, writeResult.error);
    return res.status(500).json({
      error: 'Mandate could not be recorded',
      details: writeResult.error || writeResult.reason || 'unknown persistence failure',
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Default factories — dynamic-import the ESM persistence module from CJS.
// ---------------------------------------------------------------------------

const DEFAULT_CONSTRAINT_TIER = 'T0';

let _mandatesModule = null;
async function loadMandatesModule() {
  if (!_mandatesModule) {
    // src/db/mandates.js is ESM. Bridge via dynamic import.
    _mandatesModule = await import('../db/mandates.js');
  }
  return _mandatesModule;
}

async function defaultRecordMandate() {
  const mod = await loadMandatesModule();
  return mod.recordMandate;
}

async function defaultFindMandate() {
  const mod = await loadMandatesModule();
  return mod.findMandateByTriggeringEventId;
}

async function defaultResolveTier() {
  const mod = await loadMandatesModule();
  return mod.resolveAgentConstraintTier;
}

async function defaultGetConn() {
  // src/db/index.js is ESM; its getPool() returns null if DB is disabled.
  const mod = await import('../db/index.js');
  return mod.getPool();
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function buildGrantId() {
  // crypto.randomUUID() — matches the `format: uuid` on MandateResponse.
  return randomUUID();
}

async function safeFind(find, conn, eventId) {
  try {
    return await find(conn, eventId);
  } catch (err) {
    return null;
  }
}

module.exports = {
  createMandatesRouter,
  validateMandateCreate,
  // Test/internal hooks
  _resetModuleCacheForTest() {
    _mandatesModule = null;
  },
};
