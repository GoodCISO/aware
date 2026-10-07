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
  // The card rejected repointing severity at primary.main, because merging
  // two meanings into one token is worse than a new token. Guard the specific
  // pair the card measured: the brand primary vs MUI's info blue, which sit
  // at 1.50:1 contrast. Severity must not silently adopt either.
  const PRIMARY_MAIN = '#00e5ff';
  const MUI_INFO = '#29b6f6';
  for (const level of SEVERITY_LEVELS) {
    const c = SEVERITY_RAMP[level];
    assert.notEqual(c.toLowerCase(), PRIMARY_MAIN,
      `${level} aliases primary.main; severity needs its own token`);
    assert.notEqual(c.toLowerCase(), MUI_INFO,
      `${level} aliases MUI info; severity needs its own token`);
  }
});
