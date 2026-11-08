/**
 * Filled components: every label clears AA on its own fill.
 *
 * WHY THIS EXISTS. `token-literals.test.js` governs which colours the component
 * tree may TYPED, and `severity-ramp.test.js` governs the ramp. Neither governs
 * the pair a <Chip>/<Badge>/<Button variant="contained"> actually PAINTS. That
 * pair is framework-derived: MUI computes each fill's `contrastText` from the
 * fill's own luminance, so the label colour on a fill is not the label colour
 * on the page and is not something a token slot announces.
 *
 * THE DEFECT THIS CAUGHT. On the shipped palette, MUI derived `rgba(0,0,0,.87)`
 * for five of the six semantic fills and `#fff` for `error` alone:
 *
 *   primary #00e5ff -> black label  11.30:1  PASS
 *   secondary #a180ff -> black label  6.21:1  PASS
 *   info #29b6f6 -> black label       7.87:1  PASS
 *   warning #ff9100 -> black label    8.03:1  PASS
 *   success #00e676 -> black label   10.55:1  PASS
 *   error #ff1744 -> WHITE label      3.85:1  FAIL   <-- sole outlier
 *
 * The outlier was the whole finding. Red was the only fill whose derivation
 * flipped, and the only one that failed. This is why the guard iterates the
 * whole derived family instead of naming `error`.
 *
 * A FILL OWES TWO BARS, and the fix must move the right one:
 *   - 4.5:1 against its own LABEL (text sits on the fill)
 *   - 3.0:1 against each SURFACE (the fill doubles as a border/icon accent)
 * Darkening the red to #d32f2f fixes the label (4.98) and breaks the surface
 * use (2.74 on paper). Pinning `contrastText` fixes the label (5.05) and leaves
 * the fill itself untouched. The guard asserts BOTH so a future "fix" cannot
 * trade one bar for the other -- see `references/rendered-pair-not-token-pair.md`.
 *
 * WHY NOT THE OBVIOUS ASSERTION. `contrast(token, background.paper)` for every
 * slot is what a token-vs-surface guard does, and it stays green forever while
 * this defect lives, because the defect is in the DERIVED field. `error.main` on
 * paper is 3.55:1 and perfectly legal; nothing renders it that way.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { realTheme } = require('../helpers/ui-real-theme');

const MIN_LABEL_ON_FILL = 4.5;   // WCAG 2.x SC 1.4.3 -- text on a fill
const MIN_FILL_ON_SURFACE = 3.0;  // SC 1.4.11 -- a fill doubling as border/icon

/** Surfaces the fill may sit on. Read from the theme, not typed in. */
const SURFACE_KEYS = ['default', 'paper'];

/** Semantic slots MUI derives a `contrastText` for (its six colour names). */
const FILLS = ['primary', 'secondary', 'error', 'warning', 'info', 'success'];

// ---- WCAG 2.x relative luminance + contrast (self-checking by specification;
// the formula IS the spec, so known pairs are the control, not a corpus) ----

