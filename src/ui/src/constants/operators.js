/**
 * Operator-trust (OHI) vocabulary, band thresholds and diary-entry parsing
 * for the Operators dashboard screen.
 *
 * VOCABULARY. This module speaks OHI (Operator / Human Identity) only. The
 * screen lists OPERATORS -- humans at the keyboard -- and the field names
 * below are the operator's own. "NHI" (Non-Human Identity) belongs to the
 * agent screens (src/ui/src/components/AgentIdentityDashboard.js) and must
 * not leak in here: an operator screen that says "NHI" is a screen that
 * cannot tell a human from an agent, which is the exact confusion the OHI
 * term exists to prevent. Test guard: test/unit/ui/operators-dashboard.test.js
 * ("the Operators screen speaks OHI, never NHI").
 *
 * WHAT "score" MEANS HERE -- READ THIS BEFORE CHANGING A THRESHOLD.
 *
 * The `score` recorded by the OHI scorer is an ANOMALY score, not a trust
 * score. 0.0 means "matches the operator's baseline exactly"; 1.0 means
 * "every axis fired at once". The scorer's own bands
 * (identity-confirmation/RESEARCH.md, "Score band" table) are:
 *
 *     0.0 - 0.3  low      pass through, no log
 *     0.3 - 0.7  medium   log to the operator profile
 *     0.7 - 0.9  high     HOLD the reply
 *     0.9 - 1.0  critical BLOCK the reply
 *
 * So a HIGH recorded score is a BAD operator. This screen renders a TRUST
 * band, and trust is the inverse of anomaly: an operator scoring 0.85 is
 * being held, and must never render green.
 *
 * The card's acceptance criterion for this screen (AC3) states the cut
 * points (0.4 / 0.7) and the trust ramp's three names, but reads them in
 * the anomaly direction ("--color-trust-high for >=0.7"), which would paint
 * a BLOCKED operator green. The cut points are kept verbatim; the direction
 * is corrected, because the ramp is named for what it renders (trust) and
 * the input is what it measures (anomaly). The thresholds sit on the
 * recorded score; the BAND is what inverts.
 *
 * An unparseable score resolves to the LOW band, never to "high trust": a
 * score this screen cannot read is not evidence that the operator is
 * behaving.
 */

/** The entity_kind discriminator for an operator row. */
export const OPERATOR_ENTITY_KIND = 'operator';

/** The producer_id the OHI scorer writes under (AIRM taxonomy). */
export const OPERATOR_SOURCE = 'identity_scorer';

export const TRUST_BAND_HIGH = 'high';
export const TRUST_BAND_MEDIUM = 'medium';
export const TRUST_BAND_LOW = 'low';

/**
 * Cut points on the RECORDED score, in the scorer's own units (0..1).
 *
 * 0.4 is the medium floor: at or above it the operator is off their
 * baseline and the score is logged to their profile. 0.7 is the low floor:
 * at or above it the gateway HOLDS the reply (RESEARCH.md band table).
 */
export const TRUST_SCORE_MEDIUM_FLOOR = 0.4;
export const TRUST_SCORE_LOW_FLOOR = 0.7;

/** Rows per page in the Operators list. */
export const OPERATOR_PAGE_SIZE = 50;

/** The maximum the v1 diary endpoint will return in one response. */
export const DIARY_MAX_LIMIT = 200;

/**
 * The trust band for a recorded ANOMALY score.
 *
 * @param {number} score recorded score in 0..1 (higher = more anomalous)
 * @returns {'high'|'medium'|'low'} trust band
 */
export const bandForAnomalyScore = (score) => {
  // Number(null) is 0 and Number('') is 0, so a MISSING score would coerce
  // to "no anomaly" and render as HIGH trust. Guard the empty cases before
  // coercing: an absent score is an unreadable score, not a zero score.
  if (score === null || score === undefined || score === '') return TRUST_BAND_LOW;
  const n = Number(score);
  if (!Number.isFinite(n)) return TRUST_BAND_LOW;
  if (n >= TRUST_SCORE_LOW_FLOOR) return TRUST_BAND_LOW;
  if (n >= TRUST_SCORE_MEDIUM_FLOOR) return TRUST_BAND_MEDIUM;
  return TRUST_BAND_HIGH;
};

/**
 * The trust band for a 0..100 TRUST score -- the NHI agent gauge's unit.
 *
 * The thresholds are the ones AgentIdentityDashboard.js has always used
 * (>80 high, >50 medium, else low), so extracting the gauge into a shared
 * component is a ZERO-VISUAL-CHANGE for the agent screen.
 *
 * @param {number} trustScore trust score in 0..100 (higher = more trusted)
 * @returns {'high'|'medium'|'low'} trust band
 */
export const trustBandForTrustScore = (trustScore) => {
  if (trustScore === null || trustScore === undefined || trustScore === '') {
    return TRUST_BAND_LOW;
  }
  const n = Number(trustScore);
  if (!Number.isFinite(n)) return TRUST_BAND_LOW;
  if (n > 80) return TRUST_BAND_HIGH;
  if (n > 50) return TRUST_BAND_MEDIUM;
  return TRUST_BAND_LOW;
};

const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null);

