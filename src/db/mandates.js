// src/db/mandates.js — Postgres-backed RiskMandate acceptance log
//
// Persistence-side half of the AWARE v2 mandate contract
// (docs/openapi.yaml#/paths/~1v2~1mandates, parents: t_ae57240e).
//
// AWARE is the CONSUMER of the RiskMandate contract here: it records that a
// Mandate acceptance was issued for one of its own events (typically a
// TierPromotion). There is no outbound RiskMandate API client — see the
// card body and CHANGELOG "Out of scope (follow-up cards)".
//
// One row per accepted mandate, in `aware_mandates` (migration
// 007_mandates_audit_table.sql).
//
// Resilience contract:
//   - recordMandate() never throws — it returns a structured result
//     `{recorded: boolean, reason?: string, mandate?: object}` so the caller
//     can decide what to do.
//   - Idempotency: `triggering_event_id` is UNIQUE. A second acceptance for
//     the same AWARE event is NOT an error — it is a reconciliation hit. The
//     writer returns `{recorded: false, reason: 'duplicate', mandate}` with
//     the EXISTING grant so the handler can answer 409 with that body.
//   - When DB is disabled (AWARE_DB_ENABLED=false) the function returns
//     `{recorded: false, reason: 'no-connection'}` without touching the DB.
//
// Validation:
//   - The wire-level shape is validated by the handler
//     (`src/v2/mandates_handler.js` → `validateMandateCreate`). This module
//     re-checks the minimum it needs to write a row so a caller that
//     bypasses the handler cannot write garbage.

import { randomUUID } from 'node:crypto';

// ─── Constants (kept in sync with openapi.yaml) ─────────────────────────

export const VALID_INTERVALS = ['1h', '4h', '1d', '1w', '1m', '6m'];
export const VALID_DIRECTIONS = ['get_more_data', 'reduce', 'increase', 'hold'];
export const VALID_TRIGGER_TYPES = [
  'tier_promotion',
  'pre_tool_block',
  'cascade_revoke',
  'spawn_request',
];
export const VALID_CONSTRAINT_TIERS = ['T0', 'T1', 'T2', 'T3', 'T4'];

// The tier AWARE reports when it cannot evidence a higher one.
//
// openapi.yaml says `agent_constraint_tier` is "the AWARE constraint tier the
// agent holds after this mandate resolution" and "Server-set; clients read
// but do not supply". It does not say what the server does when the tier
// cannot be determined. T0 ("Audit Trail", foundational, always on) is the
// conservative answer: a Mandate response never asserts more autonomy than
// the evidence supports. See the card comment for the full rationale.
export const DEFAULT_CONSTRAINT_TIER = 'T0';

// UUID v1-5 per RFC 4122, canonical 8-4-4-4-12 hex layout. Used to decide
// whether a `triggering_event_id` can be joined to `aware_tier_promotions`
// (whose `event_id` column is a UUID).
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── Pure helpers (exported for testing) ───────────────────────────────

/**
 * Generate the server-side grant identifier.
 *
 * openapi.yaml `MandateResponse.grant_id` is `format: uuid`, "Server-generated
 * unique grant identifier". crypto.randomUUID() gives a v4 UUID, which
 * satisfies the same UUID_REGEX the handler uses on inbound ids.
 */
export function buildGrantId() {
  return randomUUID();
}

/**
 * Normalise a timestamp to an RFC3339/ISO-8601 UTC string.
 * pg returns TIMESTAMPTZ as a JS Date; a stub may return a string.
 */
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/**
 * Convert a DB row into the MandateResponse-shaped object the wire contract
 * defines.
 *
 * Two deliberate choices, both driven by `additionalProperties: false` on
 * MandateResponse:
 *   - the surrogate `id` column is NOT included (it is not a wire field);
 *   - `lethal_trifecta_flag` is omitted when the stored value is NULL,
 *     because the spec does not let the server assert a trifecta verdict it
 *     has not computed.
 *
 * `control_ids` is always present (empty array when the client supplied
 * none) so a 201 body and the 409 body for the same grant are comparable.
 */
export function rowToMandate(row) {
  if (!row || typeof row !== 'object') return null;
  const mandate = {
    grant_id: row.grant_id,
    granted_by: row.granted_by,
    scope: Array.isArray(row.scope) ? row.scope : [],
    expiry: toIso(row.expiry),
    interval: row.interval,
    direction: row.direction,
    underwriters: Array.isArray(row.underwriters) ? row.underwriters : [],
    control_ids: Array.isArray(row.control_ids) ? row.control_ids : [],
    triggering_event_type: row.triggering_event_type,
    triggering_event_id: row.triggering_event_id,
    created_at: toIso(row.created_at),
    agent_constraint_tier: row.agent_constraint_tier,
  };
  if (row.lethal_trifecta_flag !== null && row.lethal_trifecta_flag !== undefined) {
    mandate.lethal_trifecta_flag = row.lethal_trifecta_flag;
  }
  return mandate;
}