const parseColour = (value) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(value);
  if (m) {
    const parts = m[1].split(',').map((p) => p.trim());
    return { rgb: parts.slice(0, 3).map(Number), a: parts.length > 3 ? Number(parts[3]) : 1 };
  }
  const h = value.replace('#', '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    // 3-digit shorthand. MUI derives `#fff`, not `#ffffff`, so a parser that
    // only accepts the long form throws on exactly the value under test -- the
    // guard then fails as a CRASH rather than as a verdict, which reads as
    // "unrelated error" and gets triaged away.
    return { rgb: h.split('').map((c) => parseInt(c + c, 16)), a: 1 };
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a colour the maths understands: ${value}`);
  return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
};

/** Composite a translucent colour over an opaque one. A tint measured as if it
 *  were opaque is the trap of measuring a token instead of what renders. */
const over = (fg, bg) => {
  const f = parseColour(fg);
  const b = parseColour(bg);
  return '#' + f.rgb.map((c, i) =>
    Math.round(f.a * c + (1 - f.a) * b.rgb[i])).map((c) => c.toString(16).padStart(2, '0')).join('');
};

const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/**
 * Resolve a possibly-translucent colour against the surface it is actually
 * painted on, THEN take its luminance.
 *
 * The order matters and the naive version gets it wrong. Compositing a
 * translucent label against white rather than against its own fill silently
 * changes the measurement: `rgba(0,0,0,.87)` over white is #212121, over
 * #ff1744 it is #210309, and the two disagree about which bar the label
 * clears. Only the second is what a <Chip> renders. An opaque colour is
 * unaffected, so a control test made only of #rrggbb pairs passes while this
 * is wrong -- which is why the spec-fixed control carries the translucent
 * `rgba` case too.
 */
const resolve = (colour, against) => over(colour, against);
const relLuminance = (hex, against = '#ffffff') => {
  const [r, g, b] = parseColour(resolve(hex, against)).rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  // Each side is resolved against the other, so a tint is measured as it
  // paints rather than as if it were opaque.
  const l1 = relLuminance(a, b);
  const l2 = relLuminance(b, a);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

// ---- The control: the maths itself must be able to fail ----

test('CONTROL: the contrast maths agrees with pairs fixed by the WCAG spec', () => {
  // If this drifts, every verdict below is meaningless -- so it is pinned to
  // figures that are properties of the specification, not of this repo.
  //
  // The translucent cases are load-bearing, not decoration. An all-opaque
  // control passes while `relLuminance` composites against the wrong
  // background, because opacity makes compositing a no-op. These two catch it:
  // the same rgba label clears 4.5 over #ff1744 and fails it over white.
  const cases = [
    ['#000000', '#ffffff', 21],
    ['#ffffff', '#ffffff', 1],
    ['#777777', '#ffffff', 4.48],   // the canonical AA boundary grey
    ['#ff1744', '#ffffff', 3.85],   // the defect this file was written for
    ['rgba(0, 0, 0, 0.87)', '#ff1744', 5.05],   // the pin, resolved on its fill
    ['rgba(0, 0, 0, 0.87)', '#ffffff', 16.10],  // the SAME label on white -- a
      // totally different number, because it composites to #212121 there. The
      // pair of cases is the whole point: identical label, 5.05 vs 16.10, so a
      // maths that ignores the background cannot pass both.
  ];
  for (const [a, b, want] of cases) {
    const got = contrast(a, b);
    assert.ok(Math.abs(got - want) <= 0.02,
      `contrast(${a}, ${b}) is ${got.toFixed(2)}, expected ${want}; ` +
      'the maths is wrong, so every assertion here is unsound');
  }
});

// ---- The principle ----

test('CONTROL: the guard reaches every derived fill, not a hand-picked subset', () => {
  // Enumerating only `error` would reproduce the hardcoded-literal
  // anti-pattern one level up: a fourth fill with a failing derivation would
  // pass silently. Pin the family so the walk cannot narrow.
  const palette = realTheme().palette;
  const present = FILLS.filter((n) => palette[n] && typeof palette[n].main === 'string');
  assert.equal(present.length, FILLS.length,
    `expected all ${FILLS.length} MUI-derived fills, resolved ${present.join(', ')}; ` +
    'a slot can exist without a `.main` step (palette.grey is such a case), so ' +
    'assert on the step the guard reads, not on the slot');
  for (const n of FILLS) {
    assert.ok(typeof palette[n].contrastText === 'string' && palette[n].contrastText,
      `${n} resolved no contrastText -- the label colour is a DERIVED field; ` +
      'if MUI stops deriving it, that is a finding, not a pass');
  }
});

test('every fill paints its label at AA or better', () => {
  const palette = realTheme().palette;
  const failures = [];
  for (const name of FILLS) {
    const { main: fill, contrastText: label } = palette[name];
    const got = contrast(label, fill);   // composite alpha over the fill first
    if (got < MIN_LABEL_ON_FILL) {
      failures.push(
        `${name}: label ${label} on fill ${fill} is ${got.toFixed(2)}:1, ` +
        `below ${MIN_LABEL_ON_FILL}:1`);
    }
  }
  assert.deepEqual(failures, [],
    'a <Chip>/<Badge>/contained <Button> renders this label on this fill.\n' +
    'Fix by pinning `contrastText` on the fill, NOT by darkening the fill:\n' +
    'darkening trades the 4.5 label bar against the 3.0 surface bar below.\n' +
    failures.join('\n'));
});

test('every fill also clears 3:1 against both surfaces, for its border/icon use', () => {
  // The second bar. A fix that darkened a fill to pass the label test must not
  // be allowed to pass this one by breaking the non-text use instead.
  const palette = realTheme().palette;
  const failures = [];
  for (const name of FILLS) {
    for (const key of SURFACE_KEYS) {
      const surface = palette.background[key];
      assert.ok(surface, `palette.background.${key} is missing -- nothing to measure against`);
      const got = contrast(palette[name].main, surface);
      if (got < MIN_FILL_ON_SURFACE) {
        failures.push(
          `${name} ${palette[name].main} on background.${key} ${surface} is ` +
          `${got.toFixed(2)}:1, below ${MIN_FILL_ON_SURFACE}:1`);
      }
    }
  }
  assert.deepEqual(failures, [],
    'the fill doubles as a border and icon accent, so it owes 3:1 on the ' +
    'surface as well as 4.5:1 to its label:\n' + failures.join('\n'));
});

test('the fix moved the DERIVED value, not the fill', () => {
  // A regression guard on the shape of the repair, not on its outcome.
  //
  // A first draft of this file also asserted that the six fills must resolve
  // DIFFERENT labels, on the theory that uniformity meant a derivation had been
  // bypassed. That was wrong: uniform labels are the correct end state, so the
  // assertion failed the moment the fix landed and would have pressured a
  // future editor to reintroduce the defect. What actually has to hold is that
  // the fill did not move -- so that every border, icon and outline drawn in
  // #ff1744 keeps the exact pixels it had.
  const palette = realTheme().palette;
  assert.equal(palette.error.main, '#ff1744',
    'error.main moved: the repair must pin the derived contrastText, because ' +
    'the fill doubles as a border/icon accent and darkening it breaks the 3:1 ' +
    'surface bar the guard above asserts');
});