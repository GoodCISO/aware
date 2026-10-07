/**
 * Severity ramp tokens — see theme.js for how this is consumed.
 *
 * MEASUREMENT NOTE (card t_517be819, recomputed with WCAG 2.x relative
 * luminance + CIEDE2000 against the AWARE surfaces below; the working
 * scripts are `measure-ramp.js` / `ramp-final.js` in the task workspace):
 *
 *   surfaces: background.default #0a1929, background.paper #132f4c
 *   CRITICAL #e8fdff  16.83:1 / 12.95:1   L* 97.9
 *   HIGH     #7deeff  13.13:1 / 10.10:1   L* 88.3
 *   MEDIUM   #33d9f5  10.46:1 /  8.05:1   L* 80.1
 *   LOW      #0fa9c2   6.31:1 /  4.86:1   L* 63.6
 *
 * (Re-measured by test/unit/ui/severity-ramp.test.js, which recomputes every
 * figure above and fails if this comment drifts from the committed values.)
 *
 * All four clear the WCAG 2.x SC 1.4.11 3:1 non-text floor on BOTH surfaces
 * (these render as a 4px card border, i.e. a non-text UI boundary, so 3:1
 * is the applicable bar — not the 4.5:1 body-text bar). Contrast is strictly
 * monotonic CRITICAL -> LOW, so the ordering survives in greyscale, in
 * forced-colors mode, and for any dichromatic viewer who cannot separate
 * hues. That is the whole point of an ordinal ramp: lightness carries the
 * order, not hue.
 *
 * KNOWN LIMIT, stated rather than hidden: the worst PAIR in this ramp is
 * HIGH/MEDIUM at dE00 6.1. The card asked for levels that read as clearly
 * separate tokens and cited dE00 16.7 as its own bar. That bar is NOT
 * reachable by any single-hue ramp here: an exhaustive search of the AWARE
 * cyan gamut (hue 187, sat 100%, L 80-99) subject to the 3:1 floor and
 * monotonic contrast tops out at dE00 6.1, and the constraint is geometric —
 * a 4-step single-hue ramp spanning only the luminances that clear 3:1 on
 * paper #132f4c has a fixed lightness budget to divide into 3 gaps.
 *
 * Two things follow, and they are why this is not merely a token swap:
 *   1. Colour alone is NOT a sufficient severity signal at the 4th level.
 *      The UI therefore also renders a text severity label on every card, so
 *      severity is never carried by hue alone (WCAG 1.4.1 Use of Color).
 *   2. The 4th level needs a second, non-colour channel if the designer
 *      wants tokens that are unmistakably distinct. Escalated to designer/
 *      architect as its own card; deliberately NOT decided here, because
 *      picking a hue is a brand call, and the card explicitly fenced
 *      palette.info governance (c-2026-09-29-03) to Alvin's brand pick.
 *
 * Hue is held at 187deg (the AWARE primary #00e5ff hue) across all four
 * steps. The steps are lightness-only, by design: hue variation would make
 * the set read as CATEGORICAL, which is the wrong signal for an ordered
 * quantity.
 *
 * ESM, matching every other module under src/ui/src. A CommonJS version of
 * this file fails the react-scripts production build
 * ("Attempted import error: 'SEVERITY_RAMP' is not exported from
 * './severityRamp'") even though `node --test` requires it happily -- webpack
 * does not apply Node's CJS named-export interop. Verified by running the
 * real build. The node --test suite imports it with a dynamic import() for
 * the same reason.
 */

const SEVERITY_RAMP = {
  CRITICAL: '#e8fdff',
  HIGH: '#7deeff',
  MEDIUM: '#33d9f5',
  LOW: '#0fa9c2',
};

export { SEVERITY_RAMP };
export default SEVERITY_RAMP;
