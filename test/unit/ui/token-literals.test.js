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

// RECURSION (t_1980c9b1): this walked only the TOP level of each directory,
// so a screen in a SUBDIRECTORY -- src/ui/src/containers/Operators/ -- was
// invisible to every scan below. A scan that cannot see the file reads as
// clean while the file is untouched: the same lesson as the F3 header
// (a #hex scan cannot see rgba()). This now walks nested directories.
//
// The recursion is bounded to .js files under the three scanned roots, so
// it cannot walk node_modules or any other heavy tree.
const componentFiles = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...componentFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
};

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
// F5 — LENGTH LITERALS (t_e2d4327e; scope widened by t_101fba04)
//
// The F3/F4 scans above see COLOURS. They are blind to lengths, which is how
// `fontSize: '0.875rem'` sat in AppSidebar.js with every guard green.
//
// ── WHAT CHANGED IN t_101fba04, AND WHY ──────────────────────────────────
//
// The ORIGINAL scan was PROP-ENUMERATED: it matched an object-literal prop
// or a JSX attribute only if the PROP NAME was in TYPOGRAPHY_PROPS or
// SCALE_BOUND_PROPS. Its test was named "F5: no hand-copied length literals
// survive in the component tree" -- a claim about the whole tree.
//
// The implementation asserted something much narrower, and the gap was
// MEASURABLE: a length literal in a prop the author had not thought of, or
// inside a template literal, or in a string-valued attribute, was invisible.
// `gridTemplateColumns="repeat(auto-fill, minmax(320px, 1fr))"`, `borderRight:
// '3px solid primary.main'` and `borderLeft: `4px solid`` all survived a
// GREEN scan on published origin/main.
//
// A guard that NAMES a principle must ASSERT the principle, not an
// enumeration of the cases its author thought of. So the scan is now
// VALUE-BASED: it finds a length literal wherever one appears in a
// quoted string or a template literal, in ANY prop, on ANY attribute,
// in ANY nesting depth -- and the test name is now true of what it does.
//
// The OLD scope is not lost: it is SUBSUMED. Every literal the old scan
// caught, the new one catches too (a string-valued '0.875rem' is a quoted
// string containing a length literal, whatever prop it hangs off).
//
// ── THE ONE RULE THAT IS STILL PROP-SHAPED ────────────────────────────────
//
// A BARE NUMBER cannot be detected by value -- `fontSize: 14` and
// `fontSize: 12` are indistinguishable without knowing the prop. And a
// bare number is a length literal ONLY for typography props: for
// spacing/radius props a bare number is the IDIOMATIC, theme-scaled form
// (MUI multiplies theme.spacing by it), and for layout props it is layout,
// not a token. So the bare-number rule keeps its prop scope, and the
// string-literal rule does not.
//
// SCOPE BOUNDARIES, stated rather than left silent:
//   - Border-WIDTH shorthands (`borderBottom: '1px solid ...'`) ARE now in
//     scope as strings. The theme defines no border-width token, so a width
//     literal here is a value that cannot follow the theme. Each live one is
//     carried in LENGTH_EXCEPTIONS with the reason it is defensible -- the
//     numbers themselves are NOT changed by this work.
//   - Percentage lengths (`borderRadius: '50%'`) are NOT in scope: a
//     percentage is relative to the parent box, not to a theme scale.
//   - Layout dimensions (width/height/top/left/right/bottom) are NOT in
//     scope as BARE NUMBERS: they are layout, not tokens, and the tree uses
//     them legitimately. They ARE in scope as strings, because a string
//     length there is still a frozen value.
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

/**
 * A length literal VALUE: a number carrying a rem/px/em unit.
 *
 * The negative lookbehind keeps `1.5rem` out of a longer token, and keeps a
 * digit that is part of an identifier (e.g. `h1px`) from matching. The unit
 * alternation is ordered longest-first so `rem` is not read as `em` with a
 * stray `r` -- the trailing \b would catch that, but ordering makes the
 * intent explicit.
 */
const LENGTH_VALUE = /(?<![\w.])-?\d+(?:\.\d+)?\s*(?:rem|px|em)\b/;

