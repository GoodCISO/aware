/**
 * Tier border colours: the guard that keeps the CSS-var defect dead (t_892465f7).
 *
 * THE DEFECT THIS FILE EXISTS TO KILL
 *
 * `ConstraintEnforcementView.js` drew each of its five tier cards' accent
 * border with a CSS custom property:
 *
 *     sx={{ borderColor: `var(--mui-palette-${level.color}-main)` }}
 *
 * MUI v5 emits `--mui-palette-*` properties ONLY under `CssVarsProvider` +
 * `experimental_extendTheme`. This app uses a plain `createTheme` +
 * `ThemeProvider` (src/ui/src/index.js:15), so the property is never defined,
 * the `var()` resolves to nothing, and the border fell back to the Card's own
 * hairline. All five tier borders had therefore been rendering in the SAME
 * default colour since the component was written -- and nothing failed,
 * because a `var()` that resolves to nothing is not an error, it is a
 * silently-absent style.
 *
 * The first repair (commit 84358769) swapped the string for a `theme()`
 * callback. That fixed the rendering. It did NOT leave a guard, so the class
 * was one refactor away from coming back, and the `?.` in
 * `theme.palette[level.color]?.main` still let a MISSING token resolve to
 * `undefined` -- the same silent failure in a new spelling.
 *
 * WHY A SOURCE SCAN IS NOT ENOUGH
 *
 * The obvious guard -- "grep for `var(--mui-palette-`" -- is a scan over
 * source text. It cannot tell a live reference from a mention in a comment,
 * it cannot see a different spelling of the same mistake, and it says nothing
 * about what the component actually RENDERS. The original defect lived in a
 * string that a scan for that exact string would have caught, so a scan looks
 * sufficient -- until the next spelling arrives.
 *
 * So this file does BOTH:
 *
 *   1. scans the real component tree for the CLASS (any `var(--mui-` palette
 *      reference), in CODE, not in comments; and
 *   2. RENDERS the real component under the real theme and asserts on the
 *      markup -- which is the only way to prove the border colour is a real
 *      colour rather than a reference to nothing.
 *
 * The renderer is react-dom/server (renderToStaticMarkup), not a DOM: it
 * needs no jsdom and no browser, and every property under test (which colour
 * a border resolves to) is decided during render and lands in the markup.
 * Same choice as test/unit/api/severity-seam.test.js.
 *
 * NOTHING HERE IS STUBBED. The markup that fails an assertion is the markup
 * a browser would have received.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadUiModule, UI_DIR } = require('../helpers/ui-real-module');
const { realTheme } = require('../helpers/ui-real-theme');

const React = require(path.join(UI_DIR, 'node_modules/react'));
const { renderToStaticMarkup } = require(path.join(UI_DIR, 'node_modules/react-dom/server'));
const { ThemeProvider } = require(path.join(UI_DIR, 'node_modules/@mui/material/styles'));

const UI_SRC = path.resolve(__dirname, '../../../src/ui/src');
const VIEW_REL = 'components/ConstraintEnforcementView.js';

/**
 * Strip comments so a `var(--mui-palette-...)` quoted in an explanatory
 * comment (this file's own header, or a code sample in a component) is not
 * mistaken for a live reference. Blotting out comment bodies, not the code,
 * is deliberate: the defect is a reference in CODE.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Every .js file under the UI source tree, excluding node_modules. */
const uiSourceFiles = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...uiSourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};

const TREE = uiSourceFiles(UI_SRC);

let ConstraintEnforcementView;
let CONSTRAINT_LEVELS;
let tierBorder;
let theme;

test.before(async () => {
  const mod = loadUiModule(VIEW_REL);
  ConstraintEnforcementView = mod.default;
  CONSTRAINT_LEVELS = mod.CONSTRAINT_LEVELS;
  // styles/tierBorder.js is ESM (src/ui/src is ESM under react-scripts' strict
  // ESM webpack), so it comes through the same babel bridge as the component.
  // A bare require() would fail on the export syntax.
  tierBorder = loadUiModule('styles/tierBorder.js');
  theme = realTheme();
});

