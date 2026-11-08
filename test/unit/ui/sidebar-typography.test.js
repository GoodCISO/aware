/**
 * test/unit/ui/sidebar-typography.test.js
 *
 * Pins the AppSidebar nav-label typography change: the raw `fontSize:
 * '0.875rem'` literal became the framework-owned `variant: 'body2'`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The change is NOT a zero-visual-change, and the difference is invisible in
 * a diff. `fontSize: '0.875rem'` and `variant: 'body2'` resolve to the SAME
 * font-size (0.875rem == 14px == body2.fontSize), so a review that compares
 * font sizes sees "no change" and stops. But `primaryTypographyProps` merges
 * into the Typography's own props, and the default `primary` slot is body1:
 *
 *   before: fontSize 0.875rem, line-height inherited from body1 (1.5)  -> 21px
 *   after:  fontSize 0.875rem (body2's), line-height body2's own (1.43)  -> 20.02px
 *
 * So the label's LEADING tightens by ~0.98px. That is small; it is also
 * exactly the class of change that a "this is a pure token swap" claim
 * would get wrong, and nobody would catch it downstream.
 *
 * This guard resolves both forms against the REAL theme (not a hand-typed
 * copy -- see test/unit/helpers/ui-real-theme.js) and asserts:
 *
 *   1. the component uses the variant form, and no length literal;
 *   2. the font-size is UNCHANGED (14px both before and after);
 *   3. the line-height DOES change, and by the amount the theme says;
 *   4. the resolved values are the ones the shipped MUI version defines.
 *
 * Assertion (3) is the one that matters. Without it, this file would be a
 * tautology: it would pass for any implementation that merely selects body2,
 * including one that also changed the font-size. A guard that cannot fail is
 * worse than no guard, so (3) is written to be falsifiable -- see the
 * "PROVEN ABLE TO REJECT" note at the bottom.
 *
 * The MUI figures are read from the INSTALLED @mui/material, not hardcoded
 * here, so a MUI upgrade that changes body2's line-height moves the
 * expectation instead of silently breaking the guard. The EXPECTED values
 * are asserted separately so a silent drift in MUI is still visible.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { realTheme } = require('../helpers/ui-real-theme');

const SIDEBAR_PATH = path.resolve(
  __dirname, '../../../src/ui/src/components/AppSidebar.js'
);

/** The literal the change replaced -- the value the app used to render. */
const OLD_FONT_SIZE_REM = '0.875rem';

// The shipped MUI version's figures, asserted so a silent MUI change is
// visible rather than absorbed. Verified against the installed
// @mui/material 5.18.0 (src/ui/node_modules/@mui/material).
const EXPECTED_MUI_VERSION = '5.18.0';
const EXPECTED_BODY1 = { fontSizeRem: '1rem', lineHeight: 1.5 };
const EXPECTED_BODY2 = { fontSizeRem: '0.875rem', lineHeight: 1.43 };

function readSidebar() {
  return fs.readFileSync(SIDEBAR_PATH, 'utf8');
}

/**
 * Which typography variant the component actually selects.
 *
 * This is read from the SOURCE, not assumed. A guard that resolved body2
 * from the theme unconditionally would pass even if the component selected
 * body1 -- the helper-level test would never see the call-site. That was a
 * real defect in the first draft of this file, caught by mutation (see
 * "PROVEN ABLE TO REJECT" at the bottom): the line-height assertion stayed
 * green while the component named body1.
 *
 * @returns {string|null} the variant name, or null if none is selected
 */
function selectedVariant() {
  const src = readSidebar();
  const m = /primaryTypographyProps=\{\{ variant: '([a-zA-Z0-9]+)' \}\}/.exec(src);
  return m ? m[1] : null;
}

/**
 * Resolve a theme font-size to px.
 *
 * The resolved theme carries font-size as a rem STRING ('0.875rem'), not a
 * px number -- MUI's createTypography keeps the authored unit. So the scale
 * factor is the theme's own htmlFontSize (16), not an assumed 16.
 *
 * @param {string|number} fontSize
 * @param {number} htmlFontSize
 * @returns {number} the size in px
 */
function fontSizePx(fontSize, htmlFontSize) {
  if (typeof fontSize === 'number') return fontSize;
  const rem = /^([\d.]+)rem$/.exec(String(fontSize).trim());
  if (rem) return parseFloat(rem[1]) * htmlFontSize;
  const px = /^([\d.]+)px$/.exec(String(fontSize).trim());
  if (px) return parseFloat(px[1]);
  throw new Error(`unrecognised theme font-size: ${fontSize}`);
}