/** A bare number in a typography prop. */
const BARE_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * A quoted string, template literal, or quoted segment inside one.
 * The value is whatever sits between the delimiters -- for a template
 * literal that is the STATIC text, with the ${...} holes left in place, so
 * `1px solid ${theme.palette.overlay.divider}` is scanned for its `1px`.
 */
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/**
 * Attribute the literal to the prop it hangs off, best-effort.
 *
 * Used only to name the offender in the failure message and to key the
 * exception list -- the DETECTION does not depend on this succeeding. A
 * literal whose owner cannot be determined is still an offender; it is
 * reported as '(literal)' rather than being dropped.
 */
const attributeProp = (line, index) => {
  const before = line.slice(0, index);
  // JSX attribute:  name="..."   /   name={`...`}
  const attr = /([A-Za-z][A-Za-z0-9]*)\s*=\s*$/.exec(before);
  if (attr) return attr[1];
  // Object property:  name: "..."   (also matches a nested object value)
  const obj = /([A-Za-z][A-Za-z0-9]*)\s*:\s*[^,{}]*$/.exec(before);
  if (obj) return obj[1];
  // Declaration:  const NAME = "..."
  const decl = /(?:const|let|var)\s+([A-Za-z][A-Za-z0-9]*)\s*=\s*$/.exec(before);
  if (decl) return decl[1];
  return '(literal)';
};

/**
 * Find hand-copied length literals in one source string.
 *
 * THE SCAN IS VALUE-BASED (t_101fba04). A length literal is a LENGTH LITERAL
 * because of what it CONTAINS, not because of which prop it sits under --
 * so every quoted string and template literal is examined, whatever the
 * prop, whatever the attribute, whatever the nesting depth.
 *
 * The one prop-shaped rule that survives is the BARE-NUMBER rule: a number
 * with no unit can only be judged against the prop that owns it, and a bare
 * number is a legitimate theme-scaled value for spacing/radius props and a
 * legitimate layout value for dimension props.
 *
 * @param {string} src source text (comments already stripped)
 * @returns {{prop: string, value: string, line: number, kind: string}[]}
 */
const scanLengthLiterals = (src) => {
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    // ── Rule 1 (value-based): any quoted string or template literal that
    // contains a length literal is an offender, in ANY prop.
    QUOTED.lastIndex = 0;
    let m;
    while ((m = QUOTED.exec(line)) !== null) {
      const inner = m[2];
      const hit = LENGTH_VALUE.exec(inner);
      if (!hit) continue;
      offenders.push({
        prop: attributeProp(line, m.index),
        value: inner.trim(),
        length: hit[0].trim(),
        line: i + 1,
        kind: 'string',
      });
    }

    // ── Rule 2 (prop-shaped): a BARE NUMBER is a length literal only for
    // the typography props, where the theme defines no scale step for it.
    // For spacing/radius a bare number IS the theme-scaled form; for layout
    // dimensions it is layout, not a token.
    const objRe = /(^|[^A-Za-z0-9_$])([A-Za-z][A-Za-z0-9]*)\s*:\s*([^,}\n]+)/g;
    while ((m = objRe.exec(line)) !== null) {
      const prop = m[2];
      const raw = m[3].trim();
      if (!TYPOGRAPHY_NUMBER_FORBIDDEN.has(prop)) continue;
      // Skip a value that is already a quoted string -- rule 1 owns those.
      if (/^['"`]/.test(raw)) continue;
      if (BARE_NUMBER.test(raw)) {
        offenders.push({
          prop,
          value: raw,
          length: raw,
          line: i + 1,
          kind: 'number',
        });
      }
    }

    // ── Rule 2b: the JSX-attribute spelling of the same bare-number rule
    // (`<Typography fontSize={14} />`).
    const jsxRe = /(^|[<\s])([A-Za-z][A-Za-z0-9]*)\s*=\s*\{([^}]*)\}/g;
    while ((m = jsxRe.exec(line)) !== null) {
      const prop = m[2];
      if (!TYPOGRAPHY_NUMBER_FORBIDDEN.has(prop)) continue;
      const braced = m[3].trim();
      if (!BARE_NUMBER.test(braced)) continue;
      offenders.push({
        prop,
        value: braced,
        length: braced,
        line: i + 1,
        kind: 'number',
      });
    }
  });
  return offenders;
};

