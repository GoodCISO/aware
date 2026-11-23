// src/acs/host-adapter.js
// The AWARE host adapter for ACS.
//
// ACS SEPARATES DECISION FROM ENFORCEMENT. "The runtime returns a verdict.
// The host enforces it." (ACS SPEC section 17.) This module is the host.
//
// The AGT-SHAPED SURFACE
// ----------------------
// AGT's host pattern is AgentControl + HostSession (see
// agent-governance-toolkit policy-engine/sdk/python/agent_control_specification/
// _orchestration.py and _host.py, and examples/acs-email-tool/run.py).
// AWARE's adapter mirrors that shape so an AGT or Foundry host can adopt it
// with a small shim:
//
//   const session = new AcsHostSession({ agentId, sessionId });
//   const result = await session.preToolCall({ toolName, args, callId });
//   if (!result.permits) return;        // the host does not carry out the action
//   const enforcedArgs = result.transformedPolicyTarget ?? args;
//   await executeTool(enforcedArgs);
//
// THE HOST OWNS ENFORCEMENT
// -------------------------
// This module never executes a tool. It returns what the host must do. The
// transform is returned UNAPPLIED by the runtime (ACS SPEC section 14) and
// applied HERE, so a caller cannot accidentally execute the untransformed
// target.
//
// EVALUATE_ONLY
// -------------
// In evaluate_only mode the host MAY carry out the original action and
// SHOULD record the verdict. The result says which mode applied, so the
// caller can honour it. See docs/acs/DESIGN.md.

'use strict';

const { AcsDecisionEngine } = require('./decision-engine');
const { resolveTransform } = require('./transform');
const { INTERVENTION_POINTS } = require('./version');

/**
 * The default policy target path for each intervention point.
 *
 * ACS SPEC section 3.1: `$snap` resolves to the raw host snapshot.
 */
const DEFAULT_TARGET_PATHS = Object.freeze({
  pre_tool_call: '$snap.tool_call.args',
  post_tool_call: '$snap.tool_result.value',
  output: '$snap.output',
});

/**
 * Build a policy input for an intervention point.
 *
 * @param {Object} input - The build input.
 * @param {string} input.interventionPoint - The intervention point.
 * @param {*} input.policyTargetValue - The value under evaluation.
 * @param {Object} [input.snapshot] - The raw host snapshot.
 * @param {Object} [input.annotations] - The annotator outputs.
 * @param {Object} [input.tool] - The projected tool.
 * @param {string} [input.policyTargetKind] - The configured kind.
 * @param {string} [input.policyTargetPath] - The configured path.
 * @returns {Object} The canonical five-member ACS policy input.
 */
function buildPolicyInput(input) {
  const point = input.interventionPoint;
  return {
    intervention_point: point,
    policy_target: {
      kind: input.policyTargetKind === undefined ? null : input.policyTargetKind,
      path: input.policyTargetPath || DEFAULT_TARGET_PATHS[point] || '$snap',
      value: input.policyTargetValue === undefined ? null : input.policyTargetValue,
    },
    snapshot: input.snapshot || {},
    annotations: input.annotations || {},
    tool: input.tool === undefined ? null : input.tool,
  };
}

/**
 * The result of one host intervention point call.
 */
class AcsHostResult {
  /**
   * @param {Object} input - The result input.
   * @param {Object} input.verdict - The ACS verdict.
   * @param {string} input.mode - The enforcement mode.
   * @param {Object} input.receipt - The ACS receipt.
   * @param {*} [input.transformedPolicyTarget] - The transformed target, when
   *   a transform verdict was applied.
   * @param {string|null} [input.approvalRequestId] - The approval request id.
   * @param {string} input.interventionPoint - The intervention point.
   */
  constructor(input) {
    this.verdict = input.verdict;
    this.mode = input.mode;
    this.receipt = input.receipt;
    this.interventionPoint = input.interventionPoint;
    this.approvalRequestId = input.approvalRequestId || null;
    this.transformedPolicyTarget = input.transformedPolicyTarget === undefined
      ? null
      : input.transformedPolicyTarget;

    /** Whether the host may carry out the action. */
    this.permits = input.verdict.decision === 'allow' || input.verdict.decision === 'transform';
    /** Whether the verdict is binding. False in evaluate_only. */
    this.enforced = input.mode === 'enforce';
  }
}

/**
 * The ACS host session.
 */
class AcsHostSession {
  /**
   * @param {Object} config - The session configuration.
   * @param {string} config.agentId - The AWARE agent id.
   * @param {string} [config.sessionId] - The host session id.
   * @param {AcsDecisionEngine} [config.engine] - An engine to use.
   * @param {Object} [config.toolCatalog] - A projected tool catalog, so the
   *   policy input can carry a `tool` member.
   * @param {string} [config.mode] - The default enforcement mode.
   */
  constructor(config = {}) {
    this.agentId = config.agentId || 'anonymous';
    this.sessionId = config.sessionId || `acs-${this.agentId}`;
    this.engine = config.engine || new AcsDecisionEngine(config.engineConfig || {});
    this.toolCatalog = config.toolCatalog || null;
    this.mode = config.mode || 'enforce';
    this.sequence = 0;
  }

