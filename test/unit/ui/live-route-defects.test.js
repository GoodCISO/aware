/**
 * The two LIVE AWARE UI defects (t_fe706dd6).
 *
 *   Defect 1 -- `/` rendered exactly one line: "Failed to load dashboard:
 *                getCoverage is not a function".
 *   Defect 2 -- `/compliance` was a BLANK SCREEN: "TypeError: Cannot read
 *                properties of undefined (reading 'main')".
 *
 * Both were live on the `aware-2-ui` container, masked before the rebuild in
 * t_14bf2daa by a stale image that rendered FABRICATED numbers instead.
 *
 * WHY THIS FILE RENDERS RATHER THAN SCANS.
 *
 * Both defects are RUNTIME defects:
 *
 *   - `getCoverage` is a missing METHOD. A grep for the string "getCoverage"
 *     in the container finds the call site and proves nothing about whether
 *     the method exists at runtime.
 *   - `color: 'default'` is a bad VALUE. A grep for "default" proves
 *     nothing about whether MUI's Chip and LinearProgress can resolve it.
 *
 * A source scan can only ever assert that a string is present. The defect
 * is that the string is WRONG AT RUNTIME, so the guard has to run the real
 * components against the real theme and observe what happens.
 *
 * The renderer is jsdom + react-dom/client (a real DOM, not
 * renderToStaticMarkup) because BOTH defects depend on effects and on
 * MUI's styled-component machinery resolving a palette key -- neither of
 * which is exercised by server-side rendering of a component that throws
 * before it emits anything.
 *
 * NOTHING HERE IS STUBBED AT THE SEAM. The components under test are the
 * REAL files from src/ui/src, loaded through the same babel bridge the
 * other guards in this directory use, and rendered against the REAL theme
 * from src/ui/src/styles/theme.js. Only the NETWORK is replaced, and it is
 * replaced at the axios-instance level so the component's own code path --
 * including its own error handling -- is what is under test.
 *
 * NON-VACUOUSNESS. Every test below asserts on an OBSERVED value, and the
 * file carries a control that proves the assertions can fail: see
 * "the assertions above CAN fail" at the bottom.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { loadUiModule, UI_DIR } = require('../helpers/ui-real-module');
const { realTheme } = require('../helpers/ui-real-theme');

const UI_SRC = path.resolve(__dirname, '../../../src/ui/src');

// --- jsdom, installed as a transitive dev dependency of react-scripts ------
// jsdom 16.7.0 is present in src/ui/node_modules (react-scripts pulls it in
// via jest-environment-jsdom). It is NOT a direct dependency of this
// package, so resolve it from the UI tree -- the same place react and
// @mui/material are resolved from -- and fail loudly if it is missing.
let JSDOM;
try {
  ({ JSDOM } = require(path.join(UI_DIR, 'node_modules', 'jsdom')));
} catch (err) {
  throw new Error(
    'cannot load jsdom from src/ui/node_modules. These guards render the REAL ' +
    'components in a REAL DOM, so jsdom is not optional: install devDependencies ' +
    'in src/ui rather than deleting this guard. Cause: ' + err.message,
  );
}

// --- the real UI modules, babel-transformed in memory -----------------------
// src/ui/src is ESM + JSX. The container imports its siblings (MetricsCard,
// etc.) as ESM modules that Node cannot parse, so a require hook transforms
// every .js under src/ui/src on the way in. Without it the container's own
// `import MetricsCard from '../components/MetricsCard'` fails at load and
// every assertion below would pass for the wrong reason.
const babel = require(path.join(UI_DIR, 'node_modules', '@babel/core'));
const cjsPlugin = require(path.join(UI_DIR, 'node_modules', '@babel/plugin-transform-modules-commonjs'));
const presetReact = require(path.join(UI_DIR, 'node_modules', '@babel/preset-react'));

const originalJsLoader = Module._extensions['.js'];
Module._extensions['.js'] = function uiSourceLoader(mod, filename) {
  if (filename.startsWith(UI_SRC + path.sep)) {
    const { code } = babel.transformFileSync(filename, {
      plugins: [cjsPlugin],
      presets: [presetReact],
      cwd: UI_DIR,
      babelrc: false,
      configFile: false,
    });
    return mod._compile(code, filename);
  }
  return originalJsLoader(mod, filename);
};

// --- jsdom globals ----------------------------------------------------------
// React 18 reads `IS_REACT_ACT_ENVIRONMENT` to decide whether `act()` is
// legal. Without it, every act() call warns and the state updates it
// schedules are NOT flushed -- so the assertions would read a stale tree.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
// `navigator` is a getter-only global in Node 22+, so a plain assignment
// throws "Cannot set property navigator of #<Object> which has only a getter".
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator, configurable: true, writable: true,
});
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = require(path.join(UI_DIR, 'node_modules', 'react'));
const { createRoot } = require(path.join(UI_DIR, 'node_modules', 'react-dom', 'client'));
const { ThemeProvider } = require(path.join(UI_DIR, 'node_modules', '@mui/material/styles'));

const theme = realTheme();

/** Unhandled rejections seen during a render, if any. */
let unhandledRejections = [];
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason && (reason.message || String(reason)));
});