/**
 * Documented exceptions to the length scan, keyed `<file>|<prop>|<length>`.
 *
 * Each entry is a DELIBERATE, measured decision -- not a suppression to make
 * the guard green. The guard below proves every entry is still NEEDED
 * (it fails if an exception stops being used) so the list cannot rot into a
 * blanket amnesty.
 *
 * WHY THE KEY CARRIES THE LENGTH (t_101fba04). The old key was
 * `<file>|<prop>`. That was enough when the scan only matched TYPOGRAPHY and
 * SPACING props, where a file had at most one literal per prop. The widened
 * scan is VALUE-based, so one prop can carry SEVERAL distinct literals --
 * AppSidebar.js `borderRight` carries a `1px` hairline in one place and a
 * `3px` active-indicator in another, and they are two different decisions.
 * Keying on `<file>|<prop>` alone would have let ONE entry silently exempt
 * all three literals, and the rot-proof guard would have proved only that
 * ONE of them was still needed.
 *
 * WHY THE ENTRY LISTS A SET OF VALUES. Even `<file>|<prop>|<length>` can
 * collide: AppSidebar.js `borderRight` carries TWO `3px` literals --
 * `'3px solid primary.main'` when the item is active and `'3px solid
 * transparent'` when it is not. They are the same WIDTH and the same
 * DECISION (one active-indicator, two colour branches), so they belong to
 * one entry -- but they are two distinct strings, so the entry lists both.
 * An entry exempts a literal only if that literal is IN ITS VALUE SET, and
 * the rot-proof guard requires EVERY value in the set to still be present.
 * So neither a value can be added without justification, nor can one be
 * dropped without the guard noticing.
 */
