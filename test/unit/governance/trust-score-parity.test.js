// test/unit/governance/trust-score-parity.test.js
//
// PARITY between the two copies of the trust-score unit contract.
//
// WHY THIS TEST EXISTS
// --------------------
// src/ui/src/constants/trust-score.js and src/governance/quantity.js each
// implement normaliseTrustScore / formatTrustScore / bandTrustScore. The
// duplication is DELIBERATE and forced by a build boundary: the UI is its
// own webpack build, and react-scripts' ModuleScopePlugin hard-rejects any
// import that resolves outside src/ui/src, so the UI cannot import the
// CommonJS module from src/governance/. (The same boundary is documented in
// src/ui/src/constants/severity.js.)
//
// A duplication that nothing checks is a divergence waiting to happen: the
// two copies can drift on the UNIT, on the THRESHOLDS, or on an edge case,
// and nothing would notice until the UI banded an agent differently from
// the server that produced the value. The comment in the UI copy CLAIMS this
// guard exists. This file is that guard.
//
// WHAT IS ASSERTED
// ----------------
//  1. The canonical unit is the same on both sides ('unit' - a fraction in
//     [0,1] - not 'percent').
//  2. The three functions return IDENTICAL results for every input in a
//     dense matrix: the absent values, the non-numeric values, both scales,
//     and the negatives.
//  3. The thresholds are IDENTICAL and are the documented ones: >80 high,
//     >50 medium, else low, applied to the PERCENT scale of a [0,1] value.
//     The transition points are pinned at 0.50/0.51 and 0.80/0.81 so a
//     threshold cannot drift silently in EITHER copy.
//
// The comparison is BEHAVIOURAL, not textual: it calls both implementations
// and compares what they return. A textual comparison would pass while a
// copy computed the right answer for the wrong reason (or the wrong answer
// for a case the scan did not enumerate).
//
// SEE ALSO
//   src/ui/src/constants/trust-score.js
//   src/governance/quantity.js
//   test/unit/governance/quantity.test.js
//   test/unit/ui/operators-dashboard.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');

// The server-side copy: CommonJS, under src/governance/.
const gov = require(path.join(REPO_ROOT, 'src/governance/quantity.js'));

// The UI-side copy: ESM under src/ui/src (react-scripts' webpack applies no
// Node CommonJS named-export interop -- see test/unit/helpers/ui-esm.js for
// why the shim exists). A dynamic import() from this CommonJS test file
// reaches the REAL module, not a re-implementation: if the file were absent
// or unparseable the import would throw and every test here would fail.
// That is deliberate -- a parity test that silently fell back to a local
// copy would compare a thing against itself.
const UI_MODULE_PATH = path.join(REPO_ROOT, 'src/ui/src/constants/trust-score.js');

let ui;
const loadUi = async () => {
  if (!ui) {
    ui = await import(`file://${UI_MODULE_PATH}`);
  }
  return ui;
};

// ─── The input matrix ───────────────────────────────────────────────────────

/**
 * Every input worth comparing, in one place.
 *
 * The list is deliberately shaped around the edges that a trust score can
 * land on:
 *   - the ABSENT values (null / undefined / ''), which both copies must
 *     turn into null rather than into a zero-score agent;
 *   - the NON-NUMERIC values, which must not silently become 0;
 *   - the BOUNDARIES of both band thresholds;
 *   - BOTH SCALES, because the stored unit is [0,1] and a legacy 0..100
 *     value is still accepted and normalised;
 *   - the values BELOW zero and ABOVE one that the normaliser clamps.
 */
const INPUTS = [
  null,
  undefined,
  '',
  NaN,
  Infinity,
  -Infinity,
  'not-a-number',
  '0.85',
  0,
  0.001,
  0.5,
  0.51,
  0.8,
  0.81,
  0.85,
  0.999,
  1,
  50,
  51,
  80,
  81,
  85,
  100,
  -1,
  2,
  150,
];

// ─── The unit ───────────────────────────────────────────────────────────────

test('both copies declare the SAME canonical unit: the fraction, not the percent', async () => {
  const uiMod = await loadUi();
  assert.equal(uiMod.TRUST_SCORE_SCALE_UNIT, 'unit');
  assert.equal(gov.TRUST_SCORE_SCALE.UNIT, 'unit');
  assert.equal(uiMod.TRUST_SCORE_SCALE_UNIT, gov.TRUST_SCORE_SCALE.UNIT);
  // 'percent' is the LEGACY display scale and is never the stored unit.
  assert.equal(gov.TRUST_SCORE_SCALE.PERCENT, 'percent');
  assert.notEqual(uiMod.TRUST_SCORE_SCALE_UNIT, gov.TRUST_SCORE_SCALE.PERCENT);
});

// ─── Behavioural parity ─────────────────────────────────────────────────────

test('normaliseTrustScore agrees on every input in the matrix', async () => {
  const uiMod = await loadUi();
  for (const value of INPUTS) {
    assert.equal(
      uiMod.normaliseTrustScore(value),
      gov.normaliseTrustScore(value),
      `normaliseTrustScore diverged on ${JSON.stringify(value)} ` +
        `(ui=${uiMod.normaliseTrustScore(value)}, gov=${gov.normaliseTrustScore(value)})`
    );
  }
});

