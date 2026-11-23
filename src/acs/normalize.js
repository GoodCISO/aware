// src/acs/normalize.js
// The total AWARE-decision -> ACS-verdict mapping.
//
// THIS IS THE ONLY PLACE THE MAPPING LIVES. If a second module maps an
// AWARE decision to an ACS decision, the two can disagree and the adapter
// stops being deterministic. ACS SPEC section 1.1 requires a conformant
// runtime to be stateless and deterministic.
//
// THE VERDICT SET
// --------------
// The ACS verdict enum is FIVE values: allow, deny, warn, escalate, transform.
// The task brief said three (allow, deny, transform). That is wrong, and the
// difference matters: `warn` and `escalate` are POLICY-LANGUAGE INTENTS that
// the runtime NORMALIZES. ACS SPEC section 13:
//
//   "The policy-language intents normalize natively: `warn` becomes `allow`
//   with the reason and message appended to `warnings[]`; `escalate` becomes
//   `deny` with an `approval` block."
//
// So a conformant adapter NEVER emits `warn` or `escalate` as a decision. It
// emits `allow` or `deny` with the corresponding extra members. See
// docs/acs/DESIGN.md finding F-4.

'use strict';

/**
 * The AWARE decision vocabulary (src/policies/engine.js:12-17).
 */
const AWARE_DECISIONS = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  AUDIT: 'AUDIT',
  NO_POLICY: 'NO_POLICY',
});

/**
 * The closed ACS decision set, as it appears AFTER normalisation.
 */
const ACS_DECISIONS = Object.freeze(['allow', 'deny', 'transform']);

/**
 * The reasons the adapter uses for the AWARE conditions that have no AWARE
 * reason string of their own. These are POLICY reasons, not runtime errors,
 * so they must NOT carry a `runtime_error:` or `host_error:` prefix (ACS
 * SPEC section 13).
 */
const POLICY_REASONS = Object.freeze({
  NO_POLICY_MATCHED: 'no_policy_matched',
  AUDIT_ONLY: 'audit_only',
  KILL_SWITCH_ACTIVE: 'kill_switch_active',
  APPROVAL_REQUIRED: 'approval_required',
  TOOL_BLOCKED: 'tool_blocked',
  TOOL_LIMIT_EXCEEDED: 'tool_limit_exceeded',
  TRANSFORM_APPLIED: 'transform_applied',
});

/**
 * The reserved prefixes a POLICY reason may never carry.
 *
 * ACS SPEC section 13: "MUST NOT start with `runtime_error:` or
 * `host_error:`". The runtime owns that namespace, so a policy reason that
 * uses it would be indistinguishable from a runtime failure.
 */
const RESERVED_REASON_PREFIXES = Object.freeze(['runtime_error:', 'host_error:']);

/**
 * The runtime-owned warning reason a policy may never emit.
 *
 * ACS SPEC section 13: a `warnings` entry reason "MUST NOT be the runtime
 * owned `evidence_truncated` reason".
 */
const RUNTIME_OWNED_WARNING_REASON = 'evidence_truncated';

/**
 * The members a policy-output root may carry.
 *
 * ACS SPEC section 13 lists exactly these. Anything else MUST be rejected
 * with `runtime_error:policy_output_invalid`, not discarded.
 */
const POLICY_OUTPUT_MEMBERS = Object.freeze([
  'decision',
  'reason',
  'message',
  'transform',
  'warnings',
  'approval',
  'evidence',
  'result_labels',
]);

/**
 * The AWARE-internal members an AWARE policy decision legitimately carries.
 *
 * These are NOT policy-output members. They are the adapter's own inputs
 * from the AWARE policy engine (src/policies/engine.js), and the adapter
 * strips them before the verdict is emitted. They are allowed here so the
 * "reject unknown members" rule does not fire on the adapter's own
 * plumbing.
 */
const AWARE_INTERNAL_MEMBERS = Object.freeze([
  'policyId',
  'riskLevel',
  'requiresApproval',
]);

