// src/acs/decision-engine.js
// AWARE as an ACS policy decision engine.
//
// ACS SEPARATES DECISION FROM ENFORCEMENT. The runtime computes a verdict;
// the host enforces it. AWARE already works this way, so this is an adapter
// over the existing engine, not a redesign.
//
// THE EVALUATION ORDER (ACS SPEC section 6)
// -----------------------------------------
//   1. Find the configuration for the named intervention point.
//   2. Resolve policy_target against the snapshot.
//   3. Resolve tool_name_from and project the tool.
//   4. Build the preliminary policy input.
//   5. Collect annotations.
//   6. Build the final policy input.
//   7. Resolve the bound policy and call the policy dispatcher.
//   8. Normalize the dispatcher output into a verdict.
//   9. Validate the transform and return the verdict.
//
// AWARE does not implement the ACS MANIFEST (that is Phase 3). AWARE
// implements the steps that matter for a decision engine: it validates the
// canonical policy input, evaluates AWARE policy against it, normalizes the
// result into an ACS verdict, and validates any transform.
//
// FAIL CLOSED
// -----------
// Every error path yields a deny through src/acs/fail-closed.js. See that
// file and ACS SPEC section 21.

'use strict';

const { getSchema } = require('./schemas');
const { validate, SchemaError } = require('./validator');
const { failClosed, failClosedFrom } = require('./fail-closed');
const { normalizeVerdict, warnVerdict, POLICY_REASONS } = require('./normalize');
const { resolveTransform } = require('./transform');
const { buildReceipt } = require('./receipt');
const { ApprovalSeam } = require('./approval');
const {
  INTERVENTION_POINTS,
  ENFORCED_INTERVENTION_POINTS,
  ENFORCEMENT_MODES,
} = require('./version');

/**
 * The policy-input member names, in the order the spec lists them.
 *
 * ACS SPEC section 7: "The policy input MUST contain exactly the members
 * `intervention_point`, `policy_target`, `snapshot`, `annotations`, and
 * `tool`."
 */
const POLICY_INPUT_MEMBERS = Object.freeze([
  'intervention_point',
  'policy_target',
  'snapshot',
  'annotations',
  'tool',
]);

/**
 * The AWARE policy engine, loaded lazily so a host that only wants the HTTP
 * transport does not pay for it, and so a test can inject a stub.
 */
function defaultPolicyEngine() {
  // eslint-disable-next-line global-require
  const { getPolicyEngine } = require('../policies/engine');
  return getPolicyEngine();
}

/**
 * The AWARE kill-switch probe, loaded lazily.
 *
 * The kill switch is NOT on the AWARE policy evaluation path today
 * (src/policies/engine.js does not consult RevocationService). The ACS
 * adapter must consult it, because ACS requires that any unresolved
 * condition produces a deny. See docs/acs/DESIGN.md gap G-3.
 */
function defaultKillSwitch() {
  // eslint-disable-next-line global-require
  const { RevocationService } = require('../kill-switch');
  try {
    const service = new RevocationService({});
    return {
      isRevoked(agentId) {
        return typeof service.isRevoked === 'function' ? service.isRevoked(agentId) : false;
      },
    };
  } catch (err) {
    // A kill switch that cannot be constructed must not silently become a
    // permissive one. The engine treats an unavailable probe as fail-closed.
    // eslint-disable-next-line no-console
    console.error(`[acs] kill switch unavailable: ${err.message}`);
    return {
      isRevoked() {
        throw new Error('kill switch probe is unavailable');
      },
    };
  }
}

/**
 * The ACS decision engine.
 */
