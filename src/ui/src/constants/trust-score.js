// src/ui/src/constants/trust-score.js
//
// Trust-score unit handling for the UI.
//
// WHY THIS FILE EXISTS
// --------------------
// The stored trust score is a FRACTION in [0,1] — that is the unit in
// `src/api/models/Agent.js`, in the JWT claim, in the seed data
// (`src/data/agents.json`), and in the routing consumer.
//
// The UI treated it as 0..100: it banded at >80 / >50 and rendered
// `{agent.trustScore}/100`. A stored 0.85 therefore displayed as
// "0.85/100" and banded as "low" — a fully trusted agent looked untrusted.
//
// The conversion lives here, in one place, so the two scales cannot diverge
// again. The display thresholds are unchanged (>80 high, >50 medium, else
// low) — they are now applied to the PERCENT scale, which is what they were
// always meant to mean.
//
// This file duplicates `normaliseTrustScore` / `formatTrustScore` /
// `bandTrustScore` from `src/governance/quantity.js` because the UI is a
// separate webpack build that cannot import CommonJS from outside
// `src/ui/`. The duplication is deliberate and bounded: the canonical unit
// and the thresholds are asserted equal by
// `test/unit/governance/trust-score-parity.test.js`.

/** Canonical stored unit: a fraction in [0,1]. */
export const TRUST_SCORE_SCALE_UNIT = 'unit';

/**
 * Normalise a trust score to the canonical [0,1] unit.
 *
 * Accepts either unit so that a legacy 0..100 value cannot silently be read
 * as a fraction. A value strictly greater than 1 is interpreted as a percent
 * value and divided by 100.
 *
 * @param {number|null|undefined} value
 * @returns {number|null} A value in [0,1], or null if not a finite number.
 */
export const normaliseTrustScore = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1) {
    return Math.max(0, Math.min(1, n / 100));
  }
  return Math.max(0, Math.min(1, n));
};

/**
 * Format a trust score for display as a percentage.
 *
 * @param {number|null|undefined} value
 * @returns {string} e.g. '85%', or '—' when the value is absent.
 */
export const formatTrustScore = (value) => {
  const n = normaliseTrustScore(value);
  if (n === null) return '—';
  return `${Math.round(n * 100)}%`;
};

/**
 * Band a trust score for display.
 *
 * Thresholds are the ones AgentIdentityDashboard.js has always used
 * (>80 high, >50 medium, else low), applied to the PERCENT scale.
 *
 * @param {number|null|undefined} value
 * @returns {'high'|'medium'|'low'}
 */
export const bandTrustScore = (value) => {
  const n = normaliseTrustScore(value);
  if (n === null) return 'low';
  const percent = n * 100;
  if (percent > 80) return 'high';
  if (percent > 50) return 'medium';
  return 'low';
};