  /**
   * Evaluate the pre-tool-call intervention point.
   *
   * @param {Object} call - The tool call.
   * @param {string} call.toolName - The tool name.
   * @param {Object} call.args - The tool arguments.
   * @param {string} [call.callId] - The host's call id.
   * @param {Object} [call.context] - Extra host context, added to the snapshot.
   * @returns {Promise<AcsHostResult>} The result.
   */
  async preToolCall(call) {
    const snapshot = {
      tool_call: {
        id: call.callId || null,
        name: call.toolName,
        args: call.args || {},
      },
      ...(call.context || {}),
    };
    return this._evaluate('pre_tool_call', {
      policyTargetValue: call.args || {},
      policyTargetKind: 'tool_args',
      snapshot,
      tool: this._projectTool(call.toolName),
    });
  }

  /**
   * Evaluate the post-tool-call intervention point.
   *
   * @param {Object} call - The completed tool call.
   * @param {string} call.toolName - The tool name.
   * @param {Object} call.args - The tool arguments that were used.
   * @param {*} call.result - The tool result.
   * @param {string} [call.callId] - The host's call id.
   * @param {Object} [call.context] - Extra host context.
   * @returns {Promise<AcsHostResult>} The result.
   */
  async postToolCall(call) {
    const snapshot = {
      tool_call: {
        id: call.callId || null,
        name: call.toolName,
        args: call.args || {},
      },
      tool_result: {
        id: call.callId || null,
        name: call.toolName,
        value: call.result === undefined ? null : call.result,
      },
      ...(call.context || {}),
    };
    return this._evaluate('post_tool_call', {
      policyTargetValue: call.result === undefined ? null : call.result,
      policyTargetKind: 'tool_result',
      snapshot,
      tool: this._projectTool(call.toolName),
    });
  }

  /**
   * Evaluate the output intervention point.
   *
   * @param {Object} call - The produced output.
   * @param {*} call.output - The output value.
   * @param {Object} [call.context] - Extra host context.
   * @returns {Promise<AcsHostResult>} The result.
   */
  async output(call) {
    const snapshot = {
      output: call.output === undefined ? null : call.output,
      ...(call.context || {}),
    };
    return this._evaluate('output', {
      policyTargetValue: call.output === undefined ? null : call.output,
      policyTargetKind: 'output',
      snapshot,
      tool: null,
    });
  }

  /**
   * Resolve an approval request through the engine's approval seam.
   *
   * @param {string} requestId - The approval request id.
   * @param {Object} resolution - The resolution.
   * @returns {Object} The resolution result.
   */
  resolveApproval(requestId, resolution) {
    return this.engine.approvalSeam.resolve(requestId, resolution);
  }

  /**
   * Project a tool from the catalog, if one is configured.
   *
   * @param {string} toolName - The tool name.
   * @returns {Object|null} The projected tool, or null.
   */
  _projectTool(toolName) {
    if (!this.toolCatalog || typeof this.toolCatalog.getTool !== 'function') return null;
    const tool = this.toolCatalog.getTool(toolName);
    if (!tool) return null;
    return {
      name: toolName,
      ...tool,
    };
  }

  /**
   * Run one evaluation and build the host result.
   *
   * @param {string} interventionPoint - The intervention point.
   * @param {Object} target - The policy target input.
   * @returns {Promise<AcsHostResult>} The result.
   */
  async _evaluate(interventionPoint, target) {
    if (!INTERVENTION_POINTS.includes(interventionPoint)) {
      // A host that asks for an unknown point is a host defect. Fail closed
      // rather than guessing.
      // eslint-disable-next-line global-require
      const { failClosed } = require('./fail-closed');
      // eslint-disable-next-line global-require
      const { buildReceipt } = require('./receipt');
      const verdict = failClosed(
        'runtime_error:intervention_point_unknown',
        `Unknown intervention point: ${interventionPoint}`,
      );
      const receipt = buildReceipt({
        verdict,
        interventionPoint,
        mode: this.mode,
        sessionId: this.sessionId,
        sequence: this.sequence,
      });
      this.sequence += 1;
      return new AcsHostResult({
        verdict,
        mode: this.mode,
        receipt,
        interventionPoint,
      });
    }

    const policyInput = buildPolicyInput({
      interventionPoint,
      ...target,
    });

    this.sequence += 1;
    const evaluation = await this.engine.evaluate({
      policyInput,
      mode: this.mode,
      agentId: this.agentId,
      sessionId: this.sessionId,
      sequence: this.sequence,
    });

    // The runtime returns the transform UNAPPLIED. The HOST applies it.
    let transformedPolicyTarget = null;
    if (evaluation.verdict.decision === 'transform' && evaluation.verdict.transform) {
      const resolved = resolveTransform(
        evaluation.verdict.transform,
        policyInput.policy_target.value,
      );
      if (resolved.ok) {
        transformedPolicyTarget = resolved.value;
      } else {
        // The transform could not be applied. That is a HOST-side failure
        // (host_error:transform_invalid). The host must not carry out the
        // action with the untransformed target, so the result denies.
        // eslint-disable-next-line global-require
        const { failClosed } = require('./fail-closed');
        const verdict = failClosed(resolved.reason, resolved.message);
        return new AcsHostResult({
          verdict,
          mode: evaluation.mode,
          receipt: evaluation.receipt,
          interventionPoint,
          approvalRequestId: evaluation.approvalRequestId,
        });
      }
    }

    return new AcsHostResult({
      verdict: evaluation.verdict,
      mode: evaluation.mode,
      receipt: evaluation.receipt,
      interventionPoint,
      approvalRequestId: evaluation.approvalRequestId,
      transformedPolicyTarget,
    });
  }
}

module.exports = {
  AcsHostSession,
  AcsHostResult,
  buildPolicyInput,
  DEFAULT_TARGET_PATHS,
};