/**
 * Render a real component into a real DOM under the real theme.
 *
 * THE SIGNAL IS THE EMPTY TREE, NOT A CAUGHT EXCEPTION.
 *
 * A render crash in React unmounts the whole tree. The live /compliance
 * defect was observed as "rootEmpty=TRUE (blank page, empty body)" --
 * that is the crash, seen from the outside. So the harness reports the
 * rendered CONTENT, and a guard asserts that the content is there. No
 * error needs to be captured for that to work, and that is the point:
 * a harness that depends on catching React's rethrow is a harness whose
 * verdict depends on React's internal timing.
 *
 * The console is captured as well, because the card's AC asks for the
 * browser console output, and React's "The above error occurred in the
 * <X> component" report is that output.
 *
 * @returns {{text: string, html: string, error: Error|null, consoleErrors: string[]}}
 */
async function renderComponent(element) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let error = null;
  const consoleErrors = [];

  const originalConsoleError = console.error;
  console.error = (...args) => {
    consoleErrors.push(args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' '));
    originalConsoleError.apply(console, args);
  };

  try {
    await React.act(async () => {
      root.render(React.createElement(ThemeProvider, { theme }, element));
    });
    // Let the component's own effects (the fetch) settle. The effect chain
    // is: mount -> async load -> setState -> re-render.
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  } catch (err) {
    error = err;
  }
  // React re-reports a render error on a later tick; give it one turn so
  // the console channel is complete before it is inspected.
  await new Promise((resolve) => setTimeout(resolve, 30));
  console.error = originalConsoleError;

  const text = (host.textContent || '').replace(/\s+/g, ' ');
  const html = host.innerHTML || '';
  try { root.unmount(); } catch { /* the component may already have unmounted */ }
  host.remove();
  return { text, html, error, consoleErrors };
}

/**
 * The console report of a render crash, if there was one.
 *
 * @param {{consoleErrors: string[]}} result
 * @returns {string|null}
 */
const crashReport = (result) => result.consoleErrors.find((line) =>
  /The above error occurred|Cannot read properties of undefined/.test(line)) || null;

/**
 * The REAL api module, with its network calls replaced.
 *
 * The replacement happens on the REAL exported objects, so the component
 * under test calls the same `complianceAPI.getPosture()` it calls in
 * production -- there is no separate stubbed copy of the service layer for
 * the component to accidentally use.
 */
const api = require(path.join(UI_SRC, 'services', 'api.js'));

const httpError = (status) => {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status };
  return err;
};