class AcsDecisionEngine {
  /**
   * @param {Object} [config] - The engine configuration.
   * @param {Object} [config.policyEngine] - An AWARE policy engine. Defaults
   *   to the singleton from src/policies/engine.js.
   * @param {Object} [config.killSwitch] - A kill-switch probe exposing
   *   `isRevoked(agentId)`.
   * @param {Object} [config.approvalSeam] - An approval seam.
   * @param {Function} [config.onReceipt] - Called with each built receipt.
   * @param {Function} [config.onEvent] - Called with each evaluation event.
   */
  constructor(config = {}) {
    this.policyEngine = config.policyEngine || null;
    this.killSwitch = config.killSwitch || null;
    this.approvalSeam = config.approvalSeam || new ApprovalSeam();
    this.onReceipt = typeof config.onReceipt === 'function' ? config.onReceipt : null;
    this.onEvent = typeof config.onEvent === 'function' ? config.onEvent : null;
  }

  /**
   * @returns {Object} The AWARE policy engine, created on first use.
   */
  getPolicyEngine() {
    if (!this.policyEngine) {
      this.policyEngine = defaultPolicyEngine();
    }
    return this.policyEngine;
  }

  /**
   * @returns {Object} The kill-switch probe, created on first use.
   */
  getKillSwitch() {
    if (!this.killSwitch) {
      this.killSwitch = defaultKillSwitch();
    }
    return this.killSwitch;
  }

  /**
   * Validate a canonical ACS policy input.
   *
   * @param {Object} policyInput - The candidate policy input.
   * @returns {{ok: boolean, errors: Array, verdict: Object|null}}
   *   The validation result, and a fail-closed verdict when invalid.
   */
  validatePolicyInput(policyInput) {
    let schema;
    try {
      schema = getSchema('policyInput');
    } catch (err) {
      const verdict = failClosedFrom('runtime_error:policy_output_invalid', err);
      return { ok: false, errors: [{ path: '$', message: verdict.message }], verdict };
    }

    let result;
    try {
      result = validate(policyInput, schema);
    } catch (err) {
      // A schema we cannot evaluate is a fail-closed condition, not a pass.
      const verdict = failClosedFrom(
        err instanceof SchemaError ? 'runtime_error:policy_output_invalid' : 'runtime_error:policy_invocation_failed',
        err,
      );
      return { ok: false, errors: [{ path: '$', message: verdict.message }], verdict };
    }

    if (!result.valid) {
      return {
        ok: false,
        errors: result.errors,
        verdict: failClosed(
          'runtime_error:policy_output_invalid',
          `The policy input does not satisfy the pinned ACS schema: ${result.errors
            .slice(0, 4).map((e) => `${e.path} ${e.message}`).join('; ')}`,
        ),
      };
    }

    // Belt and braces: the schema pins the member set, but the spec states
    // the requirement in prose too. Assert it directly so a future schema
    // loosening cannot silently widen the contract.
    const actual = Object.keys(policyInput).sort();
    const expected = [...POLICY_INPUT_MEMBERS].sort();
    if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
      return {
        ok: false,
        errors: [{ path: '$', message: 'the policy input must have exactly the five canonical members' }],
        verdict: failClosed(
          'runtime_error:policy_output_invalid',
          'The policy input does not have exactly the five canonical members.',
        ),
      };
    }

