/**
 * Severity ramp: contrast, monotonicity, and distinctness.
 *
 * These are the card's own acceptance criteria (t_517be819), recomputed from
 * the committed tokens rather than asserted by hand:
 *   - the 4 severities map to 4 DISTINCT colours
 *   - every level clears the WCAG 2.x SC 1.4.11 3:1 non-text floor on BOTH
 *     AWARE surfaces (these render as a 4px card border)
 *   - contrast is strictly monotonic CRITICAL -> LOW, so the ORDINAL ordering
 *     survives greyscale, forced-colors mode, and dichromatic vision
 *
 * The colour maths is implemented here rather than pulled from a dependency:
 * the project has no colour package, and a test that silently skips when a
 * helper is missing is worse than no test.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SEVERITY_LEVELS } = require('../../../src/monitoring/severity-contract');
// The UI-side modules are ESM (webpack under react-scripts has no CJS interop),
// so they are pulled in through the test-only bridge. See helpers/ui-esm.js.
const { severityRamp } = require('../helpers/ui-esm');
// The dE00 metric, vendored (no dependency) and validated against the
// published Sharma/Wu/Dalal corpus in ciede2000.test.js.
const { ciede2000, hexToLab } = require('../helpers/ciede2000');
const fs = require('node:fs');
const path = require('node:path');

// Must match theme.js background tokens -- the surfaces the border sits on.
const BG_DEFAULT = '#0a1929';
const BG_PAPER = '#132f4c';
const MIN_NON_TEXT_CONTRAST = 3.0;

let SEVERITY_RAMP;
test.before(async () => {
  ({ SEVERITY_RAMP } = await severityRamp());
});

// ---- WCAG 2.x relative luminance + contrast ----
const hexToRgb = (hex) => {
  const s = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`bad hex: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const relLuminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const l1 = relLuminance(a);
  const l2 = relLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

// ---- sRGB -> CIELAB (D65), for L* reporting ----
const rgbToLab = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  const X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / 0.95047);
  const fy = f(Y / 1.0);
  const fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

test('the ramp has one colour per canonical level', () => {
  assert.deepEqual(Object.keys(SEVERITY_RAMP).sort(), [...SEVERITY_LEVELS].sort());
});

test('the 4 severities map to 4 DISTINCT colours (the card core symptom)', () => {
  const values = SEVERITY_LEVELS.map((l) => SEVERITY_RAMP[l]);
  assert.equal(new Set(values).size, 4,
    `expected 4 distinct colours, got ${new Set(values).size}: ${values.join(', ')}`);
});

test('every level clears 3:1 non-text contrast on BOTH surfaces', () => {
  for (const level of SEVERITY_LEVELS) {
    const c = SEVERITY_RAMP[level];
    const onDefault = contrast(c, BG_DEFAULT);
    const onPaper = contrast(c, BG_PAPER);
    const worst = Math.min(onDefault, onPaper);
    assert.ok(worst >= MIN_NON_TEXT_CONTRAST,
      `${level} ${c} is ${onDefault.toFixed(2)}:1 on default and ${onPaper.toFixed(2)}:1 on paper; ` +
      `worst is ${worst.toFixed(2)}:1, below the ${MIN_NON_TEXT_CONTRAST}:1 floor`);
  }
});

test('contrast is strictly monotonic CRITICAL -> LOW (the ordinal channel)', () => {
  const ratios = SEVERITY_LEVELS.map((l) => contrast(SEVERITY_RAMP[l], BG_DEFAULT));
  for (let i = 0; i + 1 < ratios.length; i++) {
    assert.ok(ratios[i] > ratios[i + 1],
      `${SEVERITY_LEVELS[i]} (${ratios[i].toFixed(2)}:1) must be MORE prominent than ` +
      `${SEVERITY_LEVELS[i + 1]} (${ratios[i + 1].toFixed(2)}:1); ordinal ramps need monotonic lightness`);
  }
});

test('lightness is monotonic, so the ramp reads as a ramp in greyscale', () => {
  const lstar = SEVERITY_LEVELS.map((l) => rgbToLab(SEVERITY_RAMP[l])[0]);
  for (let i = 0; i + 1 < lstar.length; i++) {
    assert.ok(lstar[i] > lstar[i + 1],
      `${SEVERITY_LEVELS[i]} L* ${lstar[i].toFixed(1)} must exceed ${SEVERITY_LEVELS[i + 1]} L* ${lstar[i + 1].toFixed(1)}`);
  }
});

test('CRITICAL is the most prominent level and LOW the least', () => {
  const critical = contrast(SEVERITY_RAMP.CRITICAL, BG_DEFAULT);
  const low = contrast(SEVERITY_RAMP.LOW, BG_DEFAULT);
  assert.ok(critical > low, 'CRITICAL must outrank LOW on prominence');
});

test('measured figures match the ones documented in severityRamp.js', () => {
  // The header comment quotes these; this pins them so the comment cannot
  // drift away from the committed values. Tolerance is tight (0.05) because
  // these are deterministic functions of the committed hex values.
  const EXPECTED = {
    CRITICAL: { default: 16.83, paper: 12.95, lstar: 97.9 },
    HIGH: { default: 13.13, paper: 10.10, lstar: 88.3 },
    MEDIUM: { default: 10.46, paper: 8.05, lstar: 80.1 },
    LOW: { default: 6.31, paper: 4.86, lstar: 63.6 },
  };
  for (const level of SEVERITY_LEVELS) {
    const c = SEVERITY_RAMP[level];
    const got = {
      default: contrast(c, BG_DEFAULT),
      paper: contrast(c, BG_PAPER),
      lstar: rgbToLab(c)[0],
    };
    const want = EXPECTED[level];
    assert.ok(Math.abs(got.default - want.default) <= 0.05,
      `${level} contrast on default is ${got.default.toFixed(2)}, documented as ${want.default}`);
    assert.ok(Math.abs(got.paper - want.paper) <= 0.05,
      `${level} contrast on paper is ${got.paper.toFixed(2)}, documented as ${want.paper}`);
    assert.ok(Math.abs(got.lstar - want.lstar) <= 0.05,
      `${level} L* is ${got.lstar.toFixed(1)}, documented as ${want.lstar}`);
  }
});

test('no severity token aliases a semantic palette colour it must not merge with', () => {
  // WHY THIS SHAPE (a prior version of this guard named the same principle
  // but hardcoded two hexes -- PRIMARY_MAIN and MUI_INFO -- so it could only
  // ever catch those two. PROVEN: repointing LOW at error.main (#ff1744) left
  // this test green while a different test went red. The principle is what we
  // are guarding, so the principle is what gets asserted: no severity step may
  // share a colour with ANY other palette entry, wherever that colour lives.
  //
  // TWO TRAPS that made the earlier rewrite unfailable, both avoided here:
  //   1. A Map<value, owner> COLLAPSES duplicates -- the second owner silently
  //      overwrites the first, so the exact collision this guard hunts becomes
  //      invisible. Map<string, string[]> keeps every owner.
  //   2. Exempting on owner.startsWith('severity.') is a no-op on this theme,
  //      because theme.palette.severity IS a palette slot -- every severity
  //      value would be exempt and the guard could never fail. The exemption is
  //      therefore scoped to the specific owner, not the prefix.
  const { realTheme, paletteColours } = require('../helpers/ui-real-theme');
  const palette = realTheme().palette;

  // value (lowercased) -> every owner that publishes it. Arrays, not strings:
  // a duplicate is the bug, so it must not be collapsed.
  const ownersByValue = new Map();
  for (const { owner, value } of paletteColours(palette)) {
    const key = value.toLowerCase();
    if (!ownersByValue.has(key)) ownersByValue.set(key, []);
    ownersByValue.get(key).push(owner);
  }

  for (const level of SEVERITY_LEVELS) {
    const colour = SEVERITY_RAMP[level];
    const owners = ownersByValue.get(colour.toLowerCase()) || [];
    // A severity step legitimately owns itself. Anything ELSE publishing the
    // same colour is a merge of two meanings into one token.
    const foreignOwners = owners.filter((o) => o !== `severity.${level}`);
    assert.deepEqual(foreignOwners, [],
      `${level} is ${colour}, which is also published by ${foreignOwners.join(', ')}. ` +
      'A severity step that shares a colour with a semantic token merges two ' +
      'meanings into one; give it its own colour instead.');
  }
});

test('the semantic palette the guard walks is the REAL one, not a copy', () => {
  // The guard above is only as good as the palette it walks. Pin the load path
  // so a future refactor cannot quietly point it at a hand-typed subset --
  // which would restore exactly the unfailable property it was rewritten to
  // remove.
  const { realTheme, paletteColours, THEME_PATH } = require('../helpers/ui-real-theme');
  const colours = paletteColours(realTheme().palette);
  assert.ok(THEME_PATH.endsWith('src/ui/src/styles/theme.js'),
    `the guard must read the shipped theme, got ${THEME_PATH}`);
  assert.ok(colours.length >= 20,
    `expected the full resolved palette (>=20 colour leaves), got ${colours.length}; ` +
    'the guard would be walking a subset');
  // Spot-check that the semantic families the original two-literal guard named
  // are genuinely present, i.e. the walk reaches real semantic slots.
  const owners = colours.map((c) => c.owner);
  for (const expected of ['primary.main', 'info.main', 'error.main', 'warning.main', 'success.main', 'secondary.main']) {
    assert.ok(owners.includes(expected), `palette walk is missing ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// The dE00 separation figure (card t_4e9cb292).
//
// WHY THIS BLOCK EXISTS: the ramp's header comment quotes "the worst PAIR in
// this ramp is HIGH/MEDIUM at dE00 6.44". That figure was COMMENT-ONLY -- the
// file itself said "THIS dE00 is comment-only, so it can drift again". A
// figure nothing can re-derive cannot be defended, and it cannot fail when it
// changes: the ramp's tokens could be edited and the comment would keep
// asserting a number that no longer described them, with every other guard in
// this file still green. So the figure is now COMPUTED from the committed
// tokens and asserted here.
//
// A correct number and a protected number are different things. This block is
// the difference.
// ---------------------------------------------------------------------------

const RAMP_SOURCE_PATH = path.resolve(__dirname, '../../../src/ui/src/styles/severityRamp.js');

// The documented figure, and the pair it is attributed to. Both are asserted
// against the measurement, so neither can be quietly edited.
const DOCUMENTED_WORST_PAIR = 'HIGH/MEDIUM';
const DOCUMENTED_WORST_DE00 = 6.44;
// The card's own aspirational bar (t_517be819 asked for dE00 16.7 separation).
// This is a figure of RECORD, not a measurement of this ramp -- it is what the
// ramp does NOT reach. It is pinned so it cannot be quietly rewritten either.
const DOCUMENTED_CARD_BAR = 16.7;
// The measurement is deterministic (a pure function of the committed hexes),
// so the tolerance only absorbs the rounding of the documented 2-decimal
// figure -- it is not slack for a drifting ramp.
const DE00_TOLERANCE = 0.005;

/**
 * Every unordered pair of severity levels, with its CIEDE2000 distance.
 * The worst (smallest) pair is the ramp's separation guarantee.
 */
