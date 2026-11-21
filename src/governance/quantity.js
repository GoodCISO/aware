// src/governance/quantity.js
//
// Governance quantity provenance — Phase 0 of the provenance remediation.
//
// WHY THIS MODULE EXISTS
// ----------------------
// A governance control has two halves: a *declaration* (the type, the field
// name, the default, the documentation) and an *implementation* (the algorithm
// that produces the value). It is easy to write the first half and defer the
// second, because the first half is what makes a system *look* governed.
//
// When that happens the gap is invisible. The field is typed, it is transported
// (often inside a signed credential), it is displayed, and it is consumed by a
// decision — and every static check passes, because nothing in the type system
// records where the value came from.
//
// This module makes provenance part of the value. Every governance quantity
// carries its origin, and the origin is one of a small, closed set:
//
//   'derived'  — computed from independent evidence by a named producer.
//   'declared' — supplied by an operator or configuration. There is no producer.
//   'orphaned' — a producer exists and is implemented, but is NOT connected to
//                this quantity. The producer is real; the wiring is missing.
//
// 'orphaned' is the case that a naive "does a producer exist?" audit misses.
// A trust score computed by src/monitoring/anomaly-scorer.js is real, tested
// code — but nothing imports it, so the trustScore claim that ships in the
// JWT is not that score.
//
// SEE ALSO
// --------
//   src/governance/quantity.test.js  — the provenance contract, under test.
//   docs/adr/ADR-082-aware-governance-quantity-provenance.md

'use strict';

/**
 * Closed set of governance-quantity origins.
 *
 * The values are strings on purpose: they cross serialisation boundaries
 * (JWT claims, HTTP bodies, audit records), and a string survives that
 * boundary without needing a consumer to import the enum.
 *
 * @readonly
 * @enum {string}
 */
const QUANTITY_ORIGIN = Object.freeze({
  /** Computed from independent evidence by a named producer. */
  DERIVED: 'derived',
  /** Operator- or configuration-supplied. No producer exists. */
  DECLARED: 'declared',
  /**
   * A producer exists and is implemented, but is not connected to this
   * quantity. The value is therefore supplied, not derived.
   */
  ORPHANED: 'orphaned',
});

/**
 * Origins at which a value is *not* computed from independent evidence.
 * A quantity whose origin is in this set is supplied by something other than
 * a producer, and must not be described as a measurement.
 *
 * @type {ReadonlySet<string>}
 */
const NON_DERIVED_ORIGINS = Object.freeze(
  new Set([QUANTITY_ORIGIN.DECLARED, QUANTITY_ORIGIN.ORPHANED])
);

/**
 * Trust-score scale.
 *
 * The canonical unit is [0.0, 1.0]. This was the unit in the registry
 * (`src/api/models/Agent.js`), in the routing consumer
 * (`src/routing/heuristic-calculator.js`), in the JWT claim, and in the
 * seed data. The UI was the sole outlier, banding and labelling the value
 * as 0..100 while the stored value was [0,1] — so a stored 0.85 rendered as
 * "0.85/100" and banded as "low".
 *
 * @readonly
 * @enum {string}
 */
const TRUST_SCORE_SCALE = Object.freeze({
  /** Canonical: fractional, 0.0 .. 1.0. */
  UNIT: 'unit',
  /** Legacy display scale, 0 .. 100. Never used for storage. */
  PERCENT: 'percent',
});

/**
 * Blast-radius representation.
 *
 * Four mechanisms previously answered to the name "blast radius" with four
 * incompatible representations. They are now distinct names, each with one
 * unit, so a consumer cannot mistake one for another.
 *
 * @readonly
 * @enum {string}
 */
const BLAST_RADIUS_KIND = Object.freeze({
  /**
   * Operator-supplied numeric estimate in [0,1]. No producer; it is read
   * from agent metadata with a default fallback.
   */
  DECLARED_ESTIMATE: 'declared-estimate',
  /**
   * Revocation trail penalty factor in [0,1]: how much of an agent's
   * accumulated trail is eroded by a revocation of a given severity.
   * NOT a radius over affected agents or resources.
   */
  REVOCATION_PENALTY: 'revocation-penalty',
  /**
   * Emergency impact estimate: an object describing how many agents and
   * tasks a kill scope would affect. NOT comparable with the numeric forms.
   */
  EMERGENCY_IMPACT: 'emergency-impact',
  /**
   * Legacy protocol-level severity label. Retained for wire compatibility
   * only; carries no numeric meaning.
   */
  PROTOCOL_SEVERITY: 'protocol-severity',
});

/**
 * Blast-radius units, keyed by kind. Each kind has exactly one unit.
 *
 * @type {Readonly<Record<string, string>>}
 */