// ─── Input validation ───────────────────────────────────────────────────

/**
 * Pre-DB validation. Returns null on success, or a string reason on failure.
 * Mirrors the shape of `validatePromotion` in src/db/tier-promotions.js so
 * the two writers read the same way.
 */
function validateMandate(mandate) {
  if (!mandate || typeof mandate !== 'object') return 'not-an-object';
  if (!mandate.grant_id) return 'missing-grant_id';
  if (!mandate.granted_by) return 'missing-granted_by';
  if (!mandate.expiry) return 'missing-expiry';
  if (!mandate.interval) return 'missing-interval';
  if (!mandate.direction) return 'missing-direction';
  if (!mandate.triggering_event_type) return 'missing-triggering_event_type';
  if (!mandate.triggering_event_id) return 'missing-triggering_event_id';

  if (!VALID_INTERVALS.includes(mandate.interval)) return 'invalid-interval';
  if (!VALID_DIRECTIONS.includes(mandate.direction)) return 'invalid-direction';
  if (!VALID_TRIGGER_TYPES.includes(mandate.triggering_event_type)) {
    return 'invalid-triggering_event_type';
  }

  const underwriters = mandate.underwriters;
  if (!Array.isArray(underwriters) || underwriters.length < 1) {
    return 'invalid-underwriters';
  }
  for (const u of underwriters) {
    if (typeof u !== 'string') return 'invalid-underwriters';
  }

  const scope = mandate.scope;
  if (!Array.isArray(scope)) return 'invalid-scope';
  for (const s of scope) {
    if (typeof s !== 'string') return 'invalid-scope';
  }

  const controlIds = mandate.control_ids;
  if (controlIds !== undefined && controlIds !== null) {
    if (!Array.isArray(controlIds)) return 'invalid-control_ids';
    for (const c of controlIds) {
      if (typeof c !== 'string') return 'invalid-control_ids';
    }
  }

  const trifecta = mandate.lethal_trifecta_flag;
  if (trifecta !== undefined && trifecta !== null && typeof trifecta !== 'boolean') {
    return 'invalid-lethal_trifecta_flag';
  }

  if (
    mandate.agent_constraint_tier !== undefined &&
    mandate.agent_constraint_tier !== null &&
    !VALID_CONSTRAINT_TIERS.includes(mandate.agent_constraint_tier)
  ) {
    return 'invalid-agent_constraint_tier';
  }

  return null;
}

// ─── Main entry points ──────────────────────────────────────────────────

/**
 * Resolve the constraint tier the accepting agent holds after the mandate
 * resolution.
 *
 * openapi.yaml: `agent_constraint_tier` is "the AWARE constraint tier the
 * agent holds after this mandate resolution. Maps to the five-tier system
 * defined in src/server.js". The only place AWARE can *evidence* a tier is
 * the recorded TierPromotion: a promotion from T1 to T2 leaves the agent at
 * T2. So for a `tier_promotion` trigger we read the tier off the promotion
 * row; for every other trigger type there is no tier source, so we fall back
 * to DEFAULT_CONSTRAINT_TIER (T0 — the conservative answer).
 *
 * Never throws: a lookup failure degrades to the default rather than failing
 * the request, because the mandate acceptance itself is still valid.
 *
 * @param {{query: (sql: string, params: unknown[]) => Promise<unknown>}} conn
 * @param {{triggering_event_type?: string, triggering_event_id?: string}} mandate
 * @returns {Promise<{tier: string, source: 'tier-promotion'|'default'}>}
 */
export async function resolveAgentConstraintTier(conn, mandate) {
  const eventType = mandate && mandate.triggering_event_type;
  const eventId = mandate && mandate.triggering_event_id;

  const canLookUp =
    eventType === 'tier_promotion' &&
    typeof eventId === 'string' &&
    UUID_REGEX.test(eventId) &&
    conn &&
    typeof conn.query === 'function';

  if (!canLookUp) {
    return { tier: DEFAULT_CONSTRAINT_TIER, source: 'default' };
  }

  try {
    const result = await conn.query(
      'SELECT to_tier FROM aware_tier_promotions WHERE event_id = $1 LIMIT 1',
      [eventId],
    );
    const rows = result && result.rows ? result.rows : [];
    if (rows.length > 0 && VALID_CONSTRAINT_TIERS.includes(rows[0].to_tier)) {
      return { tier: rows[0].to_tier, source: 'tier-promotion' };
    }
  } catch (err) {
    // The tier-promotion table may not exist yet (migration 006 not applied),
    // or the lookup may hit a transient error. Neither is fatal — the
    // mandate is still valid, we just cannot evidence a tier.
  }

  return { tier: DEFAULT_CONSTRAINT_TIER, source: 'default' };
}