const LENGTH_EXCEPTIONS = new Map([
  ['components/StatusIndicator.js|fontSize|10', {
    values: ['10'],
    reason:
      'the 10px non-text status dot. The theme has no size token for a status '
      + 'indicator; this value is already PINNED by the F4 guard above (WCAG '
      + '1.4.11 3:1 rationale is in the component\'s own comment), so it '
      + 'cannot drift silently.',
  }],
  ['components/AppSidebar.js|letterSpacing|1.5', {
    values: ['1.5'],
    reason:
      'brand tracking for the AWARE wordmark. This theme sets a custom '
      + 'fontFamily, and MUI OMITS letterSpacing from its typography variants '
      + 'when fontFamily is custom (createTypography.js:56) -- so the theme '
      + 'defines no letterSpacing scale to bind to. Dropping the prop removes '
      + 'the tracking entirely, which is a rendering change, not a cleanup.',
  }],

  // ── The border-width literals that the widened scan now reaches ────────
  // Each of these is a HAIRLINE or an INDICATOR WEIGHT, not a scale step.
  // The theme defines no border-width token, and the COLOUR each one carries
  // is already a theme token (overlay.* / primary.main) -- so the colour
  // follows the theme and only the width is frozen. The card's judgement
  // note is explicit: 1px hairlines and a grid column minimum are
  // defensible VALUES; the defect was the overstated claim plus the
  // unguarded path, NOT the numbers. These numbers are NOT changed here.

  ['components/AppHeader.js|borderBottom|1px', {
    values: ['1px solid ${theme.palette.overlay.dividerStrong}'],
    reason:
      'the 1px hairline under the AppBar. A hairline divider is a CSS '
      + 'convention at 1px, not a step on a theme scale -- the theme defines '
      + 'no border-width token, and adding one for a single hairline would '
      + 'be a token with exactly one consumer. The COLOUR is already a theme '
      + 'token (palette.overlay.dividerStrong), so this border does follow '
      + 'the theme; only its width is fixed.',
  }],
  ['components/AppSidebar.js|borderBottom|1px', {
    values: ['1px solid ${theme.palette.overlay.divider}'],
    reason:
      'the 1px hairline under the sidebar wordmark block, separating it from '
      + 'the nav list. Same rationale as the AppHeader hairline: a hairline '
      + 'is a 1px convention, the theme has no border-width token, and the '
      + 'colour is already palette.overlay.divider.',
  }],
  ['components/AppSidebar.js|borderRight|1px', {
    values: ['1px solid ${theme.palette.overlay.divider}'],
    reason:
      'the 1px hairline on the drawer\'s trailing edge, separating the nav '
      + 'from the content area. Same hairline rationale; the colour is '
      + 'already palette.overlay.divider.',
  }],
  ['components/AppSidebar.js|borderRight|3px', {
    values: ['3px solid primary.main', '3px solid transparent'],
    reason:
      'the 3px active-nav indicator on the trailing edge of the selected '
      + 'list item. BOTH branches are 3px (primary.main when active, '
      + 'transparent when not), so the width does not vary with state -- '
      + 'only the COLOUR does, and that is a theme token. The 3px is a '
      + 'deliberate indicator WEIGHT chosen to read as an edge marker; the '
      + 'theme has no border-width token to bind it to.',
  }],
  ['components/AnomalyDetectionAlerts.js|borderLeft|4px', {
    values: ['4px solid'],
    reason:
      'the 4px severity stripe on the leading edge of an anomaly card. This '
      + 'width is not free: the severity ramp was MEASURED as a non-text UI '
      + 'boundary of this width -- styles/severityRamp.js states "these '
      + 'render as a 4px card border, i.e. a non-text UI boundary, so 3:1 is '
      + 'the applicable bar", and test/unit/ui/severity-ramp.test.js '
      + 'recomputes those figures. Changing the width would invalidate a '
      + 'measurement that is currently green. The stripe COLOUR comes from '
      + 'severityColor() and is a severity token.',
  }],

  // ── The grid column minimums ───────────────────────────────────────────
  // A `minmax(<min>, 1fr)` floor is a RESPONSIVE LAYOUT BREAKPOINT, not a
  // step on a theme scale: the theme defines no width scale for it to follow.
  // Note that the SPACING on these very elements IS theme-scaled -- `gap={2}`
  // -- so only the column floor is literal.

  ['components/ComplianceMapping.js|gridTemplateColumns|320px', {
    values: ['repeat(auto-fill, minmax(320px, 1fr))'],
    reason:
      'the minimum column width of the controls-assessed grid. A grid column '
      + 'floor is a layout breakpoint (below it a card stops being legible), '
      + 'not a theme scale step, and the theme defines no width scale to '
      + 'bind it to. The spacing on the same element IS theme-scaled '
      + '(gap={2}), so only the column floor is literal.',
  }],
  ['components/ComplianceMapping.js|gridTemplateColumns|240px', {
    values: ['repeat(auto-fill, minmax(240px, 1fr))'],
    reason:
      'the minimum column width of the audit-readiness grid. Same rationale '
      + 'as the 320px floor above: a responsive layout breakpoint, not a '
      + 'theme scale step; the element\'s gap={2} is theme-scaled.',
  }],
  ['components/ConstraintEnforcementView.js|gridTemplateColumns|320px', {
    values: ['repeat(auto-fill, minmax(320px, 1fr))'],
    reason:
      'the minimum column width of the constraint-tier grid. Same rationale '
      + 'as the ComplianceMapping floors: a responsive layout breakpoint, '
      + 'not a theme scale step; the element\'s gap={2} is theme-scaled.',
  }],
]);

