/**
 * The shared trust gauge's BAR DIRECTION (t_cf4bcef5).
 *
 * WHY THIS FILE EXISTS. One component, `components/TrustGauge.js`, serves
 * two screens with OPPOSITE vocabularies:
 *
 *   the AGENT screen    the value is a 0..100 TRUST score  (NHI)
 *   the OPERATOR screen  the value is a 0..1 ANOMALY score (OHI)
 *
 * The parent card (t_1980c9b1) inverted the operator screen's COLOUR --
 * correctly, because the scorer's score is an anomaly score (scorer/engine.py
 * holds at 0.7 and blocks at 0.9, so a HIGH recorded score is a BAD
 * operator). It left the BAR GEOMETRY pointing the old way, so the fill was
 * computed from the raw anomaly score:
 *
 *     const pct = ... (numeric / safeMax) * 100 ...
 *
 * The consequence: a BLOCKED operator (anomaly 0.95) drew a FULL red bar.
 * The bar's shape said "great operator" while its colour said "low trust",
 * and it said it differently from the agent screen -- where the SAME
 * component draws a full bar for a GOOD agent. One component, two screens,
 * the bar length meaning opposite things in each.
 *
 * EVERY PRE-EXISTING GUARD FOR THIS COMPONENT WAS A SOURCE-TEXT SCAN.
 * `operators-dashboard.test.js` asserted that TrustGauge.js CONTAINS
 * `entityKind === 'operator'`, contains success/warning/error, and has no
 * hex literal. `token-literals.test.js` scans for colour and length
 * literals. None of them can see the MEANING of a number, so the backwards
 * gauge shipped with the entire suite green. That is the lesson this file
 * is written against: assert the COMPUTED VALUE, not the source text.
 *
 * OPTION A was taken (see the card comment): the bar encodes TRUST in both
 * modes, so an operator's fill is `1 - anomaly`.
 *
 * These tests are BEHAVIOUR tests against the REAL component: the module is
 * loaded through helpers/ui-real-module.js (the real file, transformed to
 * CommonJS in memory with the real filename, so `node_modules` resolution
 * points at src/ui where react / @mui/material actually live) and rendered
 * with react-dom/server. The rendered bar's value is read out of the
 * markup MUI actually emits (`aria-valuenow` on the LinearProgress), not
 * out of the component's source.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadUiModule, UI_DIR } = require('../helpers/ui-real-module');

const React = require(path.join(UI_DIR, 'node_modules', 'react'));
const { renderToStaticMarkup } = require(path.join(UI_DIR, 'node_modules', 'react-dom', 'server'));

let gaugeModule = null;

test.before(() => {
  gaugeModule = loadUiModule('components/TrustGauge.js');
});

const { gaugeFillPercent } = gaugeModule;
const TrustGauge = gaugeModule.default;

/**
 * Render the REAL gauge and read the bar value MUI actually emitted.
 *
 * @param {object} props props for the gauge
 * @returns {number} the fill percentage the bar was rendered with
 */
const renderedBarValue = (props) => {
  const html = renderToStaticMarkup(React.createElement(TrustGauge, props));
  const match = html.match(/aria-valuenow="([0-9.]+)"/);
  assert.ok(match,
    `the rendered gauge carried no aria-valuenow -- the bar value cannot be `
    + `read, so this guard would be vacuous. Markup was:\n${html}`);
  return Number(match[1]);
};

// ─── The defect: the operator bar pointed the wrong way ────────────────────

test('OPERATOR: a higher anomaly score must NOT produce a fuller bar', () => {
  // The card's AC: "the 0.95-anomaly operator's bar is SMALLER than the
  // 0.05-anomaly operator's bar."
  const blocked = gaugeFillPercent(0.95, 1, 'operator');
  const clean = gaugeFillPercent(0.05, 1, 'operator');
  assert.ok(blocked < clean,
    `a BLOCKED operator (anomaly 0.95) drew a ${blocked}% bar and a clean `
    + `operator (anomaly 0.05) drew ${clean}% -- the bar points the wrong way`);
});