/**
 * Parse one v1 diary row into an operator observation, or null if the row
 * is not an operator row.
 *
 * THE v0 SHAPE. The v1 diary schema (src/db/diary_store.py) has no
 * `entity_kind` column and no structured score column -- the producer
 * stringifies a JSON payload into `content` (Architect Blocker A, card
 * t_3fd25c81). So the taxonomy discriminator and the score arrive INSIDE
 * `content`, and this parser has to read them out of the string.
 *
 * A row is an operator row when either:
 *   - it says so: `entity_kind === 'operator'`; or
 *   - the v0 wrapper carries operator fields but no discriminator at all
 *     (`operator_id` + `score`, no `entity_kind`), which is what the v0
 *     producer emits.
 *
 * A row that names a DIFFERENT entity_kind (say 'agent') is not an
 * operator row and is excluded -- that is what keeps the NHI agent traffic
 * out of an operator screen.
 *
 * @param {object} entry a row from GET /api/diary/entries
 * @returns {object|null} normalized observation
 */
export const parseDiaryEntry = (entry) => {
  if (!entry || typeof entry !== 'object') return null;

  let payload = null;
  if (typeof entry.content === 'string') {
    try {
      payload = JSON.parse(entry.content);
    } catch (err) {
      payload = null;
    }
  } else if (entry.content && typeof entry.content === 'object') {
    payload = entry.content;
  }
  if (!payload || typeof payload !== 'object') return null;

  const entityKind = firstDefined(payload.entity_kind, entry.entity_kind);
  const operatorId = firstDefined(payload.operator_id, payload.operatorId);
  const rawScore = firstDefined(payload.score, payload.anomaly_score);

  const namesOperator = entityKind === OPERATOR_ENTITY_KIND;
  const v0OperatorShape = entityKind === undefined && operatorId !== undefined && rawScore !== undefined;
  if (!namesOperator && !v0OperatorShape) return null;

  const score = Number(rawScore);
  return {
    id: firstDefined(entry.id, payload.id) ?? null,
    operatorId: String(operatorId),
    score: Number.isFinite(score) ? score : null,
    band: bandForAnomalyScore(score),
    action: firstDefined(payload.action, payload.action_taken) ?? null,
    source: firstDefined(payload.source, payload.producer_id, entry.source) ?? null,
    createdAt: Number(entry.created_at) || 0,
    entityKind: OPERATOR_ENTITY_KIND,
  };
};

/**
 * Group diary rows into one record per operator, with that operator's
 * score history in ascending time order.
 *
 * @param {object[]} entries raw rows from GET /api/diary/entries
 * @returns {object[]} operator records, most-recently-scored first
 */
export const collectOperators = (entries) => {
  const byOperator = new Map();
  for (const entry of entries || []) {
    const parsed = parseDiaryEntry(entry);
    if (!parsed) continue;
    const existing = byOperator.get(parsed.operatorId);
    if (!existing) {
      byOperator.set(parsed.operatorId, {
        operatorId: parsed.operatorId,
        latestScore: parsed.score,
        latestBand: parsed.band,
        latestCreatedAt: parsed.createdAt,
        samples: [parsed],
      });
      continue;
    }
    existing.samples.push(parsed);
    if (parsed.createdAt >= existing.latestCreatedAt) {
      existing.latestCreatedAt = parsed.createdAt;
      existing.latestScore = parsed.score;
      existing.latestBand = parsed.band;
    }
  }

  const records = [...byOperator.values()];
  for (const record of records) {
    record.samples.sort((a, b) => a.createdAt - b.createdAt);
  }
  records.sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);
  return records;
};

/**
 * Find one operator's record.
 *
 * @param {object[]} records output of collectOperators
 * @param {string} operatorId
 * @returns {object|null}
 */
export const findOperator = (records, operatorId) => {
  const wanted = String(operatorId);
  return (records || []).find((r) => r.operatorId === wanted) || null;
};

/**
 * Slice one page out of a record list.
 *
 * The v1 diary endpoint has no offset parameter (DiaryStore.list_entries is
 * LIMIT-only), so the Operators list paginates CLIENT-side over the rows it
 * fetched. Server-side paging needs the v1 schema migration (card 3b).
 *
 * @param {object[]} records
 * @param {number} page zero-based page index
 * @param {number} pageSize
 * @returns {{rows: object[], page: number, pageSize: number, total: number, totalPages: number}}
 */
export const paginate = (records, page, pageSize) => {
  const all = records || [];
  const size = pageSize > 0 ? pageSize : OPERATOR_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(all.length / size));
  const current = Math.min(Math.max(0, page || 0), totalPages - 1);
  const start = current * size;
  return {
    rows: all.slice(start, start + size),
    page: current,
    pageSize: size,
    total: all.length,
    totalPages,
  };
};

/**
 * Format a recorded score for display.
 *
 * @param {number} score
 * @returns {string}
 */
export const formatScore = (score) => {
  const n = Number(score);
  return Number.isFinite(n) ? n.toFixed(3) : '--';
};

/**
 * Format an epoch-seconds timestamp as a local date-time string.
 *
 * @param {number} epochSeconds
 * @returns {string}
 */
export const formatTimestamp = (epochSeconds) => {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return '--';
  return new Date(n * 1000).toLocaleString();
};