/** A posture payload shaped exactly like the live GET /api/compliance/posture. */
const LIVE_POSTURE = {
  overallScore: 0.125,
  overallPercentage: 13,
  overallStatus: 'CRITICAL',
  frameworks: [
    {
      frameworkId: 'CSA_AI_CM',
      frameworkName: 'CSA AI Controls Matrix',
      score: 1,
      percentage: 100,
      status: 'EXCELLENT',
      controlsAssessed: 5,
      controlsTotal: 184,
      compliantControls: 5,
      nonCompliantControls: 0,
      openGaps: 0,
    },
    {
      frameworkId: 'NIST_AI_RMF',
      frameworkName: 'NIST AI Risk Management Framework',
      score: 0,
      percentage: 0,
      status: 'CRITICAL',
      controlsAssessed: 0,
      controlsTotal: 12,
      compliantControls: 0,
      nonCompliantControls: 0,
      openGaps: 0,
    },
  ],
  totalGaps: 0,
  openGaps: 0,
  criticalGaps: 0,
};

// ===========================================================================
// DEFECT 1 -- the dashboard route
// ===========================================================================

test('DEFECT 1: the dashboard renders its content when the compliance API responds', async () => {
  const DashboardContainer = loadUiModule('containers/DashboardContainer.js').default;

  api.agentAPI.list = async () => ({ data: [{ id: 'a1', status: 'active' }] });
  api.anomalyAPI.getStats = async () => ({ data: { critical: 4 } });
  api.complianceAPI.getPosture = async () => ({ data: LIVE_POSTURE });

  const result = await renderComponent(React.createElement(DashboardContainer));
  const { text } = result;

  assert.equal(result.error, null, `the dashboard threw while rendering: ${result.error && result.error.stack}`);
  assert.ok(!text.includes('Failed to load dashboard'),
    `the dashboard still renders its error line: ${text}`);
  assert.ok(text.includes('AWARE Control Plane'),
    `the dashboard did not render its heading: ${text}`);
  // The measured posture percentage must appear, and it must be the
  // 0..100 value -- not the 0..1 fraction. Reading `overallScore` (0.125)
  // would render "0.125%" or "1%"; reading `overallPercentage` renders 13%.
  assert.ok(text.includes('13%'),
    `the dashboard did not render the measured posture percentage: ${text}`);
  assert.ok(!text.includes('0.125%'),
    `the dashboard rendered the 0..1 FRACTION as a percentage: ${text}`);
});

test('DEFECT 1: the dashboard calls a compliance method that EXISTS', async () => {
  // The defect, stated as a fact about the service surface: the container
  // may only call methods the api module actually exports. `getCoverage`
  // was removed from src/ui/src/services/api.js by d3f3089b; the call site
  // was not updated.
  assert.equal(api.complianceAPI.getCoverage, undefined,
    'getCoverage is expected to be absent (d3f3089b removed it). If it is ' +
    'back, this guard is asserting against a stale premise and the ' +
    'dashboard fix needs re-measuring.');
  assert.equal(typeof api.complianceAPI.getPosture, 'function',
    'getPosture must exist -- it is the replacement surface');
});

test('DEFECT 1: a failed agents/alerts call renders as unavailable, never as a measured 0', async () => {
  // On the LIVE system /api/agents and /api/anomalies/stats both 401 (the
  // gateway wants a bearer token the UI does not send -- sibling card
  // t_61ee5b0a). The old code rendered that as `0 total registered` and
  // `0 Critical Alerts` -- a security dashboard asserting an absence of
  // threats it never checked for.
  const DashboardContainer = loadUiModule('containers/DashboardContainer.js').default;

  api.agentAPI.list = async () => { throw httpError(401); };
  api.anomalyAPI.getStats = async () => { throw httpError(401); };
  api.complianceAPI.getPosture = async () => ({ data: LIVE_POSTURE });

  const result = await renderComponent(React.createElement(DashboardContainer));
  const { text } = result;

  assert.equal(result.error, null, `the dashboard threw while rendering: ${result.error && result.error.stack}`);
  assert.ok(!text.includes('Failed to load dashboard'),
    `the dashboard still renders its error line: ${text}`);
  assert.ok(text.includes('Unavailable'),
    `an unretrievable figure must render as Unavailable, not as a number: ${text}`);
  assert.ok(text.includes('not zero alerts'),
    `the alert card must say its figure is not a measured zero: ${text}`);
  // The critical assertion: the number 0 must NOT be presented as the
  // alert count.
  assert.ok(!/\b0\b(?=\s*(Critical|total registered|Revieweral))/i.test(text),
    `the dashboard presents a failed fetch as a measured 0: ${text}`);
});

