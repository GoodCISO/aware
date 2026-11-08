/**
 * Canonical anomaly-severity contract -- UI side.
 *
 * WHY THIS IS NOT A RE-EXPORT OF src/monitoring/severity-contract.js
 *
 * The obvious design is one file imported by both producers and consumers.
 * That is not buildable here, and the reason is a platform boundary, not a
 * preference:
 *
 *   - The UI is its own deployable (src/ui has its own package.json, its own
 *     node_modules, its own Dockerfile). It is built by react-scripts, whose
 *     ModuleScopePlugin HARD-REJECTS any import that resolves outside
 *     src/ui/src (webpack.config.js:339, allowedFiles = package.json +
 *     react-refresh/babel-runtime entries only). Verified in
 *     node_modules/react-scripts/config/webpack.config.js.
 *   - Putting the truth in src/monitoring/ and importing it upward from the UI
 *     fails the build ("You attempted to import ... which falls outside of the
 *     project src/ directory").
 *   - Putting the truth inside src/ui/src and requiring it from the server
 *     would invert the dependency: the server would break if the separate UI
 *     deployable were ever split out or removed.
 *
 * So the enum has to exist on both sides of a build boundary that forbids a
 * shared import. The duplication is therefore made SAFE rather than avoided:
 * this file and src/monitoring/severity-contract.js are held identical by
 * test/unit/monitoring/severity-contract.test.js, which compares the level
 * lists AND runs both implementations of normalizeSeverity over a shared
 * fixture corpus, requiring identical results. Drift fails CI.
 *
 * The bug this replaces (card t_517be819) was four vocabularies that nobody
 * noticed, because nothing compared them. The fixture corpus is the thing
 * that makes a divergence impossible to miss.
 *
 * The enum itself is the detector's 4-step z-score ladder, because the
 * detector is the real producer and the server.js seed array is stand-in data.
 * Order is most-severe-first and is load-bearing: the UI derives its filter
 * tab set and its stat counters from it, so the tab count cannot drift from
 * the enum length.
 *
 * ESM, not CommonJS, and that is load-bearing too. The server-side copy is
 * CJS because its consumers are. This copy is consumed by webpack under
 * react-scripts' strict ESM (webpack.config.js:392 'javascript/esm',
 * sideEffects:false), which does NOT apply Node's CJS named-export interop:
 * a CJS module here fails the production build with
 *   "Attempted import error: 'normalizeAnomalies' is not exported from
 *    '../constants/severity'"
 * even though every `node --test` assertion against it passes. Verified by
 * running the real build. So the module shape differs by design and only the
 * BEHAVIOUR is required to match -- which is exactly what the drift guard
 * asserts.
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
 * Case-fold any severity to its canonical form. Handles the vocabularies
 * actually present in this tree ('high', 'HIGH', 'warning', 'info', ...) plus
 * a tolerant fallback, so a payload from a different deploy degrades to the
 * documented fallback rather than to a wrong colour and a 0 counter.
 *
 * @param {unknown} value
 * @returns {string} one of SEVERITY_LEVELS, or UNKNOWN_SEVERITY
 */
function normalizeSeverity(value) {
  if (value === null || value === undefined) return UNKNOWN_SEVERITY;
  if (typeof value !== 'string') return UNKNOWN_SEVERITY;

  const key = value.trim().toUpperCase();

  if (SEVERITY_SET.has(key)) return key;

  const stripped = key.replace(/^SEVERITY[:\s_-]+/, '').replace(/[\s_-]*SEVERITY$/, '');
  if (SEVERITY_SET.has(stripped)) return stripped;
  if (stripped === 'CRIT') return 'CRITICAL';
  if (stripped === 'WARN') return 'MEDIUM';
  if (stripped === 'INFO' || stripped === 'NOTICE') return 'LOW';

  return UNKNOWN_SEVERITY;
}

/** Normalise one anomaly record (shallow copy; other fields untouched). */
function normalizeAnomaly(anomaly) {
  if (!anomaly || typeof anomaly !== 'object') return anomaly;
  return { ...anomaly, severity: normalizeSeverity(anomaly.severity) };
}

/** Normalise a list of anomalies. */
function normalizeAnomalies(anomalies) {
  if (!Array.isArray(anomalies)) return [];
  return anomalies.map(normalizeAnomaly);
}

/**
 * Count anomalies per canonical level. Every level the API can emit has a
 * counter, and every counter is computed from the NORMALISED value rather than
 * from a string the UI happens to guess at -- which is what fixes the
 * "Info (0)" tab that shipped a real low-severity anomaly as unfilterable.
 *
 * @param {Array} anomalies
 * @returns {{CRITICAL:number, HIGH:number, MEDIUM:number, LOW:number, total:number, acknowledged:number}}
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

/** @returns {boolean} true if the value is one of the canonical levels. */
function isCanonicalSeverity(value) {
  return typeof value === 'string' && SEVERITY_SET.has(value.trim().toUpperCase());
}

export {
  SEVERITY_LEVELS,
  SEVERITY_RANK,
  UNKNOWN_SEVERITY,
  normalizeSeverity,
  normalizeAnomaly,
  normalizeAnomalies,
  countBySeverity,
  isCanonicalSeverity,
};

export default {
  SEVERITY_LEVELS,
  SEVERITY_RANK,
  UNKNOWN_SEVERITY,
  normalizeSeverity,
  normalizeAnomaly,
  normalizeAnomalies,
  countBySeverity,
  isCanonicalSeverity,
};
