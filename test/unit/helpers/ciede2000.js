/**
 * CIEDE2000 for the AWARE test tree — stdlib only, no dependency.
 *
 * WHY THIS IS VENDORED HERE (card t_4e9cb292):
 *
 * The severity ramp's header comment quotes a measured figure — "the worst PAIR
 * in this ramp is HIGH/MEDIUM at dE00 6.44" — and the comment itself admitted
 * that the figure was COMMENT-ONLY, so it could drift again. A guard that does
 * not assert the figure cannot fail when the figure changes. This module makes
 * the figure re-derivable from the committed tokens, so the guard can assert it.
 *
 * WHY IT IS VENDORED RATHER THAN IMPORTED:
 *
 * The corpus-validated implementation this figure was measured with lives in the
 * `colour-metric-validation` skill, which lives in the Hermes designer
 * profile's skill directory — NOT in this repo, and NOT on the machine that
 * runs the CI suite. A test that reached across that boundary would fail on
 * every contributor's checkout, so the figure could not be enforced at all.
 * The AWARE repo has no colour package and takes no new dependencies for a
 * test, so the formula and its reference corpus are vendored here instead.
 *
 * WHY THE CORPUS COMES WITH IT:
 *
 * A CIEDE2000 that never normalises hue to [0,360) silently zeroes the R_T
 * rotation term for any pair with negative b* — which is exactly what a cyan
 * ramp consists of. It under-reports dE00 by ~30% on precisely the pairs a
 * single-hue ramp is optimised over, so the number stays plausible and
 * nothing flags it. That is not hypothetical: it is how this ramp's figure
 * read 6.1 when the real value is 6.44, and it is why the corpus is shipped
 * alongside the formula rather than trusted.
 *
 * The corpus is the published reference data of:
 *   Sharma, G., Wu, W. & Dalal, E.N. (2005), "The CIEDE2000 Color-Difference
 *   Formula: Implementation Notes, Supplementary Test Data, and Mathematical
 *   Observations", Table 1.
 *   http://www2.ece.rochester.edu/~gsharma/ciede2000/dataNprograms/CIEDE2000.xls
 *
 * Note on counting: Sharma Table 1 is 34 rows, of which 33 are active (the
 * published transcription comments out (50,0.001,-2.49)). The corpus below
 * carries 35, because that de-commented row's expected value (4.8045) was
 * independently confirmed correct and is a genuinely useful extra probe of the
 * hue-rotation branch. So "fails 31 of 34" (published, active rows) and
 * "fails 32 of 35" (this corpus) describe the SAME failure. If you quote a
 * corpus count, say which set you counted.
 *
 * WHAT IS ASSERTED ABOUT IT (severity-ramp.test.js):
 *   - this implementation passes every corpus pair (so the figure below is
 *     backed by published data), and
 *   - the KNOWN-BROKEN variant below FAILS the corpus (so the corpus check is
 *     known to be able to reject, rather than being decoration).
 */

'use strict';