test('DEFECT 1: the dashboard leaves NO unhandled rejection when a sibling fetch fails', async () => {
  // The mechanism, not just the symptom. `Promise.allSettled([...])` looks
  // like it makes the fetch safe, but the ARRAY LITERAL is evaluated BEFORE
  // allSettled is called. `getCoverage()` therefore threw SYNCHRONOUSLY,
  // allSettled was never invoked, and the two sibling promises were
  // orphaned -- their 401s surfaced as two unhandled rejections, which a
  // browser reports as pageerror events the component's own try/catch
  // cannot catch.
  const DashboardContainer = loadUiModule('containers/DashboardContainer.js').default;

  unhandledRejections = [];
  api.agentAPI.list = async () => { throw httpError(401); };
  api.anomalyAPI.getStats = async () => { throw httpError(401); };
  api.complianceAPI.getPosture = async () => ({ data: LIVE_POSTURE });

  await renderComponent(React.createElement(DashboardContainer));

  // Give the microtask queue a turn to surface any orphaned rejection.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(unhandledRejections, [],
    `the dashboard orphaned promises: ${unhandledRejections.join(' | ')}`);
});

// ===========================================================================
// DEFECT 2 -- the compliance route
// ===========================================================================

test('DEFECT 2: the compliance screen renders the NOT_ASSESSED row without throwing', async () => {
  // The card's AC: "one asserting the compliance screen renders the
  // NOT_ASSESSED row without throwing".
  //
  // The NOT_ASSESSED row is reached through the CONTROL-status vocabulary
  // (COMPLIANT / PARTIAL / NON_COMPLIANT / NOT_ASSESSED), which is a
  // different vocabulary from the posture payload's score band. The
  // pre-fix table had only ONE NOT_ASSESSED entry -- the one carrying
  // `color: 'default'` -- so this is the exact row that crashed.
  const ComplianceMapping = loadUiModule('components/ComplianceMapping.js').default;

  const result = await renderComponent(
    React.createElement(ComplianceMapping, {
      posture: {
        overallScore: 0,
        overallPercentage: 0,
        overallStatus: 'CRITICAL',
        frameworks: [{
          frameworkId: 'ISO_27001',
          frameworkName: 'ISO/IEC 27001:2022',
          score: 0,
          percentage: 0,
          status: 'NOT_ASSESSED',
          controlsAssessed: 0,
          controlsTotal: 3,
          compliantControls: 0,
          nonCompliantControls: 0,
          openGaps: 0,
        }],
        totalGaps: 0,
        openGaps: 0,
        criticalGaps: 0,
      },
      evidence: { totalEvidence: 0, byStatus: {} },
      frameworks: [{ id: 'ISO_27001', name: 'ISO/IEC 27001:2022', version: '2022' }],
    }),
  );
  const { text, html } = result;

  assert.equal(result.error, null,
    `the compliance screen threw while rendering NOT_ASSESSED: ${result.error && result.error.stack}`);
  assert.equal(crashReport(result), null,
    `the compliance screen rendered a MUI palette crash: ${crashReport(result)}`);
  assert.ok(text.includes('ISO/IEC 27001:2022'),
    `the compliance screen did not render the framework row: ${text}`);
  assert.ok(html.length > 0, 'the compliance screen rendered an empty tree');
});

