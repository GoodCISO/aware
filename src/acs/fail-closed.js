// src/acs/fail-closed.js
// The single constructor for every fail-closed verdict.
//
// THE RULE
// -------
// ACS is fail closed by design. ACS SPEC section 21: "Any error during
// evaluation yields a `deny` verdict, so a misconfiguration or a dispatcher
// failure denies rather than permits. An implementation MUST preserve this
// property and MUST NOT add a manifest level fail open path."
//
// Every error path in the adapter builds its verdict HERE. There is no other
// place that constructs a deny for an error. A catch block that returned
// `allow` would be a defect, so the only way to build one is to write a new
// function, and the fail-closed test suite scans for that.
//
// The reason is ALWAYS one of the registered `runtime_error:*` reasons from
// the pinned reserved-reasons.json. A reason outside that set would be
// indistinguishable from a policy reason, and the spec forbids a policy
// reason from carrying a reserved prefix (SPEC section 13).

'use strict';

const { getReservedReasons } = require('./schemas');

/**
 * The reserved reason the adapter uses when the failure is not attributable
 * to a more specific registered reason. `runtime_error:policy_invocation_failed`
 * is the spec's catch-all for "the policy could not be consulted" (SPEC
 * section 12.3) and is the correct reason for an adapter-internal fault.
 */
const DEFAULT_FAILURE_REASON = 'runtime_error:policy_invocation_failed';

/**
 * Build a fail-closed verdict.
 *
 * @param {string} reason - A registered `runtime_error:*` reason.
 * @param {string} [message] - A human-readable message. Must not contain
 *   sensitive values; the spec requires telemetry and audit records to carry
 *   no sensitive value (SPEC section 19).
 * @returns {{decision: string, reason: string, message: string}} The verdict.
 * @throws {Error} When the reason is not a registered reserved reason. This
 *   is a programming error in the adapter, not a runtime condition, and it
 *   must not be swallowed into an allow.
 */
function failClosed(reason, message) {
  const reasons = getReservedReasons();
  if (!reasons.has(reason)) {
    throw new Error(
      `fail-closed reason is not a registered ACS reserved reason: ${reason}. ` +
      'The adapter may only fail closed with a reason from the pinned ' +
      'reserved-reasons.json.',
    );
  }
  return {
    decision: 'deny',
    reason,
    message: message || `ACS evaluation failed closed: ${reason}`,
  };
}

/**
 * Build a fail-closed verdict from a caught error.
 *
 * The error message is deliberately NOT copied into the verdict verbatim.
 * The spec requires that a runtime error message carries fixed text plus,
 * for an annotation failure, at most 256 bytes of dispatcher detail. The
 * safest message is a fixed one naming the reason.
 *
 * @param {string} reason - A registered `runtime_error:*` reason.
 * @param {Error} [err] - The caught error. Its message is logged, not returned.
 * @returns {{decision: string, reason: string, message: string}} The verdict.
 */
function failClosedFrom(reason, err) {
  if (err) {
    // eslint-disable-next-line no-console
    console.error(`[acs] fail-closed (${reason}): ${err.message}`);
  }
  return failClosed(reason);
}

/**
 * Test whether a verdict is a fail-closed verdict.
 *
 * @param {Object} verdict - The verdict to test.
 * @returns {boolean} True when the verdict is a deny carrying a reserved reason.
 */
function isFailClosed(verdict) {
  if (!verdict || typeof verdict !== 'object') return false;
  if (verdict.decision !== 'deny') return false;
  return typeof verdict.reason === 'string' && verdict.reason.startsWith('runtime_error:');
}

/**
 * Test whether a reason is a registered reserved reason.
 *
 * @param {string} reason - The reason to test.
 * @returns {boolean} True when the reason is registered.
 */
function isReservedReason(reason) {
  if (typeof reason !== 'string') return false;
  return getReservedReasons().has(reason);
}

module.exports = {
  DEFAULT_FAILURE_REASON,
  failClosed,
  failClosedFrom,
  isFailClosed,
  isReservedReason,
};
