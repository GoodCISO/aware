/**
 * CommonJS view of the UI-side ESM severity modules.
 *
 * The modules under src/ui/src are ESM because react-scripts' webpack runs
 * with strict ESM and does NOT apply Node's CommonJS named-export interop --
 * a CJS module imported from a React component fails the production build
 * ("Attempted import error: 'normalizeAnomalies' is not exported from ...").
 * The node --test suite, however, runs under CommonJS.
 *
 * This shim bridges the two for tests only: the app never imports it, so it
 * cannot become a way for the UI to reach CJS and quietly break a build.
 * Dynamic import() returns the module namespace, from which both the named
 * and default exports are reachable.
 */

'use strict';

module.exports = {
  severity: () => import('../../../src/ui/src/constants/severity.js'),
  severityRamp: () => import('../../../src/ui/src/styles/severityRamp.js'),
  domainAliases: () => import('../../../src/ui/src/styles/domainAliases.js'),
};
