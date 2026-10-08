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

test('the guards above walk real files, not an empty path', () => {
  // Precondition for the file scans: pin two of the files they read so a
  // directory rename cannot turn "0 offenders" into a vacuous pass.
  for (const rel of ['components/AppHeader.js', 'components/AppSidebar.js', 'components/StatusIndicator.js']) {
    assert.ok(TREE.includes(path.join(UI_SRC, rel)), `scan is missing ${rel}`);
  }
});