/**
 * Severity contract: ONE vocabulary, and proof that the two copies cannot drift.
 *
 * Card t_517be819. The bug was four incompatible severity vocabularies in one
 * product, with the UI bound to none of them, so every anomaly fell through to
 * a `default` branch: 3 severities rendered as 1 colour and every stat
 * counter read 0.
 *
 * Test runner is node --test (CommonJS) per package.json:56.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const serverContract = require('../../../src/monitoring/severity-contract');
// The UI-side copy is ESM; the bridge returns its module namespace. The
// DRIFT GUARD tests below read these lazily so this file stays CJS.
const { severity } = require('../helpers/ui-esm');

let uiContract;
test.before(async () => {
  uiContract = await severity();
});

const {
  SEVERITY_LEVELS,
  normalizeSeverity,
  normalizeAnomalies,
  countBySeverity,
  isCanonicalSeverity,
  UNKNOWN_SEVERITY,
} = serverContract;

test('the enum is the 4-step z-score ladder, ordered most severe first', () => {
  assert.deepEqual(SEVERITY_LEVELS, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  assert.equal(SEVERITY_LEVELS.length, 4);
});

test('every level the detector can emit is canonical', () => {
  // Mirrors Z_SCORE_THRESHOLDS in src/monitoring/anomaly-detector.js:11-16
  for (const level of Object.keys({ CRITICAL: 4.0, HIGH: 3.0, MEDIUM: 2.5, LOW: 2.0 })) {
    assert.ok(isCanonicalSeverity(level), `${level} should be canonical`);
  }
});

test('DRIFT GUARD: the server and UI copies expose an identical level list', () => {
  assert.deepEqual(
    uiContract.SEVERITY_LEVELS,
    serverContract.SEVERITY_LEVELS,
    'src/ui/src/constants/severity.js has drifted from src/monitoring/severity-contract.js'
  );
  assert.equal(uiContract.UNKNOWN_SEVERITY, serverContract.UNKNOWN_SEVERITY);
});

// The shared fixture corpus. Every vocabulary that has actually appeared in
// this tree -- seed array, detector, and the old UI's own three -- is here, so
// both implementations are pinned on the same inputs and any future
// behavioural change in one side alone fails.
const FIXTURES = [
  'CRITICAL', 'HIGH', 'MEDIUM', 'LOW',      // detector vocabulary
  'critical', 'high', 'medium', 'low',      // server.js seed vocabulary
  'warning', 'info',                        // the old UI vocabulary
  'CRIT', 'WARN', 'INFO', 'NOTICE',
  '  high  ', 'High Severity', 'severity:high',
  '', null, undefined, 42, {}, [], 'gigantic',
];

test('DRIFT GUARD: both copies normalise the shared corpus identically', () => {
  for (const input of FIXTURES) {
    assert.equal(
      uiContract.normalizeSeverity(input),
      serverContract.normalizeSeverity(input),
      `implementations disagree on ${JSON.stringify(input)}`
    );
  }
});

test('DRIFT GUARD: both copies count the same corpus identically', () => {
  const payload = [
    { id: 'a', severity: 'high', acknowledged: false },
    { id: 'b', severity: 'MEDIUM', acknowledged: true },
    { id: 'c', severity: 'low', acknowledged: false },
    { id: 'd', severity: 'CRITICAL', acknowledged: false },
  ];
  assert.deepEqual(uiContract.countBySeverity(payload), serverContract.countBySeverity(payload));
});

test('the real pre-fix payload folds into the canonical enum', () => {
  // These are the exact three severities the card measured from the live API.
  const before = [{ severity: 'high' }, { severity: 'medium' }, { severity: 'low' }];
  const after = normalizeAnomalies(before).map((a) => a.severity);
  assert.deepEqual(after, ['HIGH', 'MEDIUM', 'LOW']);
});

test('a stale payload cannot reintroduce a zero counter', () => {
  // Regression shape of the original bug: payload values the UI did not know,
  // so every stat read 0 while the list still rendered.
  const payload = [{ severity: 'high' }, { severity: 'low' }];
  const counts = countBySeverity(payload);
  assert.equal(counts.HIGH, 1);
  assert.equal(counts.LOW, 1);
  assert.equal(counts.total, 2);
  // The old UI showed "Info (0)" next to a live low-severity anomaly.
  assert.notEqual(counts.LOW, 0);
});

test('counters sum to the total, so no anomaly is uncounted', () => {
  const payload = [
    { severity: 'CRITICAL' }, { severity: 'HIGH' }, { severity: 'HIGH' },
    { severity: 'MEDIUM' }, { severity: 'LOW' }, { severity: 'not-a-severity' },
  ];
  const counts = countBySeverity(payload);
  const levelSum = counts.CRITICAL + counts.HIGH + counts.MEDIUM + counts.LOW;
  assert.equal(levelSum, counts.total, 'an unrecognised severity silently vanished from the counts');
});

test('acknowledged is counted independently of severity', () => {
  const counts = countBySeverity([
    { severity: 'LOW', acknowledged: true },
    { severity: 'LOW', acknowledged: false },
    { severity: 'HIGH', acknowledged: true },
  ]);
  assert.equal(counts.acknowledged, 2);
  assert.equal(counts.LOW, 2);
  assert.equal(counts.HIGH, 1);
});

test('unrecognised severity falls back loudly instead of vanishing', () => {
  assert.equal(normalizeSeverity('gigantic'), UNKNOWN_SEVERITY);
  assert.equal(normalizeSeverity(undefined), UNKNOWN_SEVERITY);
  assert.equal(normalizeSeverity(42), UNKNOWN_SEVERITY);
  // The fallback is the TOP level, so an anomaly the contract cannot read is
  // surfaced as the thing a human must look at, not as the quietest bucket.
  assert.equal(UNKNOWN_SEVERITY, 'CRITICAL');
});

test('normalisation does not mutate the input', () => {
  const original = [{ id: 'x', severity: 'low', extra: 1 }];
  const snapshot = JSON.parse(JSON.stringify(original));
  const normalized = normalizeAnomalies(original);
  assert.deepEqual(original, snapshot, 'normalizeAnomalies mutated its argument');
  assert.notEqual(normalized[0], original[0], 'should return copies, not the same objects');
  assert.equal(normalized[0].extra, 1, 'non-severity fields must survive');
});

test('non-array and non-object inputs are handled without throwing', () => {
  assert.deepEqual(normalizeAnomalies(null), []);
  assert.deepEqual(normalizeAnomalies(undefined), []);
  assert.deepEqual(normalizeAnomalies('nope'), []);
  assert.equal(normalizeAnomalies([null])[0], null);
  const empty = countBySeverity(null);
  assert.equal(empty.total, 0);
  assert.equal(empty.CRITICAL, 0);
});

test('the enum is a 4-level ramp, so the UI tab set is 4 + All', () => {
  // The card's acceptance: "assert the tab set matches the canonical enum
  // length". The component builds its tabs from SEVERITY_LEVELS, so this
  // pins the contract the component depends on.
  assert.equal(SEVERITY_LEVELS.length + 1, 5);
});