test('OPERATOR: the exact values the card names', () => {
  // Trust = 1 - anomaly, on the operator's own 0..1 scale.
  //
  // The tolerance is 1e-9 and it is there because `1 - 0.95` is
  // 0.050000000000000044 in binary floating point -- not because the value
  // is approximate. The arithmetic is deliberately NOT rounded: rounding the
  // RESULT would change the agent path's value for inputs like 1/3, and the
  // agent screen must be bit-for-bit what it was. MUI rounds for the DOM
  // attribute it emits (aria-valuenow="5"), so nothing downstream sees the
  // noise.
  const near = (actual, expected, what) => {
    assert.ok(Math.abs(actual - expected) <= 1e-9,
      `${what}: expected ~${expected}, got ${actual}`);
  };
  near(gaugeFillPercent(0.95, 1, 'operator'), 5, 'anomaly 0.95');
  near(gaugeFillPercent(0.05, 1, 'operator'), 95, 'anomaly 0.05');
  // The two ends of the scale.
  assert.equal(gaugeFillPercent(0, 1, 'operator'), 100,
    'an operator matching their baseline exactly is a FULL bar');
  assert.equal(gaugeFillPercent(1, 1, 'operator'), 0,
    'an operator every axis fired on is an EMPTY bar');
});

test('OPERATOR: the bar is monotonic in trust across the whole band range', () => {
  // Not just two points: the fill must DECREASE as the anomaly rises, at
  // every cut point the screen uses (0.4 medium floor, 0.7 low floor).
  const scores = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
  const fills = scores.map((s) => gaugeFillPercent(s, 1, 'operator'));
  for (let i = 1; i < fills.length; i += 1) {
    assert.ok(fills[i] <= fills[i - 1],
      `anomaly ${scores[i]} filled ${fills[i]}%, which is MORE than anomaly `
      + `${scores[i - 1]} at ${fills[i - 1]}% -- the bar is not monotonic`);
  }
});

test('OPERATOR: the rendered bar carries the inverted value', () => {
  // The unit test above asserts the exported function; this asserts the
  // RENDERED output, so the component cannot compute one thing and draw
  // another. It reads the value MUI actually emitted into the markup.
  const blocked = renderedBarValue({ value: 0.95, max: 1, band: 'low', entityKind: 'operator' });
  const clean = renderedBarValue({ value: 0.05, max: 1, band: 'high', entityKind: 'operator' });
  assert.ok(blocked < clean,
    `the RENDERED bars disagree with the direction: blocked=${blocked}%, `
    + `clean=${clean}%`);
  assert.equal(blocked, 5);
  assert.equal(clean, 95);
});

// ─── The agent screen must not flip ────────────────────────────────────────

test('AGENT: a higher trust score still fills the bar more', () => {
  // The shared component must not fix the operator screen by flipping the
  // agent screen. The agent's value IS a trust score, so the fill is the
  // score.
  const high = gaugeFillPercent(92, 100, 'agent');
  const mid = gaugeFillPercent(60, 100, 'agent');
  const low = gaugeFillPercent(20, 100, 'agent');
  assert.ok(high > mid, `agent trust 92 -> ${high}% must exceed trust 60 -> ${mid}%`);
  assert.ok(mid > low, `agent trust 60 -> ${mid}% must exceed trust 20 -> ${low}%`);
  assert.equal(gaugeFillPercent(92, 100, 'agent'), 92);
  assert.equal(gaugeFillPercent(0, 100, 'agent'), 0);
  assert.equal(gaugeFillPercent(100, 100, 'agent'), 100);
});

test('AGENT: the rendered bar still fills with the trust score', () => {
  const high = renderedBarValue({ value: 92, band: 'high', entityKind: 'agent' });
  const low = renderedBarValue({ value: 20, band: 'low', entityKind: 'agent' });
  assert.ok(high > low,
    `the RENDERED agent bars disagree with the direction: ${high}% vs ${low}%`);
  assert.equal(high, 92);
  assert.equal(low, 20);
});