function pairwiseDe00(ramp) {
  const labs = {};
  for (const level of SEVERITY_LEVELS) labs[level] = hexToLab(ramp[level]);
  const pairs = [];
  for (let i = 0; i < SEVERITY_LEVELS.length; i++) {
    for (let j = i + 1; j < SEVERITY_LEVELS.length; j++) {
      const a = SEVERITY_LEVELS[i];
      const b = SEVERITY_LEVELS[j];
      pairs.push({
        pair: `${a}/${b}`,
        de00: ciede2000(labs[a], labs[b]),
      });
    }
  }
  return pairs;
}

test('the worst-pair dE00 matches the figure documented in severityRamp.js', () => {
  const pairs = pairwiseDe00(SEVERITY_RAMP);
  assert.equal(pairs.length, 6,
    `expected one dE00 per unordered pair of 4 levels, got ${pairs.length}`);
  const worst = pairs.reduce((min, p) => (p.de00 < min.de00 ? p : min));
  const measured = worst.de00;

  assert.ok(Math.abs(measured - DOCUMENTED_WORST_DE00) <= DE00_TOLERANCE,
    `the ramp's worst pair measures dE00 ${measured.toFixed(4)}, but `
    + `severityRamp.js documents ${DOCUMENTED_WORST_DE00}. `
    + 'A ramp edit changed the separation; recompute the figure and update '
    + 'the comment together, or the separation guarantee is no longer the '
    + 'one that was measured.');

  assert.equal(worst.pair, DOCUMENTED_WORST_PAIR,
    `the worst pair is now ${worst.pair} at dE00 ${measured.toFixed(4)}, but `
    + `severityRamp.js documents ${DOCUMENTED_WORST_PAIR}. The comment names a `
    + 'specific pair; if the worst pair moved, both the figure and the pair '
    + 'name need updating.');
});