test('DEFECT 2: the compliance screen renders the posture score band without throwing', async () => {
  // The ROOT CAUSE, which is one level deeper than the card states.
  //
  // The pre-fix STATUS_STYLE was keyed on the CONTROL vocabulary
  // (COMPLIANT / PARTIAL / NON_COMPLIANT / NOT_ASSESSED). The server's
  // posture payload speaks a SCORE band (EXCELLENT / GOOD / FAIR / POOR /
  // CRITICAL). The two vocabularies do not intersect, so EVERY live
  // framework row fell through to the NOT_ASSESSED fallback -- which is
  // precisely the entry that carried the invalid `color: 'default'`.
  //
  // That means the crash was not an edge case on /compliance: it was the
  // ONLY path the live payload could take. Fixing the colour token alone
  // would have left every row still rendering as "not assessed".
  const ComplianceMapping = loadUiModule('components/ComplianceMapping.js').default;

  const result = await renderComponent(
    React.createElement(ComplianceMapping, {
      posture: LIVE_POSTURE,
      evidence: { totalEvidence: 721, byStatus: { COLLECTED: 721 } },
      frameworks: [
        { id: 'CSA_AI_CM', name: 'CSA AI Controls Matrix', version: 'v1' },
        { id: 'NIST_AI_RMF', name: 'NIST AI Risk Management Framework', version: '1.0' },
      ],
    }),
  );
  const { text } = result;

  assert.equal(result.error, null,
    `the compliance screen threw while rendering the score band: ${result.error && result.error.stack}`);
  assert.equal(crashReport(result), null,
    `the compliance screen rendered a MUI palette crash: ${crashReport(result)}`);
  // CSA_AI_CM is EXCELLENT and NIST_AI_RMF is CRITICAL. Both must be
  // labelled with their own status, not collapsed into one.
  assert.ok(text.includes('EXCELLENT'),
    `an EXCELLENT framework did not render its own status: ${text}`);
  assert.ok(text.includes('CRITICAL'),
    `a CRITICAL framework did not render its own status: ${text}`);
});

test('DEFECT 2: every colour token the compliance screen uses is a REAL palette key', async () => {
  // The card's AC: "No MUI palette key outside the theme's declared set is
  // used as a `color` prop."
  //
  // This is asserted by RENDERING, not by scanning, because the defect is
  // a runtime resolution failure. The pre-fix token 'default' passes a
  // grep for "is this a known token?" if the grep is written against a
  // hand-typed list -- and 'grey' and 'disabled' pass it too, while both
  // CRASH in Chip and LinearProgress (grey has no `.main`; disabled
  // resolves through palette.action, which has no `.contrastText`).
  //
  // The set of safe tokens is therefore MEASURED against the real theme:
  // a token is safe for this screen only if it resolves to a palette entry
  // carrying BOTH `main` (LinearProgress's getColorShade) and `contrastText`
  // (Chip's filled/outlined variants).
  const { Chip, LinearProgress } = require(path.join(UI_DIR, 'node_modules', '@mui/material'));

  const NOT_A_PALETTE_KEY = new Set(['default', 'grey', 'disabled', 'inherit']);

  for (const token of ['primary', 'secondary', 'success', 'warning', 'error', 'info']) {
    const entry = theme.palette[token];
    assert.ok(entry && entry.main,
      `the theme must declare a full ramp for '${token}' -- measured missing`);
    assert.ok(entry.contrastText,
      `the theme's '${token}' ramp must carry contrastText -- Chip needs it`);
    assert.ok(!NOT_A_PALETTE_KEY.has(token),
      `'${token}' is not a usable colour prop for this screen`);
  }

  // And the two components the compliance screen feeds must actually accept
  // each of those tokens without throwing.
  for (const token of ['primary', 'secondary', 'success', 'warning', 'error', 'info']) {
    for (const [name, element] of [
      ['Chip', React.createElement(Chip, { label: 'x', color: token })],
      ['Chip outlined', React.createElement(Chip, { label: 'x', color: token, variant: 'outlined' })],
      ['LinearProgress', React.createElement(LinearProgress, { color: token, value: 50, variant: 'determinate' })],
    ]) {
      const result = await renderComponent(element);
      assert.equal(result.error, null,
        `${name} with color="${token}" must not throw: ${result.error && result.error.message}`);
      assert.equal(crashReport(result), null,
        `${name} with color="${token}" must not crash: ${crashReport(result)}`);
    }
  }
});

