/**
 * The vendored CIEDE2000 metric is itself validated (card t_4e9cb292).
 *
 * The severity ramp's header comment quotes a dE00 figure. Before this, that
 * figure was COMMENT-ONLY — the ramp's tokens could change and the number
 * would keep asserting itself, with every guard still green. The fix is to
 * make the figure re-derivable (test/unit/helpers/ciede2000.js) and then
 * assert it (test/unit/ui/severity-ramp.test.js).
 *
 * But a re-derivation is only worth as much as the implementation that
 * produces it. A CIEDE2000 that never normalises hue to [0,360) silently
 * zeroes the R_T rotation term for any pair with negative b* — exactly what a
 * cyan ramp consists of — and UNDER-reports dE00 by a wide margin on precisely
 * the pairs a single-hue ramp is optimised over. The number stays plausible
 * and nothing flags it. That is not hypothetical: it is how this ramp's figure
 * read 6.1 when the real value is 6.44.
 *
 * So this file checks the metric against PUBLISHED reference data
 * (Sharma, Wu & Dalal 2005, Table 1), and it checks that the check can
 * reject: the known-broken hue implementation is kept alongside the good one
 * and is REQUIRED to fail the corpus. A gate that has never been seen failing
 * is decoration.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CIEDE2000_CORPUS,
  ciede2000,
  ciede2000HueNotNormalised,
  validateAgainstCorpus,
} = require('../helpers/ciede2000');

test('the reference corpus is the published Sharma/Wu/Dalal Table 1 data', () => {
  // If the corpus is ever truncated to make a failing implementation pass,
  // this fails first. 35 entries: 34 published rows, of which 33 are active
  // (the published transcription comments out (50,0.001,-2.49)), plus that
  // de-commented row whose expected value was independently confirmed
  // correct (4.8045).
  assert.equal(CIEDE2000_CORPUS.length, 35,
    'the published corpus was resized; quote the count you counted');
  for (const [a, b, want] of CIEDE2000_CORPUS) {
    assert.equal(a.length, 3, 'every corpus entry is a Lab triple');
    assert.equal(b.length, 3, 'every corpus entry is a Lab triple');
    assert.equal(typeof want, 'number', 'every corpus entry carries an expected dE00');
  }
});

test('the vendored CIEDE2000 passes every published reference pair', () => {
  const result = validateAgainstCorpus(ciede2000);
  assert.equal(result.failures.length, 0,
    `the vendored CIEDE2000 fails ${result.failures.length} of ${result.total} `
    + `published reference pairs — its figures are not trustworthy:\n`
    + result.failures.slice(0, 5)
      .map((f) => `  pair ${f.index + 1}: want ${f.want}, got ${f.got?.toFixed?.(6)}`)
      .join('\n'));
  assert.equal(result.pass, 35);
});

test('the corpus check can REJECT — the known-broken hue implementation fails it', () => {
  // The harness's own claim to work rests on being able to reject. If this
  // ever goes green, the corpus check has stopped being a check.
  const result = validateAgainstCorpus(ciede2000HueNotNormalised);
  assert.ok(result.failures.length >= 30,
    `the known-broken hue implementation passed ${result.pass}/${result.total} corpus `
    + 'pairs; the corpus is no longer able to reject the failure mode it exists to catch');
  assert.ok(result.pass < result.total,
    'the known-broken implementation must not pass the corpus');
});

test('the good and broken implementations DISAGREE, and the broken one reproduces the wrong figure', () => {
  // A control that only exercises easy inputs cannot catch an error that only
  // fires on the hard case. The bug in the broken implementation lives in the
  // hue-rotation term, so the control pair must be one where the two hues
  // cancel — a same-hue pair with negative b*, which is what a cyan ramp is.
  //
  // The control is anchored on a FACT about this repo, not on an arbitrary
  // threshold: the ramp's comment read "dE00 6.1" for years, and the broken
  // implementation is what produced it. If the broken implementation still
  // lands on 6.1 for this pair, then (a) the two implementations genuinely
  // disagree on the pair the ramp cares about, and (b) the corpus failure
  // mode is the one that produced the historical wrong number.
  const lab1 = [80.1327, -31.5656, -25.4358];   // MEDIUM #33d9f5
  const lab2 = [88.3159, -27.8062, -18.1254];   // HIGH   #7deeff
  const good = ciede2000(lab1, lab2);
  const bad = ciede2000HueNotNormalised(lab1, lab2);

  assert.ok(Math.abs(good - bad) > 0.1,
    `the two implementations agree to ${Math.abs(good - bad).toFixed(4)} on a `
    + 'same-hue pair; the control does not span the axis the metric is sensitive to');
  assert.ok(bad < good,
    'the broken implementation under-reports on same-hue pairs, which is the '
    + 'failure mode that produced this ramp\'s wrong 6.1 figure');
  assert.ok(Math.abs(bad - 6.1) <= 0.05,
    `the broken implementation gives ${bad.toFixed(4)} for this pair, which no `
    + 'longer reproduces the historical "6.1" figure. If this starts failing, '
    + 'the control has drifted from the failure mode it exists to demonstrate.');
});

