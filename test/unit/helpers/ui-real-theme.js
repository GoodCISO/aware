/**
 * A CommonJS VIEW OF THE REAL src/ui/src/styles/theme.js.
 *
 * Why this exists: the guards in test/unit/ui/ must assert against the palette
 * the app actually ships, not against a hand-typed copy of it. A copy drifts
 * the moment the theme moves, and then the guard is asserting that the copy
 * agrees with itself. This helper loads the real module so "the severity ramp
 * must not alias a semantic colour" is checked against every colour the theme
 * actually contains, including ones nobody thought to type into the test.
 *
 * Why it needs babel: src/ui/src is ESM (react-scripts' webpack applies no
 * Node CJS interop -- see helpers/ui-esm.js), and theme.js imports
 * `@mui/material/styles`, which Node cannot resolve as a directory import from
 * an ESM context. So the file is transformed to CommonJS in memory and
 * compiled with the REAL filename, which keeps Node's node_modules resolution
 * pointed at src/ui where @mui/material actually lives.
 *
 * This is deliberately not a second source of colour truth. If @babel/core is
 * missing we fail loudly rather than skipping: a test that silently skips when
 * a helper is missing is worse than no test (severity-ramp.test.js header).
 */

'use strict';

const path = require('node:path');
const Module = require('node:module');

const UI_DIR = path.resolve(__dirname, '../../../src/ui');
const THEME_PATH = path.join(UI_DIR, 'src/styles/theme.js');

let cached = null;

/**
 * @returns {object} the real MUI theme object from src/ui/src/styles/theme.js
 */
function realTheme() {
  if (cached) return cached;

  let babel;
  let cjsPlugin;
  try {
    babel = require(path.join(UI_DIR, 'node_modules/@babel/core'));
    cjsPlugin = require(path.join(UI_DIR, 'node_modules/@babel/plugin-transform-modules-commonjs'));
  } catch (err) {
    throw new Error(
      `cannot load the real theme: @babel/core is not resolvable from ${UI_DIR}. ` +
      'The palette guards are meaningless without it -- install devDependencies ' +
      'in src/ui rather than deleting this helper. Cause: ' + err.message,
    );
  }

  const { code } = babel.transformFileSync(THEME_PATH, {
    plugins: [cjsPlugin],
    cwd: UI_DIR,
    babelrc: false,
    configFile: false,
  });

  const mod = new Module(THEME_PATH, null);
  mod.filename = THEME_PATH;
  mod.paths = Module._nodeModulePaths(path.dirname(THEME_PATH));
  mod._compile(code, THEME_PATH);

  cached = mod.exports.default;
  if (!cached || !cached.palette) {
    throw new Error(`real theme at ${THEME_PATH} exported no palette -- the guard would assert against undefined`);
  }
  return cached;
}

/**
 * Walk a resolved MUI palette into [{ owner, value }] leaves.
 *
 * `owner` is a dotted path ('error.main', 'severity.LOW', 'text.muted').
 * Functions (getContrastText, augmentColor, ...) and non-string leaves are
 * dropped: this walks COLOURS, and a function is not a colour.
 *
 * @param {object} palette resolved theme.palette
 * @returns {{owner: string, value: string}[]}
 */
function paletteColours(palette) {
  const out = [];
  const SKIP_KEYS = new Set([
    'common', 'grey', 'augmentColor', 'contrastThreshold',
    'getContrastText', 'tonalOffset', 'mode', 'divider', 'action',
  ]);
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node || {})) {
      const owner = prefix ? `${prefix}.${key}` : key;
      if (SKIP_KEYS.has(key)) continue;
      if (typeof value === 'string') {
        out.push({ owner, value });
      } else if (value && typeof value === 'object') {
        walk(value, owner);
      }
    }
  };
  walk(palette, '');
  return out;
}

module.exports = { realTheme, paletteColours, THEME_PATH };