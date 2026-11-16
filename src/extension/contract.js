// src/extension/contract.js
// AWARE extension contract — the public, versioned seam between the engine
// and anything built on top of it.
//
// WHY THIS EXISTS
// ---------------
// AWARE is Apache-2.0 and public. It stays that way. But a public engine with
// no integration surface is a project nobody can build on, and a project that
// embeds "is this customer a paying customer?" logic is a project nobody can
// trust.
//
// So the core publishes a small, explicit contract. Implementations of that
// contract — the hosted commercial service, a community adapter, a customer's
// own integration — all use the SAME surface. None of them is a special case.
//
// WHAT THIS FILE MUST NOT CONTAIN
// -------------------------------
// No notion of a plan, tier, entitlement, licence, subscription, or price.
// The core does not know those things exist, and a future reader of this
// file should not be able to guess that they do. That is a deliberate
// property, not an oversight, and it is enforced by review (see
// docs/adr/ADR-081).
//
// COMPATIBILITY
// -------------
// This contract has its own integer version, independent of the package
// version. It is bumped only on a BREAKING change to the surface below.
// Additive changes (a new optional hook, a new optional field) do not bump
// it. A breaking change to this contract is a MAJOR release of the package.
//
// Implementations SHOULD depend on the core with a caret range and SHOULD be
// tested against the LATEST published version, not a pinned one.

'use strict';

/**
 * The contract version. Bump on a breaking change only.
 *
 * @type {number}
 */
const AWARE_EXTENSION_CONTRACT_VERSION = 1;

/**
 * The decision surface an implementation may rely on.
 *
 * A decision is what the policy engine returns for one tool call. The shape
 * is exactly what src/policies/engine.js returns today. This object is the
 * PROMISE, and it is what the contract test asserts.
 */
const DECISION_SHAPE = Object.freeze({
  decision: 'string',      // ALLOW | DENY | AUDIT | NO_POLICY (and future values)
  reason: 'string',        // human-readable explanation
  policyId: 'string|null', // the policy that produced it, if any
  riskLevel: 'string',     // risk level of the tool
  requiresApproval: 'boolean',
});

/**
 * The decision-event surface.
 *
 * A decision event is the record written to the audit chain. Its shape is
 * what src/audit/decision-logger.js requires today.
 */
const DECISION_EVENT_SHAPE = Object.freeze({
  decisionId: 'string',
  parentDecisionId: 'string',
  timestamp: 'string',
  actor: 'string',
  action: 'string',
  context: 'object',
  outcome: 'string',
});

/**
 * The named methods every implementation MUST provide.
 *
 * These are the promises. The contract test asserts that a registered
 * extension actually has them AND that calling them works.
 */
const REQUIRED_METHODS = Object.freeze([
  'onDecision',   // (event) => void | Promise<void>
  'onAuditAppend', // (event) => void | Promise<void>
]);

/**
 * The named methods an implementation MAY provide.
 *
 * Optional hooks. The core calls them when present and does nothing when
 * absent. An implementation MUST tolerate any of them being absent.
 */
const OPTIONAL_METHODS = Object.freeze([
  'onEngineReady', // (engine) => void | Promise<void>
  'onShutdown',    // () => void | Promise<void>
]);

/**
 * Every method name the core may call on an extension.
 */
const KNOWN_METHODS = Object.freeze([...REQUIRED_METHODS, ...OPTIONAL_METHODS]);

/**
 * Validate that an object satisfies the contract.
 *
 * Fail-closed: a malformed extension is rejected, not partially accepted.
 * A half-registered extension that silently never receives an event is
 * worse than no extension, because it looks like it is working.
 *
 * @param {object} extension
 * @returns {{valid: boolean, problems: string[]}}
 */
function validateExtension(extension) {
  const problems = [];

  if (!extension || typeof extension !== 'object') {
    return { valid: false, problems: ['extension must be an object'] };
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof extension[method] !== 'function') {
      problems.push(`missing required method: ${method}()`);
    }
  }

  for (const method of OPTIONAL_METHODS) {
    if (extension[method] !== undefined && typeof extension[method] !== 'function') {
      problems.push(`optional method ${method}() must be a function if present`);
    }
  }

  if (extension.name !== undefined && typeof extension.name !== 'string') {
    problems.push('extension.name must be a string if present');
  }

  if (
    extension.contractVersion !== undefined &&
    extension.contractVersion !== AWARE_EXTENSION_CONTRACT_VERSION
  ) {
    problems.push(
      `extension declares contract version ${extension.contractVersion}, ` +
      `this core implements ${AWARE_EXTENSION_CONTRACT_VERSION}`
    );
  }

  return { valid: problems.length === 0, problems };
}

module.exports = {
  AWARE_EXTENSION_CONTRACT_VERSION,
  DECISION_SHAPE,
  DECISION_EVENT_SHAPE,
  REQUIRED_METHODS,
  OPTIONAL_METHODS,
  KNOWN_METHODS,
  validateExtension,
};
