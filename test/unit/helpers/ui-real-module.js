/**
 * A CommonJS VIEW OF A REAL src/ui/src MODULE (ESM + JSX).
 *
 * Companion to helpers/ui-real-theme.js, which does the same for theme.js.
 * src/ui/src is ESM (react-scripts' webpack applies no Node CJS interop --
 * see helpers/ui-esm.js) and the components are additionally JSX, which plain
 * Node cannot parse at all. So the file is transformed to CommonJS in memory
 * with the REAL filename, which keeps Node's node_modules resolution pointed
 * at src/ui where react / @mui/material actually live.
 *
 * Why this must not be skipped when babel is missing: the seam guard in
 * test/unit/api/severity-seam.test.js renders the real component against a
 * real server payload. A harness that quietly fell back to reading component
 * SOURCE would turn that guard into the grep it was written to replace --
 * the exact §4c shape (a suite that passes on a broken tree because it never
 * crosses the seam). Failing loudly keeps the guard meaningful or absent.
 */

'use strict';

const path = require('node:path');
const Module = require('node:module');

const UI_DIR = path.resolve(__dirname, '../../../src/ui');

let babelCache = null;
const moduleCache = new Map();

function loadBabel() {
  if (babelCache) return babelCache;
  let babel;
  let cjsPlugin;
  let presetReact;
  try {
    babel = require(path.join(UI_DIR, 'node_modules/@babel/core'));
    cjsPlugin = require(path.join(UI_DIR, 'node_modules/@babel/plugin-transform-modules-commonjs'));
    presetReact = require(path.join(UI_DIR, 'node_modules/@babel/preset-react'));
  } catch (err) {
    throw new Error(
      `cannot load real UI modules: babel is not resolvable from ${UI_DIR}. ` +
      'The severity seam guard renders the REAL component; without this it can ' +
      'only read source text, which is the failure it exists to catch. Install ' +
      'devDependencies in src/ui rather than deleting this helper. Cause: ' + err.message,
    );
  }
  babelCache = { babel, cjsPlugin, presetReact };
  return babelCache;
}

/**
 * Transform a src/ui/src module to CommonJS in memory and evaluate it.
 *
 * Cached per path, exactly as Node's own require() caches: loading a module
 * twice would hand back two distinct objects for the same file, so a guard
 * asserting "this is the real module" could never compare equal to a second
 * load. A guard that cannot pass is worse than no guard.
 *
 * @param {string} relPath path relative to src/ui/src, e.g. 'components/AnomalyDetectionAlerts.js'
 * @returns {object} the module's exports
 */
function loadUiModule(relPath) {
  if (moduleCache.has(relPath)) return moduleCache.get(relPath);

  const { babel, cjsPlugin, presetReact } = loadBabel();
  const absPath = path.join(UI_DIR, 'src', relPath);

  const { code } = babel.transformFileSync(absPath, {
    plugins: [cjsPlugin],
    // JSX only. The constants/styles modules do not use it, but applying it
    // unconditionally keeps one code path for every module loaded here.
    presets: [presetReact],
    cwd: UI_DIR,
    babelrc: false,
    configFile: false,
  });

  const mod = new Module(absPath, null);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  mod._compile(code, absPath);
  moduleCache.set(relPath, mod.exports);
  return mod.exports;
}

module.exports = { loadUiModule, UI_DIR };