/** Render the real component under the real theme and return the markup. */
const renderView = () => renderToStaticMarkup(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(ConstraintEnforcementView, { constraints: [], agents: [] }),
  ),
);

/** Every `border-color: X` value in the markup. */
const borderColoursIn = (html) => [...html.matchAll(/border-color:\s*([^;"]+)/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// 1. The class scan -- no CSS custom property palette reference in CODE
// ---------------------------------------------------------------------------

test('the component tree is not empty -- the scan below would be vacuous otherwise', () => {
  assert.ok(TREE.length >= 10,
    `expected a populated component tree, found ${TREE.length} files; `
    + 'a scan over zero files passes for the wrong reason');
});

test('no component references a MUI palette CSS custom property in code', () => {
  // The original defect, in its original spelling and in the spellings that
  // mean the same thing. `var(--mui-` covers `--mui-palette-*` and any other
  // MUI-emitted property; the app emits NO `--mui-*` properties at all
  // (asserted below), so any reference to one is dead by construction.
  const offenders = [];
  for (const file of TREE) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    src.split('\n').forEach((line, i) => {
      if (/var\(\s*--mui-/.test(line)) {
        offenders.push(`${path.relative(UI_SRC, file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'these components reference a --mui-* CSS custom property; this app uses a '
    + 'plain createTheme + ThemeProvider, so no such property is ever emitted '
    + 'and the reference resolves to nothing:\n' + offenders.join('\n'));
});

test('the app really does emit no --mui-* custom properties', () => {
  // Precondition for the scan above: if the app were ever wrapped in
  // CssVarsProvider, the scan would start flagging CORRECT code and the
  // guard would push a future developer back into the defect. If it were
  // already wrapped, the original defect would not have been a defect.
  const indexSrc = fs.readFileSync(path.join(UI_SRC, 'index.js'), 'utf8');
  assert.doesNotMatch(stripComments(indexSrc), /CssVarsProvider/,
    'the UI is now wrapped in CssVarsProvider, so --mui-* properties DO exist; '
    + 'this guard and its fallback assumptions must be revisited');
  assert.doesNotMatch(stripComments(indexSrc), /extendTheme/,
    'the UI now uses experimental_extendTheme, so --mui-* properties DO exist; '
    + 'this guard and its fallback assumptions must be revisited');
});

// ---------------------------------------------------------------------------
// 2. The render proof -- the border is a REAL colour
// ---------------------------------------------------------------------------

test('every tier card renders a real border colour, not a reference to nothing', () => {
  const html = renderView();
  const colours = borderColoursIn(html);

  assert.ok(colours.length >= CONSTRAINT_LEVELS.length,
    `expected at least one border colour per tier (${CONSTRAINT_LEVELS.length}), `
    + `found ${colours.length} in the rendered markup`);

  for (const colour of colours) {
    assert.doesNotMatch(colour, /var\(/,
      `a rendered border colour is still a var() reference: ${colour}. `
      + 'An unresolved var() renders as no border at all, which is the defect.');
    assert.doesNotMatch(colour, /undefined|null/i,
      `a rendered border colour is ${colour}; an unresolved palette key must `
      + 'fall back to a visible token, not to nothing');
    assert.notEqual(colour.trim(), '',
      'a rendered border colour is empty; an empty border colour is no border');
  }
});

test('the rendered border colours are the tiers\' OWN theme tokens', () => {
  // The stronger half of the proof: each card's border must be the colour of
  // the palette token its tier names. This is what "the border resolves to
  // the tier colour" means, and it is checkable only against the real theme.
  const html = renderView();
  const colours = borderColoursIn(html);

  const expected = CONSTRAINT_LEVELS.map((level) => {
    const entry = theme.palette[level.color];
    return entry && typeof entry === 'object' ? entry.main : entry;
  });

  for (const colour of expected) {
    assert.ok(typeof colour === 'string' && colour !== '',
      `tier colour "${colour}" does not resolve to a string in the real theme`);
    assert.ok(colours.includes(colour),
      `no rendered card carries the tier border ${colour}; rendered borders were `
      + `${JSON.stringify([...new Set(colours)])}`);
  }
});

test('the tier table names five tiers and each names a palette token the theme holds', () => {
  // The ladder's own data must be self-consistent with the theme. A tier
  // naming a token the theme does not hold is a programming error the
  // resolver now catches loudly -- but it should never be introduced.
  assert.equal(CONSTRAINT_LEVELS.length, 5,
    `expected five tiers (T0-T4), found ${CONSTRAINT_LEVELS.length}`);
  for (const level of CONSTRAINT_LEVELS) {
    const entry = theme.palette[level.color];
    assert.ok(entry !== undefined && entry !== null,
      `tier ${level.id} names palette token "${level.color}", which the theme `
      + 'does not hold; the border would fall back to the divider');
    const main = typeof entry === 'object' ? entry.main : entry;
    assert.equal(typeof main, 'string',
      `tier ${level.id} names "${level.color}", which has no colour string`);
  }
});

// ---------------------------------------------------------------------------
// 3. The fallback -- a missing token must be VISIBLE and LOUD
// ---------------------------------------------------------------------------

test('a tier naming an unknown token renders a visible border, not an invisible one', () => {
  // This is the hole the `?.` in the first repair left open: an unknown token
  // resolved to `undefined`, and an undefined border colour is no border --
  // the exact silent failure the original defect was. The fallback must be a
  // VISIBLE colour.
  const { resolveTierBorder, TIER_BORDER_FALLBACK_TOKEN } = tierBorder;

  const resolved = resolveTierBorder(theme, 'definitelyNotAToken');
  assert.equal(typeof resolved, 'string');
  assert.notEqual(resolved, '', 'the fallback border colour is empty');
  assert.notEqual(resolved, 'transparent',
    'the fallback border colour is transparent, which renders as no border');
  assert.notEqual(resolved, 'undefined',
    'the fallback border colour is the string "undefined"');
  assert.equal(resolved, theme.palette[TIER_BORDER_FALLBACK_TOKEN],
    'the fallback must be the documented visible token');
});

test('an unknown tier token warns exactly once, not once per render', () => {
  // The resolver runs inside a render. An unguarded warning would repeat per
  // tier per frame and bury the diagnostic it exists to raise.
  const { resolveTierBorder, resetTierBorderWarnings } = tierBorder;
  resetTierBorderWarnings();

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    resolveTierBorder(theme, 'someMissingToken');
    resolveTierBorder(theme, 'someMissingToken');
    resolveTierBorder(theme, 'someMissingToken');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1,
    `expected exactly one warning for three resolutions of the same unknown `
    + `token, got ${warnings.length}: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /someMissingToken/,
    'the warning must name the token that was missing');
});

// ---------------------------------------------------------------------------
// 4. The resolver itself
// ---------------------------------------------------------------------------

test('the resolver reads a ramp via .main and a flat colour as itself', () => {
  const { resolveTierBorder } = tierBorder;
  const ramp = { main: '#123456', light: '#abcdef', dark: '#000000' };
  const fake = { palette: { aRamp: ramp, aFlat: '#654321' } };
  assert.equal(resolveTierBorder(fake, 'aRamp'), '#123456');
  assert.equal(resolveTierBorder(fake, 'aFlat'), '#654321');
});

test('the resolver does not resolve inherited Object members as colours', () => {
  // `palette['constructor']` is a function on a bare lookup. A guard that
  // accepted it would turn a typo into a non-colour, which is the same class
  // of silent failure this whole file exists to end.
  const { resolveTierBorder } = tierBorder;
  const resolved = resolveTierBorder({ palette: {} }, 'constructor');
  assert.equal(typeof resolved, 'string');
  assert.doesNotMatch(resolved, /function/i,
    `the resolver returned ${resolved} for an inherited member`);
});