test('formatTrustScore agrees on every input in the matrix', async () => {
  const uiMod = await loadUi();
  for (const value of INPUTS) {
    assert.equal(
      uiMod.formatTrustScore(value),
      gov.formatTrustScore(value),
      `formatTrustScore diverged on ${JSON.stringify(value)} ` +
        `(ui=${uiMod.formatTrustScore(value)}, gov=${gov.formatTrustScore(value)})`
    );
  }
});

test('bandTrustScore agrees on every input in the matrix', async () => {
  const uiMod = await loadUi();
  for (const value of INPUTS) {
    assert.equal(
      uiMod.bandTrustScore(value),
      gov.bandTrustScore(value),
      `bandTrustScore diverged on ${JSON.stringify(value)} ` +
        `(ui=${uiMod.bandTrustScore(value)}, gov=${gov.bandTrustScore(value)})`
    );
  }
});

test('the two copies agree on a DENSE sweep, not only on the enumerated edges', async () => {
  // The matrix above pins the interesting points. This sweep checks the
  // space BETWEEN them, so a copy whose threshold moved by a fraction of a
  // percent is still caught.
  const uiMod = await loadUi();
  for (let i = 0; i <= 1000; i += 1) {
    const value = i / 1000;
    assert.equal(uiMod.normaliseTrustScore(value), gov.normaliseTrustScore(value), `normalise diverged at ${value}`);
    assert.equal(uiMod.formatTrustScore(value), gov.formatTrustScore(value), `format diverged at ${value}`);
    assert.equal(uiMod.bandTrustScore(value), gov.bandTrustScore(value), `band diverged at ${value}`);
  }
});

// ─── The thresholds ─────────────────────────────────────────────────────────
//
// Pinned on BOTH copies, so the threshold cannot drift in one copy (caught
// by the parity tests above) NOR in both copies at once (caught here).

test('both copies band >80 percent as HIGH', async () => {
  const uiMod = await loadUi();
  for (const [uiValue, govValue] of [[0.81, 81], [0.85, 85], [1, 100]]) {
    assert.equal(uiMod.bandTrustScore(uiValue), 'high');
    assert.equal(gov.bandTrustScore(govValue), 'high');
  }
});

test('both copies band exactly 80 percent as MEDIUM, not high', async () => {
  const uiMod = await loadUi();
  assert.equal(uiMod.bandTrustScore(0.8), 'medium');
  assert.equal(uiMod.bandTrustScore(0.8), 'medium');
  assert.equal(gov.bandTrustScore(80), 'medium');
  assert.equal(gov.bandTrustScore(0.8), 'medium');
});

test('both copies band >50 percent as MEDIUM', async () => {
  const uiMod = await loadUi();
  for (const [uiValue, govValue] of [[0.51, 51], [0.7, 70], [0.8, 80]]) {
    assert.equal(uiMod.bandTrustScore(uiValue), 'medium');
    assert.equal(gov.bandTrustScore(govValue), 'medium');
  }
});

test('both copies band exactly 50 percent as LOW, not medium', async () => {
  const uiMod = await loadUi();
  assert.equal(uiMod.bandTrustScore(0.5), 'low');
  assert.equal(uiMod.bandTrustScore(0.5), 'low');
  assert.equal(gov.bandTrustScore(50), 'low');
  assert.equal(gov.bandTrustScore(0.5), 'low');
});

test('both copies band at or below 50 percent as LOW', async () => {
  const uiMod = await loadUi();
  for (const [uiValue, govValue] of [[0, 0], [0.25, 25], [0.5, 50]]) {
    assert.equal(uiMod.bandTrustScore(uiValue), 'low');
    assert.equal(gov.bandTrustScore(govValue), 'low');
  }
});

test('the thresholds are applied to the PERCENT scale of a [0,1] value', async () => {
  // The bug this guard exists to prevent: a stored 0.85 banded as 'low'
  // because the threshold was read against the raw fraction. Both copies
  // must band the stored form as HIGH, and the legacy 0..100 form the same.
  const uiMod = await loadUi();
  assert.equal(uiMod.bandTrustScore(0.85), 'high');
  assert.equal(gov.bandTrustScore(0.85), 'high');
  assert.equal(uiMod.bandTrustScore(0.85), gov.bandTrustScore(85));
});

// ─── The absent value ───────────────────────────────────────────────────────
//
// A missing trust score must NOT read as a score of zero. If one copy
// returned '0%' and the other '—', an untrusted agent would appear as a
// zero-trust agent in one surface and as no agent in the other.

test('both copies render an absent trust score as the same dash, not as 0%', async () => {
  const uiMod = await loadUi();
  for (const value of [null, undefined, '', NaN, 'not-a-number', Infinity]) {
    assert.equal(uiMod.formatTrustScore(value), '—');
    assert.equal(gov.formatTrustScore(value), '—');
    assert.equal(uiMod.normaliseTrustScore(value), null);
    assert.equal(gov.normaliseTrustScore(value), null);
  }
});