/**
 * The members a `warnings` entry may carry.
 */
const WARNING_ENTRY_MEMBERS = Object.freeze(['reason', 'message']);

/**
 * Raised when a policy output violates the normalisation contract.
 *
 * The decision engine maps this to a fail-closed verdict.
 */
class PolicyOutputError extends Error {
  /**
   * @param {string} message - What went wrong.
   */
  constructor(message) {
    super(message);
    this.name = 'PolicyOutputError';
  }
}

/**
 * Test whether a reason carries a reserved prefix.
 *
 * @param {*} reason - The reason to test.
 * @returns {boolean} True when the reason is reserved.
 */
function hasReservedPrefix(reason) {
  if (typeof reason !== 'string') return false;
  return RESERVED_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/**
 * Validate a reason against the reserved namespace.
 *
 * @param {*} reason - The reason to validate.
 * @param {string} where - Where the reason came from, for the message.
 * @returns {void}
 * @throws {PolicyOutputError} When the reason is reserved.
 */
function assertReasonAllowed(reason, where) {
  if (hasReservedPrefix(reason)) {
    throw new PolicyOutputError(
      `The ${where} carries a reserved prefix, which the runtime owns.`,
    );
  }
}

/**
 * Reject unknown members on the policy output.
 *
 * ACS SPEC section 13: "normalization MUST reject unknown members at the
 * policy-output root, in each `warnings` entry, and in `transform`, with
 * `runtime_error:policy_output_invalid`. It MUST NOT discard these members
 * and validate only the remaining fields."
 *
 * @param {Object} object - The object to check.
 * @param {string[]} allowed - The permitted member names.
 * @param {string} where - Where the object came from, for the message.
 * @returns {void}
 * @throws {PolicyOutputError} When an unknown member is present.
 */
function assertKnownMembers(object, allowed, where) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new PolicyOutputError(
      `The ${where} carries an unknown member, which normalisation must reject.`,
    );
  }
}

/**
 * Normalise an AWARE decision into an ACS verdict.
 *
 * @param {Object} input - The normalisation input.
 * @param {string} input.decision - The AWARE decision string.
 * @param {string} [input.reason] - The AWARE reason.
 * @param {string} [input.message] - A human-readable message.
 * @param {Object} [input.approval] - The approval block, when the deny is liftable.
 * @param {Object} [input.transform] - The `{path, value}` body, for a transform.
 * @param {Array} [input.warnings] - Extra `warnings[]` entries.
 * @returns {{decision: string, reason: string, message: string, warnings?: Array, approval?: Object, transform?: Object}}
 *   The ACS verdict.
 * @throws {PolicyOutputError} When the policy output violates the
 *   normalisation contract. The decision engine maps this to a fail-closed
 *   verdict.
 * @throws {Error} When the AWARE decision is not one of the four known values.
 *   An unknown decision is a programming error, not a runtime condition.
 */