    return { ok: true, errors: [], verdict: null };
  }

  /**
   * Evaluate one ACS intervention point.
   *
   * @param {Object} input - The evaluation input.
   * @param {Object} input.policyInput - The canonical ACS policy input.
   * @param {string} [input.mode] - 'enforce' or 'evaluate_only'. Defaults to
   *   'enforce'.
   * @param {string} [input.agentId] - The AWARE agent id, for policy lookup.
   * @param {string} [input.sessionId] - The host session id.
   * @param {number} [input.sequence] - The host sequence number.
   * @param {string} [input.agentId] - The AWARE agent id.
   * @returns {Promise<Object>} The evaluation result, carrying the verdict,
   *   the receipt, and the effective mode.
   */
  async evaluate(input) {
    const mode = input.mode === undefined ? 'enforce' : input.mode;
    const policyInput = input.policyInput;

    // --- Step 0: the mode and the intervention point must be well formed.
    if (!ENFORCEMENT_MODES.includes(mode)) {
      return this._failResult(
        'runtime_error:request_invalid',
        `Unknown enforcement mode: ${mode}`,
        input,
        mode,
      );
    }
    if (!policyInput || typeof policyInput !== 'object') {
      return this._failResult(
        'runtime_error:request_invalid',
        'The policy input is missing or is not an object.',
        input,
        mode,
      );
    }
    if (!INTERVENTION_POINTS.includes(policyInput.intervention_point)) {
      return this._failResult(
        'runtime_error:intervention_point_unknown',
        `Unknown intervention point: ${policyInput.intervention_point}`,
        input,
        mode,
      );
    }

    // --- Step 1: validate the canonical policy input.
    const validation = this.validatePolicyInput(policyInput);
    if (!validation.ok) {
      return this._failResult(
        'runtime_error:policy_output_invalid',
        validation.verdict.message,
        input,
        mode,
        validation.verdict,
      );
    }

    // --- Step 2: evaluate AWARE policy.
    //
    // AWARE enforces policy for three intervention points in Phase 1. The
    // other five are accepted and answered with a well-formed verdict, but
    // AWARE holds no policy for them yet. They are NOT a failure: the spec
    // requires a well-formed verdict for every intervention point.
    if (!ENFORCED_INTERVENTION_POINTS.includes(policyInput.intervention_point)) {
      const verdict = {
        decision: 'allow',
        reason: 'no_policy_for_intervention_point',
        message: `AWARE holds no policy for the ${policyInput.intervention_point} intervention point yet.`,
        warnings: [
          {
            reason: 'no_policy_for_intervention_point',
            message: `AWARE holds no policy for the ${policyInput.intervention_point} intervention point yet.`,
          },
        ],
      };
      return this._successResult(verdict, input, mode, null);
    }

    // --- Step 2a: the kill switch.
    //
    // The kill switch short-circuits BEFORE policy evaluation. A revoked
    // agent is denied regardless of what any policy says.
    if (input.agentId) {
      try {
        if (this.getKillSwitch().isRevoked(input.agentId)) {
          const verdict = {
            decision: 'deny',
            reason: POLICY_REASONS.KILL_SWITCH_ACTIVE,
            message: 'The agent is under an active kill signal.',
          };
          return this._successResult(verdict, input, mode, null);
        }
      } catch (err) {
        // A kill-switch probe that cannot answer must not become a
        // permissive one. This is the issue-#83 class: a gate that silently
        // stops firing. Fail closed.
        return this._failResult(
          'runtime_error:policy_invocation_failed',
          'The kill-switch probe could not be consulted.',
          input,
          mode,
        );
      }
    }

    // --- Step 2b: AWARE policy evaluation.
    let awareDecision;
    try {
      awareDecision = this.getPolicyEngine().evaluate({
        agentId: input.agentId || 'anonymous',
        tool: this._toolName(policyInput),
        context: this._awareContext(policyInput),
      });
    } catch (err) {
      return this._failResult(
        'runtime_error:policy_invocation_failed',
        'The AWARE policy engine could not be consulted.',
        input,
        mode,
      );
    }

    if (!awareDecision || typeof awareDecision !== 'object') {
      return this._failResult(
        'runtime_error:policy_invocation_failed',
        'The AWARE policy engine returned no decision.',
        input,
        mode,
      );
    }

    // --- Step 2c: an approval requirement becomes a LIFTABLE deny.
    //
    // AWARE represents approval as a boolean flag. ACS needs a liftable
    // deny carrying an approval block. The adapter creates the approval
    // request here.
    let approvalBlock = null;
    let approvalRequest = null;
    if (awareDecision.decision === 'DENY' && awareDecision.requiresApproval) {
      // The approval seam is part of the decision path. If it cannot create
      // the request, the deny must still stand: the action is not approved,
      // so it must not proceed. This is the issue-#83 class -- a gate that
      // stops firing must fail closed, never open.
      try {
        approvalRequest = this.approvalSeam.createRequest({
          verdict: { decision: 'deny', reason: awareDecision.reason },
          interventionPoint: policyInput.intervention_point,
          context: this._approvalContext(policyInput, input),
          sessionId: input.sessionId,
        });
      } catch (err) {
        return this._failResult(
          'runtime_error:approval_resolver_failed',
          'The approval request could not be created; the deny stands.',
          input,
          mode,
        );
      }
      approvalBlock = {
        context_identity: approvalRequest.contextIdentity,
        request_id: approvalRequest.requestId,
        intervention_point: policyInput.intervention_point,
      };
    }

    // --- Step 3: normalise into an ACS verdict.
    //
    // A transform is a separate verdict, not a modifier of an allow. ACS
    // SPEC section 14: "`transform` is the only form of value rewriting a
    // verdict can request." So when the AWARE decision carries a
    // transform body, the verdict IS a transform verdict.
    let verdict;
    try {
      const isTransform = awareDecision.transform
        && typeof awareDecision.transform === 'object';
      verdict = normalizeVerdict({
        decision: isTransform ? 'transform' : awareDecision.decision,
        reason: awareDecision.reason,
        message: this._verdictMessage(awareDecision),
        approval: approvalBlock,
        transform: isTransform ? awareDecision.transform : undefined,
      });
    } catch (err) {
      return this._failResult(
        'runtime_error:policy_invocation_failed',
        'The AWARE decision could not be normalised into an ACS verdict.',
        input,
        mode,
      );
    }

    // --- Step 4: validate any transform.
    //
    // A transform is validated in BOTH modes. In evaluate_only the host
    // validates it but applies none (ACS SPEC section 14). The adapter
    // returns the verdict with the body unapplied; the host applies it.
    if (verdict.decision === 'transform' && verdict.transform) {
      const target = policyInput.policy_target
        && policyInput.policy_target.value;
      const resolved = resolveTransform(verdict.transform, target);
      if (!resolved.ok) {
        return this._failResult(
          resolved.reason,
          resolved.message,
          input,
          mode,
          resolved.verdict,
        );
      }
    }

    return this._successResult(verdict, input, mode, approvalRequest);
  }

  /**
   * The tool name the AWARE policy engine should evaluate against.
   *
   * @param {Object} policyInput - The ACS policy input.
   * @returns {string} The tool name, or a placeholder when there is none.
   */
  _toolName(policyInput) {
    const fromTool = policyInput.tool && policyInput.tool.name;
    if (typeof fromTool === 'string' && fromTool.length > 0) return fromTool;
    const snapshot = policyInput.snapshot || {};
    if (snapshot.tool_call && typeof snapshot.tool_call.name === 'string') {
      return snapshot.tool_call.name;
    }
    return 'unknown';
  }

  /**
   * The AWARE policy-engine context, built from the ACS snapshot.
   *
   * @param {Object} policyInput - The ACS policy input.
   * @returns {Object} The AWARE request context.
   */
  _awareContext(policyInput) {
    const snapshot = policyInput.snapshot || {};
    const toolCall = snapshot.tool_call || {};
    const args = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {};
    return {
      targets: args,
      dataTier: (policyInput.tool && policyInput.tool.clearance) || null,
      interventionPoint: policyInput.intervention_point,
      annotations: policyInput.annotations || {},
    };
  }

  /**
   * The context an approver is shown.
   *
   * @param {Object} policyInput - The ACS policy input.
   * @param {Object} input - The evaluation input.
   * @returns {Object} The approver context.
   */
  _approvalContext(policyInput, input) {
    return {
      agentId: input.agentId || null,
      sessionId: input.sessionId || null,
      interventionPoint: policyInput.intervention_point,
      tool: this._toolName(policyInput),
      policyTarget: policyInput.policy_target ? policyInput.policy_target.value : null,
    };
  }

  /**
   * The message on a verdict, derived from the AWARE decision.
   *
   * @param {Object} awareDecision - The AWARE decision.
   * @returns {string} A message.
   */
  _verdictMessage(awareDecision) {
    if (typeof awareDecision.reason === 'string' && awareDecision.reason.length > 0) {
      return awareDecision.reason;
    }
    return `AWARE decision: ${awareDecision.decision}`;
  }

  /**
   * Build the successful result, including the receipt.
   *
   * @param {Object} verdict - The ACS verdict.
   * @param {Object} input - The evaluation input.
   * @param {string} mode - The enforcement mode.
   * @param {Object|null} approvalRequest - The approval request, when one was made.
   * @returns {Promise<Object>} The result.
   */
  async _successResult(verdict, input, mode, approvalRequest) {
    const receipt = this._buildReceipt(verdict, input, mode, approvalRequest);
    if (this.onReceipt) {
      try {
        await this.onReceipt(receipt);
      } catch (err) {
        // A receipt-write failure must NOT turn a deny into an allow, and it
        // must not turn an allow into a deny either: the verdict is already
        // decided. The failure is reported so the operator can see the
        // evidence trail has a gap.
        // eslint-disable-next-line no-console
        console.error(`[acs] receipt write failed: ${err.message}`);
      }
    }
    this._emit({ type: 'evaluated', verdict, mode, interventionPoint: input.policyInput && input.policyInput.intervention_point });
    return {
      verdict,
      mode,
      receipt,
      approvalRequestId: approvalRequest ? approvalRequest.requestId : null,
      enforced: mode === 'enforce',
    };
  }

  /**
   * Build the failed result. The verdict is always a deny.
   *
   * @param {string} reason - The registered reserved reason.
   * @param {string} message - The message.
   * @param {Object} input - The evaluation input.
   * @param {string} mode - The enforcement mode.
   * @param {Object} [verdict] - A pre-built fail-closed verdict.
   * @returns {Promise<Object>} The result.
   */
  async _failResult(reason, message, input, mode, verdict) {
    const failVerdict = verdict || failClosed(reason, message);
    const receipt = this._buildReceipt(failVerdict, input, mode, null);
    if (this.onReceipt) {
      try {
        await this.onReceipt(receipt);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[acs] receipt write failed: ${err.message}`);
      }
    }
    this._emit({ type: 'failed_closed', verdict: failVerdict, mode, reason });
    return {
      verdict: failVerdict,
      mode,
      receipt,
      approvalRequestId: null,
      enforced: mode === 'enforce',
    };
  }

  /**
   * Build the ACS receipt for one evaluation.
   *
   * The receipt schema is the Agent Hooks interception-record schema
   * (docs/acs/schemas/interception-record.schema.json).
   *
   * @param {Object} verdict - The ACS verdict.
   * @param {Object} input - The evaluation input.
   * @param {string} mode - The enforcement mode.
   * @param {Object|null} approvalRequest - The approval request.
   * @returns {Object} The receipt.
   */
  _buildReceipt(verdict, input, mode, approvalRequest) {
    const policyInput = input.policyInput || {};
    const sessionId = input.sessionId || 'acs-session';
    const sequence = typeof input.sequence === 'number' ? input.sequence : 0;
    return buildReceipt({
      verdict,
      interventionPoint: policyInput.intervention_point || 'agent_startup',
      mode,
      sessionId,
      sequence,
      timestamp: input.timestamp,
      decidedBy: 0,
    });
  }

  /**
   * Emit an event to the configured listener.
   *
   * @param {Object} event - The event.
   * @returns {void}
   */
  _emit(event) {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[acs] event write failed: ${err.message}`);
    }
  }
}

module.exports = {
  AcsDecisionEngine,
  POLICY_INPUT_MEMBERS,
  warnVerdict,
};
