/**
 * Token-discipline guards for the component tree (t_a7657d55).
 *
 * The token program shipped a governed palette (theme.js: severity ramp, the
 * palette.overlay.* alpha family, palette.info, text.muted, three domain
 * aliases) and then left the literals those tokens exist to replace still
 * sitting in the components. Both findings below are the same defect class:
 *
 *   F3  palette.overlay.* had ZERO consumers. The four alpha tints shipped
 *       while rgba(255,255,255,0.08) and friends stayed in AppHeader/AppSidebar.
 *       A #hex scan cannot see rgba(), so "no hex literals" reads as clean
 *       while the real literals are untouched.
 *   F4  StatusIndicator.js carried a colorMap that turned theme token names
 *       back into hand-copied hexes of the tokens they named.
 *   F5  Typography length literals were outside the scan entirely.
 *       AppSidebar.js carried `fontSize: '0.875rem'` -- the hand-copied
 *       value of theme.typography.body2.fontSize -- and NO scan could see
 *       it, so it shipped unflagged.
 *
 * These tests walk the real component sources, so a future component cannot
 * reintroduce the class without going red. They read files rather than
 * importing components: importing them would need a DOM + react-dom render
 * harness, and the defect is in the SOURCE (a literal that was typed by hand),
 * which is exactly what a source scan can see.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI_SRC = path.resolve(__dirname, '../../../src/ui/src');
const { realTheme } = require('../helpers/ui-real-theme');

const componentFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(dir, e.name));

const TREE = ['components', 'containers', 'constants']
  .map((d) => path.join(UI_SRC, d))
  .filter((d) => fs.existsSync(d))
  .flatMap(componentFiles);

const read = (f) => fs.readFileSync(f, 'utf8');

/**
 * Strip comments so a hex or rgba() quoted in an explanatory comment (this
 * very file's, or a code sample in a component) is not mistaken for a live
 * literal. Blotting out comment bodies, not the code, is deliberate: the
 * defect is a literal in CODE.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('the component tree is not empty -- the scans below would be vacuous otherwise', () => {
  assert.ok(TREE.length >= 10,
    `expected a populated component tree, found ${TREE.length} files; ` +
    'a scan over zero files passes for the wrong reason');
});

test('F3: no hand-decoded rgba() tint literals survive in the component tree', () => {
  // palette.overlay.* is the governed home for these. A literal here means the
  // tint is frozen at whatever colour it was decoded from.
  const offenders = [];
  for (const file of TREE) {
    const src = stripComments(read(file));
    src.split('\n').forEach((line, i) => {
      if (/rgba?\s*\(/.test(line)) {
        offenders.push(`${path.relative(UI_SRC, file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'hand-decoded alpha literals found; use theme.palette.overlay.* via a theme() '
    + 'callback in sx (a string sx value is not interpolated for you):\n'
    + offenders.join('\n'));
});

test('F3: every palette.overlay.* token has at least one consumer', () => {
  // Zero-consumer tokens are the failure this audit caught. A token that ships
  // with no consumer documents an intent nobody implemented.
  const overlay = realTheme().palette.overlay;
  const tokens = Object.keys(overlay);
  assert.ok(tokens.length >= 4, `expected the 4-token overlay family, got ${tokens.length}`);

  const sources = new Map(TREE.map((f) => [f, read(f)]));
  const orphaned = tokens.filter((token) =>
    ![...sources.values()].some((src) => src.includes(`palette.overlay.${token}`)));
  assert.deepEqual(orphaned, [],
    `these overlay tokens ship with no consumer: ${orphaned.join(', ')}`);
});

test('F3: overlay tints resolve to the same values as the literals they replaced', () => {
  // The rewiring must be ZERO-VISUAL-CHANGE. Pin the four resolved values so a
  // future edit to alpha() or to the source token shows up here rather than as
  // a pixel nobody diffed. Computed from the real theme, not read from a comment.
  const overlay = realTheme().palette.overlay;
  assert.deepEqual(overlay, {
    hover: 'rgba(255, 255, 255, 0.05)',
    divider: 'rgba(255, 255, 255, 0.08)',
    dividerStrong: 'rgba(255, 255, 255, 0.1)',
    active: 'rgba(0, 229, 255, 0.1)',
  });
  // overlay.active must stay DERIVED from primary.main -- that derivation is
  // the entire point of the token.
  const palette = realTheme().palette;
  assert.equal(overlay.active, `rgba(0, 229, 255, 0.1)`,
    'overlay.active must track primary.main at 10%');
  assert.equal(palette.primary.main, '#00e5ff',
    'if primary.main moved, overlay.active must follow it — update this pin with it');
});

test('F4: no component re-declares a palette colour as a hand-copied hex', () => {
  // The StatusIndicator colorMap was a lookup that translated theme token
  // names back into hexes. Any hex literal in a component is either that
  // defect again or a new one.
  const KNOWN_NON_PALETTE = new Set([
    // MUI/3rd-party convention, not an AWARE palette colour.
    '#ffffff', '#000000',
  ]);
  const offenders = [];
  for (const file of TREE) {
    const src = stripComments(read(file));
    src.split('\n').forEach((line, i) => {
      const hexes = line.match(/#[0-9a-fA-F]{6}\b/g) || [];
      for (const hex of hexes) {
        if (KNOWN_NON_PALETTE.has(hex.toLowerCase())) continue;
        offenders.push(`${path.relative(UI_SRC, file)}:${i + 1}  ${hex}  |  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'hand-copied colour literals in the component tree; consume a theme token '
    + 'instead:\n' + offenders.join('\n'));
});

test('F4: StatusIndicator passes the token name through to sx', () => {
  // Guards the specific rewiring, not just the absence of hexes: getColor()
  // already returns a token name, and the icon must receive THAT, not a value
  // derived from it.
  const src = read(path.join(UI_SRC, 'components/StatusIndicator.js'));
  assert.ok(!/\bcolorMap\b/.test(stripComments(src)),
    'colorMap is back: it translates token names into hand-copied hexes');
  assert.match(stripComments(src), /<CircleIcon\s+sx=\{\{\s*fontSize:\s*10,\s*color\s*\}\}/,
    'CircleIcon must receive the token name directly as `color`');
});

// ─────────────────────────────────────────────────────────────────────────
// F5 — LENGTH LITERALS (t_e2d4327e)
//
// The F3/F4 scans above see COLOURS. They are blind to lengths, which is how
// `fontSize: '0.875rem'` sat in AppSidebar.js with every guard green.
//
// The scan is scoped by MEASUREMENT, not taste. Rendering a real component
// under a real theme and then under a MOVED theme shows exactly which props
// the theme governs:
//
//   padding / margin / gap (numeric)  -> theme.spacing       (scale-bound)
//   borderRadius (numeric)            -> theme.shape.borderRadius
//   fontSize (number or string)       -> NOT governed; a hard-coded px/rem
//   letterSpacing (number)            -> NOT governed; a hard-coded px
//   lineHeight (number)               -> unitless ratio, the theme's own form
//   width / height / top / left ...   -> layout dimensions, not tokens
//
// So: TYPOGRAPHY props forbid BOTH string literals and bare numbers.
// SPACING/RADIUS props forbid ONLY string literals (the numeric form is
// scale-bound, and is the idiomatic MUI way).
//
// SCOPE BOUNDARIES, stated rather than left silent:
//   - Border-WIDTH shorthands (`borderBottom: '1px solid ...'`) are NOT in
//     scope. The theme defines no border-width token, and these shorthands
//     carry a THEME COLOUR, which the F3/F4 scans already cover.
//   - Percentage lengths (`borderRadius: '50%'`) are NOT in scope: a
//     percentage is relative to the parent box, not to a theme scale.
//   - Layout dimensions (width/height/top/left/right/bottom) are NOT in
//     scope: they are layout, not tokens, and the tree uses them legitimately.
// ─────────────────────────────────────────────────────────────────────────

/** Props whose NUMERIC value the theme scales (MUI's spacing / shape tokens). */
const SCALE_BOUND_PROPS = new Set([
  // padding + aliases (MUI @mui/system spacing.js marginKeys/paddingKeys)
  'p', 'pt', 'pr', 'pb', 'pl', 'px', 'py',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'paddingX', 'paddingY', 'paddingInline', 'paddingInlineStart',
  'paddingInlineEnd', 'paddingBlock', 'paddingBlockStart', 'paddingBlockEnd',
  // margin + aliases
  'm', 'mt', 'mr', 'mb', 'ml', 'mx', 'my',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'marginX', 'marginY', 'marginInline', 'marginInlineStart',
  'marginInlineEnd', 'marginBlock', 'marginBlockStart', 'marginBlockEnd',
  // gap
  'gap', 'rowGap', 'columnGap',
  // shape
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
  'borderBottomLeftRadius', 'borderBottomRightRadius',
]);