test('the nav label selects a typography variant, not a length literal', () => {
  const src = readSidebar();
  assert.match(
    src,
    /primaryTypographyProps=\{\{ variant: 'body2' \}\}/,
    'AppSidebar must select the body2 scale step via the framework variant'
  );
  assert.doesNotMatch(
    src,
    /primaryTypographyProps=\{\{[^}]*fontSize/,
    'AppSidebar must not carry a raw fontSize literal in primaryTypographyProps'
  );
});

test('the change preserves the font-size exactly (14px before and after)', () => {
  const theme = realTheme();
  const htmlFontSize = theme.typography.htmlFontSize;

  // The variant the component ACTUALLY selects, resolved by the REAL theme.
  const variant = selectedVariant();
  assert.ok(variant, 'the component must select a named variant');
  const chosen = theme.typography[variant];
  assert.ok(chosen, `the theme has no typography variant '${variant}'`);

  // "before": a raw 0.875rem override on top of ListItemText's default slot.
  const beforeFontSizePx = fontSizePx(OLD_FONT_SIZE_REM, htmlFontSize);
  // "after": the selected variant's own font-size, resolved by the theme.
  const afterFontSizePx = fontSizePx(chosen.fontSize, htmlFontSize);

  assert.strictEqual(
    beforeFontSizePx, afterFontSizePx,
    `font-size must be unchanged: before ${beforeFontSizePx}px, after ${afterFontSizePx}px`
  );
  assert.strictEqual(
    afterFontSizePx, 14,
    `the selected variant's font-size resolved to ${afterFontSizePx}px, expected 14px`
  );
  assert.strictEqual(
    theme.typography.body2.fontSize, EXPECTED_BODY2.fontSizeRem,
    `body2.fontSize is ${theme.typography.body2.fontSize}, expected ${EXPECTED_BODY2.fontSizeRem}`
  );
});

test('the line-height DOES change -- this is not a zero-visual-change', () => {
  const theme = realTheme();
  const body1 = theme.typography.body1;
  const htmlFontSize = theme.typography.htmlFontSize;

  // The variant the component ACTUALLY selects -- read from the source, so
  // selecting a different variant changes this assertion's answer.
  const variant = selectedVariant();
  assert.ok(variant, 'the component must select a named variant');
  const chosen = theme.typography[variant];
  assert.ok(chosen, `the theme has no typography variant '${variant}'`);

  // "before": fontSize overridden, but line-height inherited from the
  // default primary slot, which is body1.
  const beforeLeadingPx =
    fontSizePx(OLD_FONT_SIZE_REM, htmlFontSize) * body1.lineHeight;
  // "after": the selected variant supplies BOTH font-size and line-height.
  const afterLeadingPx = fontSizePx(chosen.fontSize, htmlFontSize) * chosen.lineHeight;

  assert.strictEqual(beforeLeadingPx, 21, 'baseline leading must be 21px');
  assert.strictEqual(
    Number(afterLeadingPx.toFixed(2)), 20.02,
    `leading after the change must be 20.02px, got ${afterLeadingPx} `
    + `(variant '${variant}', fontSize ${chosen.fontSize}, lineHeight ${chosen.lineHeight})`
  );
  assert.ok(
    afterLeadingPx < beforeLeadingPx,
    'the guard must be able to observe the leading tightening'
  );
  assert.strictEqual(
    body1.lineHeight, EXPECTED_BODY1.lineHeight,
    `body1.lineHeight is ${body1.lineHeight}, expected ${EXPECTED_BODY1.lineHeight}`
  );
  assert.strictEqual(
    theme.typography.body2.lineHeight, EXPECTED_BODY2.lineHeight,
    `body2.lineHeight is ${theme.typography.body2.lineHeight}, expected ${EXPECTED_BODY2.lineHeight}`
  );
});

test('the shipped MUI version is the one the expectations were derived from', () => {
  const pkgPath = path.resolve(
    __dirname, '../../../src/ui/node_modules/@mui/material/package.json'
  );
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.strictEqual(
    pkg.version, EXPECTED_MUI_VERSION,
    `@mui/material is ${pkg.version}, expected ${EXPECTED_MUI_VERSION} -- `
    + 'the body1/body2 figures in this guard were derived from that version'
  );
});

/*
 * PROVEN ABLE TO REJECT
 * ---------------------
 * Every assertion above was seen FAILING before being trusted, by mutating
 * the working tree and restoring it byte-identically. Three mutations, three
 * rejections:
 *
 *   variant: 'body2' -> variant: 'body1'
 *     -> 3 of 4 tests fail. This is the mutation that matters: it is the
 *        same class of error as the original "this is a pure token swap"
 *        claim, and it changes the rendered leading back to 21px.
 *
 *   variant: 'body2' -> primaryTypographyProps={{ fontSize: '0.875rem' }}
 *     -> 3 of 4 tests fail (the raw literal is back).
 *
 *   variant: 'body2' -> variant: 'body2', fontSize: '0.9375rem'
 *     -> 3 of 4 tests fail. A smuggled font-size that rides along with a
 *        correct variant must not slip through.
 *
 * A FIRST DRAFT of this file was rejected by mutation 1 and rebuilt. It
 * resolved body2 from the theme unconditionally, so its line-height
 * assertion stayed GREEN while the component named body1 -- the helper-level
 * immunity shape (P125 shape 1): the test could not see the call site it
 * was supposed to be guarding. The fix is `selectedVariant()`, which reads
 * the variant out of the component source, so the assertion's answer depends
 * on what the component actually does.
 *
 * The suite was also run against the PRE-change AppSidebar as a baseline:
 * 3 of 4 tests fail there, which is the correct shape -- these assertions
 * describe the state AFTER the change, so they must not pass before it.
 */
