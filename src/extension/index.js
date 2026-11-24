// src/extension/index.js
// AWARE extension contract — public entry point.
//
// This is the surface a third party implements against. It is Apache-2.0 and
// ships publicly. It contains no knowledge of any commercial product.
//
// Usage:
//
//   const { ExtensionRegistry, AWARE_EXTENSION_CONTRACT_VERSION } = require('@goodciso/aware/src/extension');
//
//   const registry = new ExtensionRegistry();
//   registry.register({
//     name: 'my-adapter',
//     onDecision(event) { /* ... */ },
//     onAuditAppend(event) { /* ... */ },
//   });
//
// See docs/adr/ADR-081-aware-editions-and-extension-contract.md for the
// rationale and the compatibility rules.

'use strict';

const {
  AWARE_EXTENSION_CONTRACT_VERSION,
  DECISION_SHAPE,
  DECISION_EVENT_SHAPE,
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
  KNOWN_METHODS,
  validateExtension,
} = require('./contract');

const { ExtensionRegistry } = require('./registry');

/**
 * The process-wide registry.
 *
 * A single registry, because the extension point is a property of the
 * running engine, not of an individual caller. A caller that needs isolation
 * can construct its own ExtensionRegistry.
 */
const registry = new ExtensionRegistry();

module.exports = {
  AWARE_EXTENSION_CONTRACT_VERSION,
  DECISION_SHAPE,
  DECISION_EVENT_SHAPE,
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
  KNOWN_METHODS,
  validateExtension,
  ExtensionRegistry,
  registry,
};