/**
 * Look up the mandate recorded for an AWARE event id.
 *
 * @param {{query: Function}} conn
 * @param {string} triggeringEventId
 * @returns {Promise<object|null>} the MandateResponse-shaped object, or null
 */
export async function findMandateByTriggeringEventId(conn, triggeringEventId) {
  if (!conn || typeof conn.query !== 'function') return null;
  if (typeof triggeringEventId !== 'string' || triggeringEventId.length === 0) return null;

  try {
    const result = await conn.query(
      `SELECT grant_id, granted_by, scope, expiry, "interval", direction,
              underwriters, control_ids, lethal_trifecta_flag,
              triggering_event_type, triggering_event_id, created_at,
              agent_constraint_tier
         FROM aware_mandates
        WHERE triggering_event_id = $1
        LIMIT 1`,
      [triggeringEventId],
    );
    const rows = result && result.rows ? result.rows : [];
    if (rows.length === 0) return null;
    return rowToMandate(rows[0]);
  } catch (err) {
    return null;
  }
}

/**
 * Record a Mandate acceptance.
 *
 * @param {{query: (sql: string, params: unknown[]) => Promise<unknown>}} conn
 *        A pg Pool, Client, or stub that implements .query(sql, params).
 *        May be null/undefined — the function returns 'no-connection'.
 * @param {object} mandate
 *        The MandateResponse-shaped record: grant_id, granted_by, scope,
 *        expiry, interval, direction, underwriters, triggering_event_type,
 *        triggering_event_id, agent_constraint_tier, created_at, and the
 *        optional control_ids / lethal_trifecta_flag.
 * @returns {Promise<{recorded: boolean, reason?: string, mandate?: object, error?: string}>}
 */
export async function recordMandate(conn, mandate) {
  const reason = validateMandate(mandate);
  if (reason) {
    return { recorded: false, reason };
  }

  if (!conn || typeof conn.query !== 'function') {
    return { recorded: false, reason: 'no-connection' };
  }

  const scopeJson = JSON.stringify(mandate.scope || []);
  const underwritersJson = JSON.stringify(mandate.underwriters || []);
  const controlIdsJson = JSON.stringify(mandate.control_ids || []);

  const sql = `
    INSERT INTO aware_mandates (
      grant_id, triggering_event_id, triggering_event_type,
      granted_by, scope, expiry, "interval", direction,
      underwriters, control_ids, lethal_trifecta_flag,
      agent_constraint_tier, created_at
    ) VALUES (
      $1, $2, $3,
      $4, $5::jsonb, $6, $7, $8,
      $9::jsonb, $10::jsonb, $11,
      $12, $13
    )
    ON CONFLICT (triggering_event_id) DO NOTHING
    RETURNING grant_id, granted_by, scope, expiry, "interval", direction,
              underwriters, control_ids, lethal_trifecta_flag,
              triggering_event_type, triggering_event_id, created_at,
              agent_constraint_tier
  `;

  try {
    const result = await conn.query(sql, [
      mandate.grant_id,
      mandate.triggering_event_id,
      mandate.triggering_event_type,
      mandate.granted_by,
      scopeJson,
      mandate.expiry,
      mandate.interval,
      mandate.direction,
      underwritersJson,
      controlIdsJson,
      mandate.lethal_trifecta_flag === undefined ? null : mandate.lethal_trifecta_flag,
      mandate.agent_constraint_tier || DEFAULT_CONSTRAINT_TIER,
      mandate.created_at,
    ]);

    const rows = result && result.rows ? result.rows : [];
    if (rows.length === 0) {
      // ON CONFLICT DO NOTHING → the AWARE event already has a mandate.
      const existing = await findMandateByTriggeringEventId(
        conn,
        mandate.triggering_event_id
      );
      return { recorded: false, reason: 'duplicate', mandate: existing };
    }
    return { recorded: true, mandate: rowToMandate(rows[0]) };
  } catch (err) {
    // A unique_violation on `triggering_event_id` (or `grant_id`) is the same
    // reconciliation hit as ON CONFLICT DO NOTHING.
    if (err && err.code === '23505') {
      const existing = await findMandateByTriggeringEventId(
        conn,
        mandate.triggering_event_id
      );
      return { recorded: false, reason: 'duplicate', mandate: existing };
    }
    return {
      recorded: false,
      reason: 'insert-failed',
      error: err && err.message ? err.message : String(err),
    };
  }
}