const BLAST_RADIUS_UNITS = Object.freeze({
  [BLAST_RADIUS_KIND.DECLARED_ESTIMATE]: 'fraction',
  [BLAST_RADIUS_KIND.REVOCATION_PENALTY]: 'fraction',
  [BLAST_RADIUS_KIND.EMERGENCY_IMPACT]: 'impact-record',
  [BLAST_RADIUS_KIND.PROTOCOL_SEVERITY]: 'severity-label',
});

/**
 * Human-readable labels for a quantity origin. Used in audit records and API
 * responses so an operator sees the same vocabulary the code uses.
 *
 * @type {Readonly<Record<string, string>>}
 */
const ORIGIN_LABELS = Object.freeze({
  [QUANTITY_ORIGIN.DERIVED]: 'derived from evidence',
  [QUANTITY_ORIGIN.DECLARED]: 'operator-declared; no producer',
  [QUANTITY_ORIGIN.ORPHANED]: 'producer exists but is not wired to this quantity',
});

/**
 * Build a governance-quantity descriptor.
 *
 * @param {Object} spec
 * @param {string} spec.name           - The quantity's name.
 * @param {string} spec.origin         - One of QUANTITY_ORIGIN.
 * @param {string} [spec.unit]         - The unit, e.g. 'fraction'.
 * @param {string} [spec.producer]     - Name of the producing function. Required
 *                                       when origin is DERIVED; must be absent
 *                                       otherwise (an orphaned quantity names
 *                                       the producer that is not wired).
 * @param {string} [spec.note]         - Free-text provenance note.
 * @returns {Object} A frozen quantity descriptor.
 */
function defineQuantity(spec) {
  if (!spec || typeof spec.name !== 'string' || spec.name.length === 0) {
    throw new TypeError('defineQuantity: name must be a non-empty string');
  }
  const origin = spec.origin;
  if (!Object.values(QUANTITY_ORIGIN).includes(origin)) {
    throw new TypeError(
      `defineQuantity: unknown origin '${origin}' for '${spec.name}'`
    );
  }
  if (origin === QUANTITY_ORIGIN.DERIVED && !spec.producer) {
    throw new TypeError(
      `defineQuantity: '${spec.name}' is declared derived but names no producer`
    );
  }
  if (origin !== QUANTITY_ORIGIN.DERIVED && spec.producer) {
    throw new TypeError(
      `defineQuantity: '${spec.name}' has origin '${origin}' and must not name a ` +
        `wired producer (got '${spec.producer}')`
    );
  }
  return Object.freeze({
    name: spec.name,
    origin,
    unit: spec.unit || null,
    producer: spec.producer || null,
    note: spec.note || null,
  });
}

/**
 * True when a quantity's origin means it is computed from evidence.
 *
 * @param {Object|string} quantity - A descriptor, or an origin string.
 * @returns {boolean}
 */
function isDerived(quantity) {
  const origin = typeof quantity === 'string' ? quantity : quantity && quantity.origin;
  return origin === QUANTITY_ORIGIN.DERIVED;
}

/**
 * Normalise a trust score to the canonical [0,1] unit.
 *
 * Accepts either unit so that a legacy 0..100 value cannot silently be read
 * as a fraction. A value strictly greater than 1 is interpreted as a percent
 * value and divided by 100; a value in [0,1] is taken as a fraction.
 *
 * @param {number|null|undefined} value
 * @returns {number|null} A value in [0,1], or null if the input is not a
 *   finite number.
 */
function normaliseTrustScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1) {
    // Legacy percent scale.
    return Math.max(0, Math.min(1, n / 100));
  }
  return Math.max(0, Math.min(1, n));
}

/**
 * Format a trust score for display.
 *
 * The canonical unit is [0,1]; the UI renders a percentage. Keeping the
 * conversion here — rather than inline at each display site — is what stops
 * the two scales from diverging again.
 *
 * @param {number|null|undefined} value
 * @returns {string} e.g. '85%', or '—' when the value is absent.
 */
function formatTrustScore(value) {
  const n = normaliseTrustScore(value);
  if (n === null) return '—';
  return `${Math.round(n * 100)}%`;
}

/**
 * Band a trust score for display.
 *
 * The thresholds are the ones AgentIdentityDashboard.js has always used
 * (>80 high, >50 medium, else low), applied to the PERCENT scale. This is
 * the same visual behaviour as before the unit was fixed, applied to the
 * correct input.
 *
 * @param {number|null|undefined} value
 * @returns {'high'|'medium'|'low'}
 */
function bandTrustScore(value) {
  const n = normaliseTrustScore(value);
  if (n === null) return 'low';
  const percent = n * 100;
  if (percent > 80) return 'high';
  if (percent > 50) return 'medium';
  return 'low';
}

module.exports = {
  QUANTITY_ORIGIN,
  NON_DERIVED_ORIGINS,
  TRUST_SCORE_SCALE,
  BLAST_RADIUS_KIND,
  BLAST_RADIUS_UNITS,
  ORIGIN_LABELS,
  defineQuantity,
  isDerived,
  normaliseTrustScore,
  formatTrustScore,
  bandTrustScore,
};