/**
 * Typography props. A string value is a hand-copied length; a NUMBER is a
 * hand-copied length too, EXCEPT lineHeight, where a unitless ratio is the
 * theme's own representation (body1 lineHeight is 1.5, body2 is 1.43).
 */
const TYPOGRAPHY_PROPS = new Set(['fontSize', 'lineHeight', 'letterSpacing']);
const TYPOGRAPHY_NUMBER_FORBIDDEN = new Set(['fontSize', 'letterSpacing']);

/** A length literal: a quoted number with a rem/px/em unit. */
const LENGTH_STRING = /^(['"])\s*-?\d+(?:\.\d+)?\s*(?:rem|px|em)\s*\1$/;
/** A bare number in a typography prop. */
const BARE_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Find hand-copied length literals in one source string.
 *
 * @param {string} src source text (comments already stripped)
 * @returns {{prop: string, value: string, line: number}[]}
 */
const scanLengthLiterals = (src) => {
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    // Object-literal form: `prop: value`. This is how every sx prop is
    // written, and how `primaryTypographyProps={{ fontSize: '...' }}` is.
    const objRe = /(^|[^A-Za-z0-9_$])([A-Za-z][A-Za-z0-9]*)\s*:\s*([^,}\n]+)/g;
    let m;
    while ((m = objRe.exec(line)) !== null) {
      const prop = m[2];
      const raw = m[3].trim();
      const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
      const value = quoted ? quoted[2] : raw;
      if (TYPOGRAPHY_PROPS.has(prop)) {
        if (quoted && LENGTH_STRING.test(raw)) {
          offenders.push({ prop, value, line: i + 1 });
        } else if (!quoted && TYPOGRAPHY_NUMBER_FORBIDDEN.has(prop) && BARE_NUMBER.test(raw)) {
          offenders.push({ prop, value, line: i + 1 });
        }
      } else if (SCALE_BOUND_PROPS.has(prop)) {
        // Numeric spacing/radius is theme-scaled -> allowed. Only a literal
        // string ('2rem', '12px') is a hand-copied length.
        if (quoted && LENGTH_STRING.test(raw)) {
          offenders.push({ prop, value, line: i + 1 });
        }
      }
    }
    // JSX-attribute form: `prop={value}` / `prop="value"`. Typography props
    // are passed this way directly on <Typography>, so the object-literal scan
    // above cannot see them.
    const jsxRe = /(^|[<\s])([A-Za-z][A-Za-z0-9]*)\s*=\s*(?:\{([^}]*)\}|(['"][^'"]*['"]))/g;
    while ((m = jsxRe.exec(line)) !== null) {
      const prop = m[2];
      if (!TYPOGRAPHY_PROPS.has(prop)) continue;
      const braced = m[3] !== undefined ? m[3].trim() : m[4];
      const quoted = braced.match(/^(['"])([\s\S]*)\1$/);
      if (quoted && LENGTH_STRING.test(braced)) {
        offenders.push({ prop, value: quoted[2], line: i + 1 });
      } else if (!quoted && TYPOGRAPHY_NUMBER_FORBIDDEN.has(prop) && BARE_NUMBER.test(braced)) {
        offenders.push({ prop, value: braced, line: i + 1 });
      }
    }
  });
  return offenders;
};

/**
 * Documented exceptions to the length scan, keyed `<file>|<prop>`.
 *
 * Each entry is a DELIBERATE, measured decision -- not a suppression to make
 * the guard green. The guard below proves every exception is still NEEDED
 * (it fails if an exception stops being used) so the list cannot rot into a
 * blanket amnesty.
 */
const LENGTH_EXCEPTIONS = new Map([
  ['components/StatusIndicator.js|fontSize', {
    value: '10',
    reason:
      'the 10px non-text status dot. The theme has no size token for a status '
      + 'indicator; this value is already PINNED by the F4 guard above (WCAG '
      + '1.4.11 3:1 rationale is in the component\'s own comment), so it '
      + 'cannot drift silently.',
  }],
  ['components/AppSidebar.js|letterSpacing', {
    value: '1.5',
    reason:
      'brand tracking for the AWARE wordmark. This theme sets a custom '
      + 'fontFamily, and MUI OMITS letterSpacing from its typography variants '
      + 'when fontFamily is custom (createTypography.js:56) -- so the theme '
      + 'defines no letterSpacing scale to bind to. Dropping the prop removes '
      + 'the tracking entirely, which is a rendering change, not a cleanup.',
  }],
]);

test('F5: no hand-copied length literals survive in the component tree', () => {
  // The point of F5: a length literal is a value frozen at whatever it was
  // typed as. A theme-scaled token follows the theme; a literal does not.
  const offenders = [];
  for (const file of TREE) {
    const src = stripComments(read(file));
    for (const hit of scanLengthLiterals(src)) {
      const rel = path.relative(UI_SRC, file);
      const key = `${rel}|${hit.prop}`;
      if (LENGTH_EXCEPTIONS.has(key)) continue;
      offenders.push(`${rel}:${hit.line}  ${hit.prop}: ${hit.value}`);
    }
  }
  assert.deepEqual(offenders, [],
    'hand-copied length literals in the component tree; use the theme scale '
    + 'instead (spacing/radius: a NUMBER, which theme.spacing / '
    + 'theme.shape.borderRadius scale; typography: a variant, or a theme path '
    + "such as 'body2.fontSize'):\n"
    + offenders.join('\n'));
});

test('F5: the length scan can actually FAIL -- it is not a no-op', () => {
  // The overlay-alpha lesson in this file's header, applied to this scan: a
  // scan that cannot see the literal reads as clean while the real literal is
  // untouched. Feed it synthetic sources and require it to FIND them.
  const cases = [
    ["sx={{ fontSize: '0.875rem' }}", 'fontSize'],
    ["sx={{ fontSize: '14px' }}", 'fontSize'],
    ['sx={{ fontSize: 10 }}', 'fontSize'],
    ["sx={{ lineHeight: '1.5rem' }}", 'lineHeight'],
    ['sx={{ letterSpacing: 1.5 }}', 'letterSpacing'],
    ['<Typography letterSpacing={1.5} />', 'letterSpacing'],
    ["<Typography fontSize='14px' />", 'fontSize'],
    ["sx={{ padding: '2rem' }}", 'padding'],
    ["sx={{ gap: '8px' }}", 'gap'],
    ["sx={{ borderRadius: '12px' }}", 'borderRadius'],
    ["sx={{ p: '1rem' }}", 'p'],
    ["sx={{ mt: '2em' }}", 'mt'],
  ];
  for (const [source, expectedProp] of cases) {
    const hits = scanLengthLiterals(`const C = () => <Box ${source} />;`);
    assert.ok(hits.length > 0,
      `the scan missed a hand-copied length in: ${source}`);
    assert.ok(hits.some((h) => h.prop === expectedProp),
      `the scan found ${source} but not as ${expectedProp}: ${JSON.stringify(hits)}`);
  }

  // And the inverse: token-shaped values must NOT be flagged, or the guard
  // would fire on the very fixes it asks for.
  const allowed = [
    "sx={{ fontSize: 'body2.fontSize' }}",   // theme path
    "sx={{ fontSize: 'inherit' }}",          // keyword
    'sx={{ lineHeight: 1.5 }}',              // unitless ratio, the theme's own form
    'sx={{ padding: 2 }}',                   // numeric -> theme.spacing
    'sx={{ borderRadius: 3 }}',              // numeric -> theme.shape.borderRadius
    'sx={{ mt: 1 }}',                        // numeric -> theme.spacing
    'sx={{ p: 2 }}',                         // numeric -> theme.spacing
    "sx={{ borderRadius: '50%' }}",          // percentage, not a theme scale
    'sx={{ width: 12 }}',                    // layout, not a token
  ];
  for (const source of allowed) {
    const hits = scanLengthLiterals(`const C = () => <Box ${source} />;`);
    assert.deepEqual(hits, [],
      `the scan flagged a token-shaped value it should allow: ${source} -> `
      + JSON.stringify(hits));
  }
});

test('F5: every length exception is still NEEDED -- the list cannot rot', () => {
  // An exception that no longer matches anything is an amnesty waiting to
  // happen. Fail here instead: delete the stale entry.
  for (const [key, spec] of LENGTH_EXCEPTIONS) {
    const [rel, prop] = key.split('|');
    const file = path.join(UI_SRC, rel);
    assert.ok(fs.existsSync(file), `exception ${key} points at a missing file: ${rel}`);
    const hits = scanLengthLiterals(stripComments(read(file)));
    assert.ok(hits.some((h) => h.prop === prop && h.value === spec.value),
      `exception ${key} (value ${spec.value}) is now STALE -- the literal it `
      + 'exempts is gone. Delete the exception.');
  }
});

test('F5: the typography scale the guard points at is the REAL one', () => {
  // The remediation the guard recommends is a theme PATH, so the theme must
  // actually define the thing. If MUI moved body2.fontSize, this pin moves
  // with it and the guard keeps pointing at a live token.
  const typography = realTheme().typography;
  assert.equal(typography.body2.fontSize, '0.875rem',
    'if body2.fontSize moved, update this pin with it -- and the AppSidebar '
    + 'label follows the token automatically, which is the point');
  assert.equal(typography.body1.lineHeight, 1.5,
    'body1 lineHeight is the unitless ratio the scan allows');
  assert.equal(typography.body2.lineHeight, 1.43,
    'if body2 lineHeight moved, update this pin with it');
});

test('F5: the sidebar label follows the theme, not a hand-copied length', () => {
  // The specific rewiring, mirroring the F4 StatusIndicator guard: absence of
  // literals alone would not prove the label is still token-driven.
  //
  // It must accept EITHER theme-derived spelling, because both are valid
  // remediations of the same literal and the guard is about the CLASS, not
  // about which spelling a particular commit happened to choose:
  //
  //   fontSize: 'body2.fontSize'  a theme PATH -- keeps the element, keeps
  //                              body1's line-height (1.5). Zero-visual-change.
  //   variant: 'body2'            the framework's own scale step -- changes
  //                              the element <span> -> <p> and body2's own
  //                              line-height (1.43). A rendering change.
  //
  // Pinning one spelling here would make this guard a merge conflict with
  // the other legitimate fix for the same literal, and would fail a tree
  // that is correct for a different reason. What the guard must reject is
  // the LITERAL -- the value that cannot follow the theme.
  const src = stripComments(read(path.join(UI_SRC, 'components/AppSidebar.js')));
  const m = /primaryTypographyProps=\{\{\s*([^}]*)\}\}/.exec(src);
  assert.ok(m,
    'the sidebar label must declare primaryTypographyProps; a missing prop '
    + 'means the label silently fell back to the default body1 scale');
  const props = m[1];

  // Any fontSize value must be a THEME PATH ('body2.fontSize') or a CSS
  // keyword ('inherit'), never a length literal. The theme path resolves
  // through MUI's own theme lookup (system/style.js getPath), so it moves
  // when the theme moves.
  const fontSize = /fontSize:\s*(['"])([^'"]*)\1/.exec(props);
  if (fontSize) {
    const value = fontSize[2];
    const isThemePath = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(value);
    const isKeyword = ['inherit', 'initial', 'unset', 'revert'].includes(value);
    assert.ok(isThemePath || isKeyword,
      `primaryTypographyProps carries a hand-copied fontSize: ${value}. Use a `
      + "theme path such as 'body2.fontSize', or the framework's variant.");
  }

  const themeDerived = /fontSize:\s*'body2\.fontSize'/.test(props)
    || /variant:\s*'body2'/.test(props);
  assert.ok(themeDerived,
    `the sidebar label must read its size from the theme -- either `
    + `fontSize: 'body2.fontSize' (a theme path) or variant: 'body2' (the `
    + `framework's scale step), not a hand-copied length. Got: ${props.trim()}`);
});

test('the guards above walk real files, not an empty path', () => {
  // Precondition for the file scans: pin two of the files they read so a
  // directory rename cannot turn "0 offenders" into a vacuous pass.
  for (const rel of ['components/AppHeader.js', 'components/AppSidebar.js', 'components/StatusIndicator.js']) {
    assert.ok(TREE.includes(path.join(UI_SRC, rel)), `scan is missing ${rel}`);
  }
});