test('AGENT: the fill is IDENTICAL to the pre-fix expression, value for value', () => {
  // "The agent screen is visually unchanged" -- the card's AC, and the
  // stated property of the shared-gauge refactor.
  //
  // The pre-fix implementation was, verbatim:
  //
  //     const numeric = Number(value);
  //     const safeMax = Number(max) > 0 ? Number(max) : 100;
  //     const pct = Number.isFinite(numeric)
  //       ? Math.min(100, Math.max(0, (numeric / safeMax) * 100))
  //       : 0;
  //
  // That expression is reproduced here as the reference. If the agent path
  // of the new implementation differs from it for ANY input -- including
  // the null / undefined / '' / NaN edges -- the agent screen has changed,
  // and this fails.
  const preFixAgentFill = (value, max = 100) => {
    const numeric = Number(value);
    const safeMax = Number(max) > 0 ? Number(max) : 100;
    return Number.isFinite(numeric)
      ? Math.min(100, Math.max(0, (numeric / safeMax) * 100))
      : 0;
  };

  const values = [
    0, 1, 20, 50, 60, 80, 81, 85, 92, 100,
    null, undefined, '', NaN, 'not-a-number', -10, 250,
  ];
  for (const value of values) {
    const before = preFixAgentFill(value);
    const after = gaugeFillPercent(value, 100, 'agent');
    assert.equal(after, before,
      `the agent fill changed for ${JSON.stringify(value)}: was ${before}, `
      + `now ${after} -- the agent screen must be visually unchanged`);
  }
});

// ─── The unreadable-score guard ────────────────────────────────────────────

test('an unreadable score renders an EMPTY bar, never a full one', () => {
  // Number(null) is 0 and Number('') is 0, so a missing score would coerce
  // to "no anomaly" and -- once inverted -- become a FULL bar. An absent
  // score is an unreadable score, not a zero score. This is the same
  // principle constants/operators.js bandForAnomalyScore already encodes
  // (an unreadable score bands as LOW, never HIGH).
  for (const kind of ['operator', 'agent']) {
    for (const value of [null, undefined, '', NaN, 'not-a-number']) {
      assert.equal(gaugeFillPercent(value, 1, kind), 0,
        `${kind} gauge drew a non-empty bar for ${JSON.stringify(value)}`);
    }
  }
});

test('the operator fill is clamped to the track', () => {
  // An anomaly outside 0..1 must not produce a bar that overflows the
  // track or renders negative.
  assert.equal(gaugeFillPercent(-0.5, 1, 'operator'), 100);
  assert.equal(gaugeFillPercent(1.5, 1, 'operator'), 0);
  assert.equal(gaugeFillPercent(-10, 100, 'agent'), 0);
  assert.equal(gaugeFillPercent(250, 100, 'agent'), 100);
});

// ─── The guard is not vacuous ──────────────────────────────────────────────

test('CONTROL: the assertions above CAN fail -- the direction is really tested', () => {
  // A guard that cannot fail reads as clean while the defect is live. This
  // is the pre-fix behaviour, asserted to be exactly what the new one
  // rejects: the OLD fill (raw anomaly score) is what the OPERATOR
  // assertion forbids.
  const preFixOperatorFill = (value, max = 1) => {
    const numeric = Number(value);
    const safeMax = Number(max) > 0 ? Number(max) : 100;
    return Number.isFinite(numeric)
      ? Math.min(100, Math.max(0, (numeric / safeMax) * 100))
      : 0;
  };
  assert.ok(preFixOperatorFill(0.95, 1) > preFixOperatorFill(0.05, 1),
    'the pre-fix implementation did NOT fill toward worse -- the reference '
    + 'the guard rejects is not the defect, so the guard is not testing it');

  // And the shipped implementation is the opposite of that reference.
  assert.ok(gaugeFillPercent(0.95, 1, 'operator') < gaugeFillPercent(0.05, 1, 'operator'),
    'the shipped operator fill still points toward worse');
});

test('CONTROL: the rendered-bar reader reads a real, differing value', () => {
  // If the reader always returned the same number, the rendered assertions
  // above would be vacuous. Feed it two known-different gauges.
  const a = renderedBarValue({ value: 0.95, max: 1, band: 'low', entityKind: 'operator' });
  const b = renderedBarValue({ value: 0.05, max: 1, band: 'high', entityKind: 'operator' });
  assert.notEqual(a, b);
});
