// src/api/routes/acs.js
// The HTTP transport for the ACS adapter.
//
// This mirrors the existing precedent at src/api/routes/tools.js:132, which
// exposes POST /api/tools/evaluate. The router is mounted behind the
// existing `authenticateToken` middleware in src/api/index.js, so it needs
// no authentication of its own.
//
// THE ROUTES
// ----------
//   POST /api/acs/evaluate           evaluate one ACS intervention point
//   POST /api/acs/approvals           create an approval request
//   POST /api/acs/approvals/:id/resolve  resolve an approval request
//   GET  /api/acs/spec                the pinned upstream versions
//
// FAIL CLOSED
// ----------
// A malformed request body, an unknown intervention point and any internal
// fault all return a DENY verdict with a registered reserved reason. The
// route never returns a 2xx with an allow verdict it could not justify.

'use strict';

const express = require('express');

const {
  AcsDecisionEngine,
  AcsHostSession,
  ApprovalSeam,
  buildPolicyInput,
  getReservedReasons,
  ACS_SPEC_VERSION,
  ACS_RELEASE_TAG,
  ACS_COMMIT,
  INTERVENTION_POINTS,
  ENFORCED_INTERVENTION_POINTS,
  ENFORCEMENT_MODES,
} = require('../../acs');

const router = express.Router();

/**
 * The engine and approval seam this router uses.
 *
 * They are created once and reused, so the approval requests raised through
 * the HTTP transport are resolvable through it.
 */
const approvalSeam = new ApprovalSeam();
const engine = new AcsDecisionEngine({ approvalSeam });

/**
 * Build the canonical ACS policy input from a request body.
 *
 * The body may supply the five canonical members directly, or the
 * intervention point plus the pieces a host naturally has. Both shapes are
 * accepted; the result is always the canonical five-member input.
 *
 * @param {Object} body - The request body.
 * @returns {Object} The policy input.
 */
function policyInputFromBody(body) {
  if (
    body
    && typeof body === 'object'
    && 'intervention_point' in body
    && 'policy_target' in body
    && 'snapshot' in body
    && 'annotations' in body
    && 'tool' in body
  ) {
    return {
      intervention_point: body.intervention_point,
      policy_target: body.policy_target,
      snapshot: body.snapshot,
      annotations: body.annotations,
      tool: body.tool,
    };
  }

  const interventionPoint = body && body.intervention_point;
  const snapshot = (body && body.snapshot) || {};
  const toolName = body && body.tool_name;

  const targetValue = body && Object.prototype.hasOwnProperty.call(body, 'policy_target_value')
    ? body.policy_target_value
    : (snapshot.tool_call && snapshot.tool_call.args) || null;

  return buildPolicyInput({
    interventionPoint,
    policyTargetValue: targetValue,
    snapshot,
    annotations: (body && body.annotations) || {},
    tool: toolName ? { name: toolName } : null,
  });
}

/**
 * POST /api/acs/evaluate
 * Evaluate one ACS intervention point.
 */
router.post('/evaluate', async (req, res) => {
  try {
    const body = req.body || {};
    const mode = body.mode === undefined ? 'enforce' : body.mode;

    if (!ENFORCEMENT_MODES.includes(mode)) {
      return res.status(400).json({
        error: 'INVALID_MODE',
        message: `mode must be one of ${ENFORCEMENT_MODES.join(', ')}`,
        verdict: {
          decision: 'deny',
          reason: 'runtime_error:request_invalid',
          message: 'Unknown enforcement mode.',
        },
      });
    }

    const policyInput = policyInputFromBody(body);

    const result = await engine.evaluate({
      policyInput,
      mode,
      agentId: body.agent_id || body.agentId || null,
      sessionId: body.session_id || body.sessionId || null,
      sequence: typeof body.sequence === 'number' ? body.sequence : 0,
    });

    return res.json({
      verdict: result.verdict,
      mode: result.mode,
      enforced: result.enforced,
      receipt: result.receipt,
      approval_request_id: result.approvalRequestId,
      spec_version: ACS_SPEC_VERSION,
    });
  } catch (err) {
    // An unexpected internal fault fails closed.
    // eslint-disable-next-line no-console
    console.error(`[acs] evaluate route fault: ${err.message}`);
    return res.status(500).json({
      error: 'ACS_EVALUATION_FAILED',
      verdict: {
        decision: 'deny',
        reason: 'runtime_error:policy_invocation_failed',
        message: 'The ACS evaluation failed closed.',
      },
    });
  }
});

/**
 * POST /api/acs/approvals
 * Create an approval request for a liftable deny.
 */
router.post('/approvals', (req, res) => {
  try {
    const body = req.body || {};
    const request = approvalSeam.createRequest({
      verdict: body.verdict || { decision: 'deny' },
      interventionPoint: body.intervention_point || 'pre_tool_call',
      context: body.context,
      contextIdentity: body.context_identity,
      sessionId: body.session_id,
    });
    return res.status(201).json({
      request_id: request.requestId,
      context_identity: request.contextIdentity,
      intervention_point: request.interventionPoint,
      status: request.status,
      expires_at: new Date(request.expiresAt).toISOString(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[acs] approval request fault: ${err.message}`);
    return res.status(500).json({
      error: 'ACS_APPROVAL_REQUEST_FAILED',
      verdict: {
        decision: 'deny',
        reason: 'runtime_error:approval_resolver_failed',
        message: 'The approval request could not be created.',
      },
    });
  }
});

/**
 * POST /api/acs/approvals/:id/resolve
 * Resolve an approval request.
 */
router.post('/approvals/:id/resolve', (req, res) => {
  try {
    const body = req.body || {};
    const outcome = approvalSeam.resolve(req.params.id, {
      outcome: body.outcome,
      resolvedBy: body.resolved_by,
      contextIdentity: body.context_identity,
    });
    return res.status(outcome.ok ? 200 : 409).json({
      ok: outcome.ok,
      verdict: outcome.verdict,
      reason: outcome.reason,
      request_id: req.params.id,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[acs] approval resolve fault: ${err.message}`);
    return res.status(500).json({
      error: 'ACS_APPROVAL_RESOLVE_FAILED',
      verdict: {
        decision: 'deny',
        reason: 'runtime_error:approval_resolver_failed',
        message: 'The approval could not be resolved.',
      },
    });
  }
});

/**
 * GET /api/acs/spec
 * The pinned upstream versions and the vocabulary this adapter accepts.
 */
router.get('/spec', (req, res) => {
  res.json({
    spec_version: ACS_SPEC_VERSION,
    release_tag: ACS_RELEASE_TAG,
    commit: ACS_COMMIT,
    intervention_points: INTERVENTION_POINTS,
    enforced_intervention_points: ENFORCED_INTERVENTION_POINTS,
    enforcement_modes: ENFORCEMENT_MODES,
    reserved_reasons: Array.from(getReservedReasons()),
  });
});

module.exports = router;
module.exports.engine = engine;
module.exports.approvalSeam = approvalSeam;
module.exports.policyInputFromBody = policyInputFromBody;