test('F5: no hand-copied length literals survive in the component tree', () => {
  // The point of F5: a length literal is a value frozen at whatever it was
  // typed as. A theme-scaled token follows the theme; a literal does not.
  //
  // The scan is VALUE-based (t_101fba04): a length literal is caught
  // wherever it appears in a quoted string or template literal, in any
  // prop, at any nesting depth. The test name claims the whole tree, and
  // the implementation now does what the name says.
  const offenders = [];
  for (const file of TREE) {
    const src = stripComments(read(file));
    for (const hit of scanLengthLiterals(src)) {
      const rel = path.relative(UI_SRC, file);
      const key = `${rel}|${hit.prop}|${hit.length}`;
      const spec = LENGTH_EXCEPTIONS.get(key);
      if (spec && spec.values.includes(hit.value)) continue;
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
  //
  // The FIRST block is the OLD control: the typography/spacing cases the
  // original prop-enumerated scan was built for. They must STILL be caught,
  // because the widened scan is a SUPERSET, not a replacement.
  //
  // The SECOND block is the t_101fba04 control: the cases the widened scan
  // exists for -- a length literal in a prop the old scan never enumerated,
  // in a template literal, and in a string-valued attribute. The old scan
  // caught NONE of these, which is exactly why it was green over them.
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

  // The cases the ORIGINAL scan was blind to. Each is a real literal from a
  // file that shipped on published origin/main with the old scan GREEN.
  const previouslyMissed = [
    // A string-valued JSX attribute on a prop the old scan never enumerated.
    ['<Box gridTemplateColumns="repeat(auto-fill, minmax(320px, 1fr))" />',
      'gridTemplateColumns'],
    // A length literal inside a TEMPLATE literal, on a border shorthand.
    ['sx={{ borderRight: (theme) => `1px solid ${theme.palette.overlay.divider}` }}',
      'borderRight'],
    // A bare template literal with no interpolation at all.
    ['sx={{ borderLeft: `4px solid` }}', 'borderLeft'],
    // A ternary of two length literals on one prop.
    ["sx={{ borderRight: isActive ? '3px solid primary.main' : '3px solid transparent' }}",
      'borderRight'],
    // A prop the old scan had never heard of, in an object literal.
    ['sx={{ topBorderWidth: "2px" }}', 'topBorderWidth'],
    // A length literal in a plain string-valued prop.
    ['sx={{ minWidth: "240px" }}', 'minWidth'],
  ];
  for (const [source, expectedProp] of previouslyMissed) {
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
    'sx={{ color: "#00e5ff" }}',             // a colour, not a length
    "sx={{ fontFamily: 'Inter, sans-serif' }}", // a font stack, not a length
    'sx={{ flexGrow: 1 }}',                  // a ratio, not a length
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
  //
  // EVERY value in an entry's set must still be present. An entry that
  // exempts two literals proves that BOTH are still needed -- so a value
  // cannot be quietly dropped from the set, and a literal that disappears
  // from the source cannot be quietly re-exempted.
  for (const [key, spec] of LENGTH_EXCEPTIONS) {
    const [rel, prop, length] = key.split('|');
    const file = path.join(UI_SRC, rel);
    assert.ok(fs.existsSync(file), `exception ${key} points at a missing file: ${rel}`);
    const hits = scanLengthLiterals(stripComments(read(file)));
    for (const value of spec.values) {
      assert.ok(
        hits.some((h) => h.prop === prop && h.length === length && h.value === value),
        `exception ${key} (value ${value}) is now STALE -- the literal it `
        + 'exempts is gone. Delete the exception.');
    }
  }
});

test('F5: an exception exempts exactly the literal it documents', () => {
  // The exception map is the guard's only amnesty, so it must not be a
  // blanket. Each entry names a prop AND a length AND a set of exact
  // values; a literal that differs in ANY of those is not exempted.
  //
  // This is proven by MUTATION rather than by inspection: take a live
  // exempted literal, perturb its length by 1px, and require that the
  // exception no longer covers it. A key that matched on file+prop alone
  // would have covered the perturbed literal too, and this test would fail.
  const key = 'components/AppSidebar.js|borderRight|3px';
  const spec = LENGTH_EXCEPTIONS.get(key);
  assert.ok(spec, `expected a live exception at ${key}`);

  const file = path.join(UI_SRC, 'components/AppSidebar.js');
  const hits = scanLengthLiterals(stripComments(read(file)));
  const live = hits.find((h) => h.prop === 'borderRight' && h.length === '3px');
  assert.ok(live, 'the 3px borderRight literal is gone from AppSidebar.js');

  // The same literal IS exempted ...
  assert.ok(spec.values.includes(live.value),
    `the ${key} entry should exempt ${live.value}`);

  // ... but a DIFFERENT length under the same prop is NOT.
  const perturbed = { ...live, length: '4px', value: live.value.replace('3px', '4px') };
  const perturbedKey = `components/AppSidebar.js|borderRight|4px`;
  const perturbedSpec = LENGTH_EXCEPTIONS.get(perturbedKey);
  assert.equal(perturbedSpec, undefined,
    'a 4px borderRight would need its OWN documented entry -- it must not '
    + 'be covered by the 3px one');
  assert.ok(!(perturbedSpec && perturbedSpec.values.includes(perturbed.value)),
    'a perturbed literal must not be exempted by an entry for another length');

  // And a DIFFERENT value under the same prop and length is NOT either.
  const otherValue = { ...live, value: '3px solid #ff0000' };
  assert.ok(!spec.values.includes(otherValue.value),
    'a 3px literal with a different colour must not be exempted by the '
    + 'entry for the themed one');
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
