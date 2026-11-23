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
 * @throws {Error} When the AWARE decision is not one of the four known values.
 *   An unknown decision is a programming error, not a runtime condition.
 */
function normalizeVerdict(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('normalizeVerdict requires an input object');
  }
  const { decision, reason, message, approval, transform, warnings } = input;

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