function normalizeVerdict(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('normalizeVerdict requires an input object');
  }
  const { decision, reason, message, approval, transform, warnings } = input;

  // Reject unknown members at the policy-output root BEFORE anything else.
  // The member set is the one the spec declares, plus the AWARE-internal
  // members the adapter's own plumbing carries.
  assertKnownMembers(
    { ...input, decision: undefined },
    [...POLICY_OUTPUT_MEMBERS, ...AWARE_INTERNAL_MEMBERS],
    'policy output root',
  );

  // A reason may never carry a reserved prefix.
  assertReasonAllowed(reason, 'reason');

  // Each warnings entry carries exactly {reason, message}, and its reason
  // may never carry a reserved prefix or be the runtime-owned
  // evidence_truncated reason.
  if (warnings !== undefined && warnings !== null) {
    if (!Array.isArray(warnings)) {
      throw new PolicyOutputError('The warnings member is not an array.');
    }
    for (const entry of warnings) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new PolicyOutputError('A warnings entry is not an object.');
      }
      assertKnownMembers(entry, WARNING_ENTRY_MEMBERS, 'warnings entry');
      assertReasonAllowed(entry.reason, 'warnings entry reason');
      if (entry.reason === RUNTIME_OWNED_WARNING_REASON) {
        throw new PolicyOutputError(
          'A warnings entry reason uses the runtime-owned evidence_truncated reason.',
        );
      }
    }
  }

  const verdict = {};

  switch (decision) {
    case AWARE_DECISIONS.ALLOW: {
      verdict.decision = 'allow';
      verdict.reason = reason || 'allowed_by_policy';
      break;
    }

    case AWARE_DECISIONS.AUDIT: {
      // The `warn` intent: allow, but carry a warning. ACS SPEC section 13
      // requires the warn intent to append exactly one entry to warnings[].
      verdict.decision = 'allow';
      verdict.reason = reason || POLICY_REASONS.AUDIT_ONLY;
      const entries = [{ reason: verdict.reason, message: message || 'AWARE recorded an audit-only decision.' }];
      if (Array.isArray(warnings)) {
        for (const entry of warnings) {
          if (entry && typeof entry === 'object') entries.push(entry);
        }
      }
      verdict.warnings = entries;
      break;
    }

    case AWARE_DECISIONS.NO_POLICY: {
      // No policy matched. AWARE's default decision is DENY, so a NO_POLICY
      // result reaching here means the caller explicitly asked for the
      // permissive fallback. It is still an allow with a warning: the
      // absence of policy is not a denial, but it is not a clean allow
      // either, and the receipt must say so.
      verdict.decision = 'allow';
      verdict.reason = reason || POLICY_REASONS.NO_POLICY_MATCHED;
      verdict.warnings = [
        {
          reason: verdict.reason,
          message: message || 'No AWARE policy matched this call.',
        },
      ];
      break;
    }

    case AWARE_DECISIONS.DENY: {
      verdict.decision = 'deny';
      verdict.reason = reason || 'denied_by_policy';
      // A deny carrying an approval block is a LIFTABLE deny (ACS SPEC
      // section 13.1). The approval block is only permitted on a deny.
      if (approval && typeof approval === 'object') {
        verdict.approval = approval;
      }
      break;
    }

    case 'transform': {
      verdict.decision = 'transform';
      verdict.reason = reason || POLICY_REASONS.TRANSFORM_APPLIED;
      if (!transform || typeof transform !== 'object') {
        throw new Error('a transform verdict requires a transform body');
      }
      verdict.transform = transform;
      break;
    }

    default:
      throw new Error(`Unknown AWARE decision: ${decision}`);
  }

  if (message !== undefined && message !== null) {
    verdict.message = message;
  }

  return verdict;
}

/**
 * Build the verdict for a soft alert: allow plus a warnings[] entry.
 *
 * @param {string} reason - The warning reason.
 * @param {string} [message] - The warning message.
 * @returns {Object} An ACS verdict.
 */
function warnVerdict(reason, message) {
  return {
    decision: 'allow',
    reason,
    message: message || 'AWARE raised a soft alert.',
    warnings: [{ reason, message: message || 'AWARE raised a soft alert.' }],
  };
}

/**
 * Build the verdict for a liftable deny (the ACS `escalate` intent).
 *
 * @param {Object} approval - The approval block.
 * @param {string} [reason] - The deny reason.
 * @param {string} [message] - The deny message.
 * @returns {Object} An ACS verdict.
 */
function escalationVerdict(approval, reason, message) {
  const denyReason = reason || POLICY_REASONS.APPROVAL_REQUIRED;
  return {
    decision: 'deny',
    reason: denyReason,
    message: message || 'This action requires human approval.',
    approval: approval || {},
  };
}

module.exports = {
  AWARE_DECISIONS,
  ACS_DECISIONS,
  POLICY_REASONS,
  normalizeVerdict,
  warnVerdict,
  escalationVerdict,
};