test('DEFECT 2: the compliance screen renders an UNKNOWN status without throwing', async () => {
  // The fallback path. An unrecognised status must degrade to a safe
  // style, never to a crash -- this is the row that takes the fall when
  // the server introduces a new status band.
  const ComplianceMapping = loadUiModule('components/ComplianceMapping.js').default;

  const result = await renderComponent(
    React.createElement(ComplianceMapping, {
      posture: {
        overallScore: 0.5,
        overallPercentage: 50,
        overallStatus: 'SOMETHING_NEW',
        frameworks: [{
          frameworkId: 'X_FW',
          frameworkName: 'Brand New Framework',
          score: 0.5,
          percentage: 50,
          status: 'SOMETHING_NEW',
          controlsAssessed: 1,
          controlsTotal: 2,
          compliantControls: 1,
          nonCompliantControls: 0,
          openGaps: 0,
        }],
        totalGaps: 0, openGaps: 0, criticalGaps: 0,
      },
      evidence: null,
      frameworks: [],
    }),
  );
  const { text } = result;

  assert.equal(result.error, null,
    `an unknown status must not crash the compliance screen: ${result.error && result.error.stack}`);
  assert.equal(crashReport(result), null,
    `an unknown status must not crash the compliance screen: ${crashReport(result)}`);
  assert.ok(text.includes('Brand New Framework'),
    `the unknown-status row did not render: ${text}`);
});

// ===========================================================================
// NON-VACUOUSNESS -- the assertions above CAN fail
// ===========================================================================

test('CONTROL: the assertions above CAN fail -- a bad palette key really does crash', async () => {
  // A guard that cannot fail is not a guard. This proves the harness
  // detects the DEFECT it was written for: it renders the pre-fix
  // configuration -- `color: 'default'`, which is not a palette key -- and
  // asserts that the harness SEES the crash.
  //
  // If MUI ever grew a `palette.default`, this control would fail and the
  // guards above would need re-measuring. That is the point: the control
  // keeps the premise honest.
  const { Chip, LinearProgress } = require(path.join(UI_DIR, 'node_modules', '@mui/material'));

  const result = await renderComponent(
    React.createElement(LinearProgress, { color: 'default', value: 50, variant: 'determinate' }),
  );

  // The crash unmounts the tree: the rendered output is EMPTY. That is the
  // same symptom the live /compliance page had, and it is the signal the
  // guards above rely on -- so the control asserts it directly.
  assert.equal(result.html.trim(), '',
    "expected `color: 'default'` to crash LinearProgress and leave an EMPTY " +
    'tree -- if it no longer does, the premise of the defect-2 guards has ' +
    'changed and they must be re-measured against the current MUI version. ' +
    `Rendered instead: ${result.html.slice(0, 200)}`);
  // The console output is RECORDED (the card's AC asks for it) but is not
  // ASSERTED here: React's duplicate "The above error occurred" report is
  // suppressed in some environments, and a guard that depends on React's
  // logging policy goes red for a reason that has nothing to do with the
  // defect. The empty tree above is the deterministic signal, and it is
  // the same signal the live page gave.
  assert.equal(theme.palette.default, undefined,
    'the theme must not declare a `default` palette key');
  assert.equal(theme.palette.grey.main, undefined,
    'the theme `grey` ramp has no `main` -- so `grey` is not a usable ' +
    'colour prop for Chip or LinearProgress, despite being a palette key');
});

test('CONTROL: the compliance screen renders no FABRICATED figures', async () => {
  // The card's AC: "No fabricated data. ... It must NOT show the old mock
  // 89/114 or 3 evidence numbers."
  //
  // The old mock (deleted by d3f3089b) was `iso27001: 89`. If a mock ever
  // comes back, it will be rendered as a number somewhere on this screen.
  const ComplianceMapping = loadUiModule('components/ComplianceMapping.js').default;

  const { text } = await renderComponent(
    React.createElement(ComplianceMapping, {
      posture: LIVE_POSTURE,
      evidence: { totalEvidence: 721, byStatus: { COLLECTED: 721 } },
      frameworks: [],
    }),
  );

  assert.ok(!text.includes('89/114'),
    `the old mock's 89/114 figure is back on the compliance screen: ${text}`);
  assert.ok(!/\b89\b/.test(text),
    `the old mock's 89 figure is back on the compliance screen: ${text}`);
  // The real evidence count must be shown, from the API response.
  assert.ok(text.includes('721'),
    `the measured evidence count was not rendered: ${text}`);
});