// ---------------------------------------------------------------------------
// The published reference corpus. [lab1, lab2, expected dE00]
// ---------------------------------------------------------------------------
const CIEDE2000_CORPUS = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
  [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0],
  [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, -1, 2], [50, 0, 0], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
  [[50, 2.49, -0.001], [50, -2.49, 0.001], 7.1792],
  [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
  [[50, 2.49, -0.001], [50, -2.49, 0.0012], 7.2195],
  [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
  [[50, -0.001, 2.49], [50, 0.001, -2.49], 4.8045],
  [[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461],
  [[50, -0.001, 2.49], [50, 0.0012, -2.49], 4.7461],
  [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[50, 2.5, 0], [61, -5, 29], 22.8977],
  [[50, 2.5, 0], [56, -27, -3], 31.9030],
  [[50, 2.5, 0], [58, 24, 15], 19.4535],
  [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
  [[50, 2.5, 0], [50, 3.2972, 0], 1.0],
  [[50, 2.5, 0], [50, 1.8634, 0.5757], 1.0],
  [[50, 2.5, 0], [50, 3.2592, 0.335], 1.0],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
  [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
  [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
  [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

// ---------------------------------------------------------------------------
// sRGB -> CIELAB (D65, 2-degree observer)
// ---------------------------------------------------------------------------

/**
 * @param {string} hex '#rrggbb' or 'rrggbb'
 * @returns {number[]} [L*, a*, b*]
 */
function hexToLab(hex) {
  const s = String(hex).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`bad hex: ${hex}`);
  const rgb = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  const lin = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  const [r, g, b] = lin;
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / 1.0;
  const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// ---------------------------------------------------------------------------
// CIEDE2000
// ---------------------------------------------------------------------------

/**
 * The reference implementation, with the hue-normalisation fix applied.
 *
 * @param {number[]} lab1 [L*, a*, b*]
 * @param {number[]} lab2 [L*, a*, b*]
 * @param {number} [kL] parametric lightness factor
 * @param {number} [kC] parametric chroma factor
 * @param {number} [kH] parametric hue factor
 * @returns {number} the colour difference dE00
 */
function ciede2000(lab1, lab2, kL = 1, kC = 1, kH = 1) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const p7 = Math.pow;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(p7(Cbar, 7) / (p7(Cbar, 7) + p7(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  // THE FIX. atan2 returns a negative angle for any pair with negative b*; the
  // rotation term uses the DEGREE-domain value, so without this the hue term
  // silently dies for exactly the pairs a single-hue ramp is built from.
  let h1p = C1p === 0 ? 0 : toDeg(Math.atan2(b1, a1p));
  let h2p = C2p === 0 ? 0 : toDeg(Math.atan2(b2, a2p));
  if (h1p < 0) h1p += 360;
  if (h2p < 0) h2p += 360;
  if (h1p - h2p > 180) h1p -= 360;
  else if (h1p - h2p < -180) {
    h2p += 360;
    h1p += 360;
  }
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
  else dhp = h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(toRad(dhp) / 2);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;
  const T = 1
    - 0.17 * Math.cos(toRad(hbarp - 30))
    + 0.24 * Math.cos(toRad(2 * hbarp))
    + 0.32 * Math.cos(toRad(3 * hbarp + 6))
    - 0.20 * Math.cos(toRad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const RC = 2 * Math.sqrt(p7(Cbarp, 7) / (p7(Cbarp, 7) + p7(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(toRad(2 * dTheta)) * RC;
  const tL = dLp / (kL * SL);
  const tC = dCp / (kC * SC);
  const tH = dHp / (kH * SH);
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/**
 * The DELIBERATELY BROKEN variant — the falsification fixture.
 *
 * It is the shape of implementation that produced this ramp's wrong figure:
 * hue is carried in RADIANS where the rotation term expects DEGREES, so
 * dTheta collapses to 0 and the whole R_T rotation term vanishes for every
 * pair whose two hues cancel — which is most of a single-hue ramp. It
 * under-reports dE00, and it fails most of the corpus. It is kept here so the
 * corpus check is KNOWN to be able to reject something: a gate that has never
 * been seen failing is decoration.
 *
 * @param {number[]} lab1
 * @param {number[]} lab2
 * @returns {number}
 */
function ciede2000HueNotNormalised(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const toRad = (d) => (d * Math.PI) / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : (toRad(Math.atan2(b1, a1p)) + 2 * Math.PI) % (2 * Math.PI);
  const h2p = C2p === 0 ? 0 : (toRad(Math.atan2(b2, a2p)) + 2 * Math.PI) % (2 * Math.PI);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= Math.PI) dhp = h2p - h1p;
  else if (h2p - h1p > Math.PI) dhp = h2p - h1p - 2 * Math.PI;
  else dhp = h2p - h1p + 2 * Math.PI;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= Math.PI) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 2 * Math.PI) hbarp = (h1p + h2p + 2 * Math.PI) / 2;
  else hbarp = (h1p + h2p - 2 * Math.PI) / 2;
  const T = 1
    - 0.17 * Math.cos(hbarp - Math.PI / 6)
    + 0.24 * Math.cos(2 * hbarp)
    + 0.32 * Math.cos(3 * hbarp + Math.PI / 30)
    - 0.20 * Math.cos(4 * hbarp - 63 * Math.PI / 180);
  // BUG: hbarp is in RADIANS; this term expects DEGREES.
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * toRad(dTheta)) * RC;
  return Math.sqrt(
    Math.pow(dLp / SL, 2) + Math.pow(dCp / SC, 2) + Math.pow(dHp / SH, 2)
    + RT * (dCp / SC) * (dHp / SH),
  );
}

// ---------------------------------------------------------------------------
// Corpus validation
// ---------------------------------------------------------------------------

/**
 * Run a metric implementation over the published corpus.
 *
 * @param {(a: number[], b: number[]) => number} fn
 * @param {number} [tolerance] max allowed absolute error per pair
 * @returns {{pass: number, total: number, failures: {index: number, want: number, got: number, err: number}[], worst: number}}
 */
function validateAgainstCorpus(fn, tolerance = 1e-4) {
  const failures = [];
  let worst = 0;
  CIEDE2000_CORPUS.forEach(([a, b, want], i) => {
    const got = fn(a, b);
    if (typeof got !== 'number' || Number.isNaN(got)) {
      failures.push({ index: i, want, got, err: Infinity });
      return;
    }
    const err = Math.abs(got - want);
    worst = Math.max(worst, err);
    if (err > tolerance) failures.push({ index: i, want, got, err });
  });
  return {
    pass: CIEDE2000_CORPUS.length - failures.length,
    total: CIEDE2000_CORPUS.length,
    failures,
    worst,
  };
}

module.exports = {
  CIEDE2000_CORPUS,
  hexToLab,
  ciede2000,
  ciede2000HueNotNormalised,
  validateAgainstCorpus,
};