test('the dE00 figure QUOTED IN THE SOURCE COMMENT matches the measurement', () => {
  // The measurement above pins a NUMBER. This pins the COMMENT to that number,
  // so the prose in the shipped UI bundle cannot drift away from the tokens
  // it describes. The file's own header already made this promise ("Re-measured
  // by test/unit/ui/severity-ramp.test.js, which recomputes every figure above
  // and fails if this comment drifts from the committed values") -- the WCAG
  // figures were covered; the dE00 figure was not, and this closes it.
  const source = fs.readFileSync(RAMP_SOURCE_PATH, 'utf8');
  const worst = pairwiseDe00(SEVERITY_RAMP).reduce((min, p) => (p.de00 < min.de00 ? p : min));

  // TWO KINDS OF dE00 FIGURE APPEAR IN THIS COMMENT, and conflating them is
  // the trap this test has to avoid:
  //   1. the RAMP'S OWN measured worst pair  -- re-derivable, asserted against
  //      the computation below; and
  //   2. the CARD'S ASPIRATIONAL BAR (16.7) -- the separation the original
  //      card asked for and this ramp does not reach. It is a figure of
  //      record, not a measurement of this ramp, and it cannot be recomputed
  //      from the tokens. It is pinned as a constant so it cannot be quietly
  //      rewritten either.
  // A first cut of this guard scanned every "dE00 <n>" in the file and
  // required each to equal the measured worst pair -- which failed on the
  // 16.7 bar. That failure was the guard being wrong, not the comment.
  const quoted = [...source.matchAll(/dE00\s+(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  assert.ok(quoted.length > 0,
    'no dE00 figure found in severityRamp.js -- the comment was rewritten and '
    + 'the documented separation guarantee may have been dropped');

  const measured = worst.de00;
  for (const figure of quoted) {
    const isMeasured = Math.abs(figure - measured) <= DE00_TOLERANCE;
    const isCardBar = Math.abs(figure - DOCUMENTED_CARD_BAR) <= DE00_TOLERANCE;
    assert.ok(isMeasured || isCardBar,
      `severityRamp.js quotes dE00 ${figure}, which is neither this ramp's `
      + `measured worst pair (${measured.toFixed(4)}) nor the card's bar `
      + `(${DOCUMENTED_CARD_BAR}). The comment must quote the measurement.`);
  }

  // And the specific claim the comment makes -- the ramp's own worst pair --
  // is asserted against the measurement by name, so a comment that kept 16.7
  // while dropping the 6.44 could not pass.
  //
  // The source is a block comment, so the claim may be split across lines
  // with a leading "* " on each. The pattern therefore tolerates comment
  // decoration between the words -- it must not require the claim to sit on
  // one line, or a harmless re-wrap would break the guard.
  const worstClaim = source.match(
    /worst PAIR in this ramp is[\s*]+([A-Z]+\/[A-Z]+)[\s*]+at dE00[\s*]+(\d+(?:\.\d+)?)/,
  );
  assert.ok(worstClaim,
    'severityRamp.js no longer states which pair is the worst and what it '
    + 'measures; the separation guarantee is documented in prose only');
  assert.equal(worstClaim[1], DOCUMENTED_WORST_PAIR,
    `the comment attributes the worst pair to ${worstClaim[1]}, but the ramp's `
    + `worst pair is ${worst.pair}`);
  assert.ok(Math.abs(Number(worstClaim[2]) - measured) <= DE00_TOLERANCE,
    `the comment says the worst pair (${worstClaim[1]}) measures dE00 `
    + `${worstClaim[2]}, but it measures ${measured.toFixed(4)}`);
});


test('the ramp\'s separation ORDER is the documented one: HIGH/MEDIUM tightest, CRITICAL/LOW widest', () => {
  // A first cut of this block asserted only that no pair is below the ramp's
  // worst pair -- which is true BY CONSTRUCTION (the worst pair is the
  // minimum), so it could never fail. A test that cannot fail is not a guard.
  // It was replaced with this one, which states a real property of the ramp:
  // WHICH pairs are tight and which are wide. That can fail, and it was seen
  // failing -- see the falsification in the card evidence.
  const pairs = pairwiseDe00(SEVERITY_RAMP);
  const sorted = [...pairs].sort((a, b) => a.de00 - b.de00);
  const tightest = sorted[0];
  const widest = sorted[sorted.length - 1];

  assert.equal(tightest.pair, DOCUMENTED_WORST_PAIR,
    `the tightest pair is ${tightest.pair} at dE00 ${tightest.de00.toFixed(4)}, `
    + `not ${DOCUMENTED_WORST_PAIR}. The ramp's separation is distributed `
    + 'differently than documented.');
  assert.equal(widest.pair, 'CRITICAL/LOW',
    `the widest pair is ${widest.pair} at dE00 ${widest.de00.toFixed(4)}, not `
    + 'CRITICAL/LOW. The two ends of the ordinal ramp should be the furthest '
    + 'apart.');

  // The spread itself, as a property of the ramp rather than of one figure:
  // the two ends must be far enough apart for the ramp to read as an ordinal
  // scale end-to-end.
  const spread = widest.de00 - tightest.de00;
  assert.ok(spread >= 20,
    `the ramp's dE00 spread is ${spread.toFixed(4)} (${tightest.pair} `
    + `${tightest.de00.toFixed(2)} to ${widest.pair} ${widest.de00.toFixed(2)}); `
    + 'the ends of an ordinal ramp must be clearly separated');
});


