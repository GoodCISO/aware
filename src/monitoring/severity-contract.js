/**
 * Canonical anomaly-severity contract.
 *
 * ONE vocabulary, shared by every producer and every consumer. Before this
 * module the product had four incompatible severity vocabularies (card
 * t_517be819):
 *
 *   1. src/server.js seed array            -> 'high' | 'medium' | 'low'  (lowercase)
 *   2. src/monitoring/anomaly-detector.js  -> 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
 *   3. src/api/routes/metrics.js           -> { anomalies, count } envelope, own shape
 *   4. src/ui AnomalyDetectionAlerts.js    -> 'critical' | 'warning' | 'info'
 *
 * The UI was bound to none of them, so every anomaly fell through to the
 * `default` branch of the switch: 3 severities rendered as 1 colour and every
 * stat counter read 0.
 *
 * The enum is the detector's 4-step z-score ladder, because the detector is
 * the real producer and the server.js seed array is stand-in data. Producers
 * normalise on the way in; the UI normalises on the way in too, so a payload
 * written by an older deploy cannot silently reintroduce the bug.
 *
 * CommonJS on purpose: src/server.js and the node --test suite are CJS. The UI
 * CANNOT import this file -- react-scripts' ModuleScopePlugin rejects imports
 * resolving outside src/ui/src, and the UI is a separate deployable. The
 * mirrored UI-side copy is src/ui/src/constants/severity.js, and
 * test/unit/monitoring/severity-contract.test.js runs both implementations
 * over a shared fixture corpus and requires identical results, so the
 * duplication cannot drift. Full rationale in the UI-side file.
 */

'use strict';

/**
 * Severity levels, ordered most severe first. The array ORDER is the
 * ordinal order and is load-bearing: the UI derives its filter tab set from
 * it, so the number of tabs always equals the number of levels.
 */
const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const SEVERITY_SET = new Set(SEVERITY_LEVELS);

/** Rank for ordering: lower = more severe. */
const SEVERITY_RANK = SEVERITY_LEVELS.reduce((acc, level, i) => {
  acc[level] = i;
  return acc;
}, Object.create(null));

/**
 * Unrecognised values must not silently vanish. The pre-fix bug was exactly
 * that: an unknown severity became a default-coloured card with a 0 counter.
 * Callers get an explicit fallback so the count is still truthful.
 */
const UNKNOWN_SEVERITY = 'CRITICAL';

/**
 * Case-fold any severity to its canonical form.
 *
 * Handles the three vocabularies actually in the tree ('high', 'HIGH',
 * 'high severity', 'error'/'warn' aliases) plus a tolerant fallback for
 * anything unrecognised. Returns the canonical UPPERCASE level.
 *
 * @param {unknown} value
 * @returns {string} one of SEVERITY_LEVELS, or UNKNOWN_SEVERITY
 */
function normalizeSeverity(value) {
  if (value === null || value === undefined) return UNKNOWN_SEVERITY;
  if (typeof value !== 'string') return UNKNOWN_SEVERITY;

  const key = value.trim().toUpperCase();

  // Already canonical.
  if (SEVERITY_SET.has(key)) return key;

  // Tolerate decorated forms: 'high severity', 'severity:high', 'crit'.
  const stripped = key.replace(/^SEVERITY[:\s_-]+/, '').replace(/[\s_-]*SEVERITY$/, '');
  if (SEVERITY_SET.has(stripped)) return stripped;
  if (stripped === 'CRIT') return 'CRITICAL';
  if (stripped === 'WARN') return 'MEDIUM';
  if (stripped === 'INFO' || stripped === 'NOTICE') return 'LOW';

  return UNKNOWN_SEVERITY;
}

/**
 * Normalise one anomaly record's severity in place-safe fashion (returns a
 * shallow copy) and leave every other field untouched.
 */
function normalizeAnomaly(anomaly) {
  if (!anomaly || typeof anomaly !== 'object') return anomaly;
  return { ...anomaly, severity: normalizeSeverity(anomaly.severity) };
}

/**
 * Normalise a list of anomalies.
 */
function normalizeAnomalies(anomalies) {
  if (!Array.isArray(anomalies)) return [];
  return anomalies.map(normalizeAnomaly);
}

/**
 * Count anomalies per canonical level.
 *
 * Returned shape is keyed by canonical level with no legacy keys, which is
 * what fixes the "Info (0)" tab: every level the API can emit now has a
 * counter, and every counter is computed from the normalised value rather
 * than from a string the UI happens to guess at.
 *
 * @param {Array} anomalies
 * @returns {{ CRITICAL: number, HIGH: number, MEDIUM: number, LOW: number, total: number, acknowledged: number }}
 */
function countBySeverity(anomalies) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, total: 0, acknowledged: 0 };
  if (!Array.isArray(anomalies)) return counts;

  for (const anomaly of anomalies) {
    counts.total += 1;
    const severity = normalizeSeverity(anomaly && anomaly.severity);
    if (counts[severity] !== undefined) counts[severity] += 1;
    if (anomaly && anomaly.acknowledged) counts.acknowledged += 1;
  }
  return counts;
}

/**
 * @returns {boolean} true if the value is one of the canonical levels.
 */
function isCanonicalSeverity(value) {
  return typeof value === 'string' && SEVERITY_SET.has(value.trim().toUpperCase());
}

module.exports = {
  SEVERITY_LEVELS,
  SEVERITY_RANK,
  UNKNOWN_SEVERITY,
  normalizeSeverity,
  normalizeAnomaly,
  normalizeAnomalies,
  countBySeverity,
  isCanonicalSeverity,
};
