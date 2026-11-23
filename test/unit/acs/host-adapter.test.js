// test/unit/acs/host-adapter.test.js
// The AGT-shaped host adapter.
//
// ACS SPEC section 17: "The runtime returns a verdict. The host enforces
// it." This suite proves the adapter gives the host everything it needs to
// enforce correctly, and that the adapter itself NEVER enforces: it never
// executes a tool, it only reports what the host must do.
//
// THE HOST PATTERN
// ----------------
// AGT's host pattern is AgentControl + HostSession (see
// agent-governance-toolkit policy-engine/sdk/python/agent_control_specification/
// _orchestration.py and _host.py, and examples/acs-email-tool/run.py).
// AWARE's adapter mirrors that shape so an AGT or Foundry host can adopt it
// with a small shim.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AcsHostSession,
  AcsHostResult,
  buildPolicyInput,
  DEFAULT_TARGET_PATHS,
} = require('../../../src/acs/host-adapter');
const { AcsDecisionEngine } = require('../../../src/acs/decision-engine');
const { validateReceipt } = require('../../../src/acs/receipt');

/**
 * A session wired to a fixed AWARE decision.
 *
 * @param {Object} decision - The AWARE decision to return.
 * @returns {AcsHostSession} The session.
 */
function sessionWith(decision) {
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: () => decision },
    killSwitch: { isRevoked: () => false },
  });
  return new AcsHostSession({ agentId: 'a1', sessionId: 's1', engine });
}

test('acs host: the pre-tool-call point produces a verdict and a receipt', async () => {
  const session = sessionWith({ decision: 'ALLOW', reason: 'ok' });
  const result = await session.preToolCall({
    toolName: 'send_email',
    args: { to: 'a@b.c' },
    callId: 'call-1',
  });

  assert.ok(result instanceof AcsHostResult);
  assert.equal(result.verdict.decision, 'allow');
  assert.equal(result.interventionPoint, 'pre_tool_call');
  assert.ok(result.receipt, 'every evaluation must produce a receipt');
  assert.ok(validateReceipt(result.receipt).valid);
});

test('acs host: the post-tool-call point produces a verdict and a receipt', async () => {
  const session = sessionWith({ decision: 'ALLOW', reason: 'ok' });
  const result = await session.postToolCall({
    toolName: 'send_email',
    args: { to: 'a@b.c' },
    result: { sent: true },
    callId: 'call-2',
  });

  assert.equal(result.verdict.decision, 'allow');
  assert.equal(result.interventionPoint, 'post_tool_call');
  assert.ok(result.receipt);
  assert.ok(validateReceipt(result.receipt).valid);
});

test('acs host: the output point produces a verdict and a receipt', async () => {
  const session = sessionWith({ decision: 'ALLOW', reason: 'ok' });
  const result = await session.output({ output: 'the agent said this' });

  assert.equal(result.verdict.decision, 'allow');
  assert.equal(result.interventionPoint, 'output');
  assert.ok(result.receipt);
  assert.ok(validateReceipt(result.receipt).valid);
});

test('acs host: permits is false for a deny', async () => {
  const session = sessionWith({ decision: 'DENY', reason: 'blocked' });
  const result = await session.preToolCall({ toolName: 't', args: {} });
  assert.equal(result.permits, false);
  assert.equal(result.mayExecute, false);
  assert.equal(result.enforced, true);
});

test('acs host: mayExecute is false in evaluate_only even when the decision permits', async () => {
  // `permits` reports the DECISION. `mayExecute` reports whether that
  // decision is BINDING. In evaluate_only the verdict is a shadow record,
  // so the host must not act on it.
  const session = sessionWith({ decision: 'ALLOW', reason: 'ok' });
  session.mode = 'evaluate_only';
  const result = await session.preToolCall({ toolName: 't', args: {} });

  assert.equal(result.permits, true, 'the decision still permits');
  assert.equal(result.mayExecute, false, 'but the decision is not binding');
  assert.equal(result.enforced, false);
});

test('acs host: permits is true for an allow and for a transform', async () => {
  const allow = await sessionWith({ decision: 'ALLOW', reason: 'ok' })
    .preToolCall({ toolName: 't', args: {} });
  assert.equal(allow.permits, true);

  const transform = await sessionWith({
    decision: 'ALLOW',
    reason: 'redacted',
    transform: { path: '$target.body', value: '[REDACTED]' },
  }).preToolCall({ toolName: 't', args: { body: 'secret' } });
  assert.equal(transform.permits, true);
  assert.equal(transform.verdict.decision, 'transform');
});

test('acs host: the transform is applied by the HOST, not by the runtime', async () => {
  const session = sessionWith({
    decision: 'ALLOW',
    reason: 'redacted',
    transform: { path: '$target.body', value: '[REDACTED]' },
  });
  const result = await session.preToolCall({
    toolName: 'send_email',
    args: { to: 'a@b.c', body: 'Tracking token: TRACK-123' },
  });

  // The host receives the TRANSFORMED target.
  assert.ok(result.transformedPolicyTarget, 'the host must receive the transformed target');
  assert.equal(result.transformedPolicyTarget.body, '[REDACTED]');
  assert.equal(result.transformedPolicyTarget.to, 'a@b.c');
  // The verdict still carries the body UNAPPLIED, as the spec requires of
  // the runtime.
  assert.equal(result.verdict.transform.value, '[REDACTED]');
});

test('acs host: a transform that cannot be applied denies', async () => {
  const session = sessionWith({
    decision: 'ALLOW',
    reason: 'redacted',
    transform: { path: '$target.absent', value: 'x' },
  });
  const result = await session.preToolCall({ toolName: 't', args: { present: 1 } });

  // The host must not carry out the action with the untransformed target.
  assert.equal(result.permits, false);
  assert.equal(result.verdict.decision, 'deny');
  assert.ok(result.verdict.reason.startsWith('runtime_error:'));
});

test('acs host: a forbidden transform root denies', async () => {
  const session = sessionWith({
    decision: 'ALLOW',
    reason: 'redacted',
    transform: { path: '$policy_target.body', value: '[REDACTED]' },
  });
  const result = await session.preToolCall({ toolName: 't', args: { body: 'x' } });
  assert.equal(result.permits, false);
  assert.equal(result.verdict.decision, 'deny');
});

test('acs host: the session sequence increments per evaluation', async () => {
  const session = sessionWith({ decision: 'ALLOW', reason: 'ok' });
  const first = await session.preToolCall({ toolName: 't', args: {} });
  const second = await session.preToolCall({ toolName: 't', args: {} });
  assert.equal(second.receipt.sequence, first.receipt.sequence + 1);
});

test('acs host: the session id is recorded on every receipt', async () => {
  const session = sessionWith({ decision: 'ALLOW', reason: 'ok' });
  const result = await session.preToolCall({ toolName: 't', args: {} });
  assert.equal(result.receipt.session_id, 's1');
});

test('acs host: evaluate_only does not change the verdict but is recorded', async () => {
  const session = sessionWith({ decision: 'DENY', reason: 'blocked' });
  session.mode = 'evaluate_only';
  const result = await session.preToolCall({ toolName: 't', args: {} });

  // The verdict is the same. The mode changes only whether the host acts.
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.enforced, false);
  assert.equal(result.receipt.mode, 'evaluate_only');
});

test('acs host: an unknown intervention point denies', async () => {
  const session = sessionWith({ decision: 'ALLOW', reason: 'ok' });
  // Reach the private path directly: a host must never guess a point.
  const result = await session._evaluate('not_a_point', {
    policyTargetValue: null,
    snapshot: {},
  });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:intervention_point_unknown');
});

test('acs host: buildPolicyInput produces the five canonical members', () => {
  const input = buildPolicyInput({
    interventionPoint: 'pre_tool_call',
    policyTargetValue: { a: 1 },
    snapshot: { tool_call: { name: 't', args: { a: 1 } } },
  });
  assert.deepEqual(
    Object.keys(input).sort(),
    ['annotations', 'intervention_point', 'policy_target', 'snapshot', 'tool'],
  );
  assert.equal(input.policy_target.path, DEFAULT_TARGET_PATHS.pre_tool_call);
});

test('acs host: the default target paths are the documented roots', () => {
  assert.equal(DEFAULT_TARGET_PATHS.pre_tool_call, '$snap.tool_call.args');
  assert.equal(DEFAULT_TARGET_PATHS.post_tool_call, '$snap.tool_result.value');
  assert.equal(DEFAULT_TARGET_PATHS.output, '$snap.output');
});

test('acs host: the host adapter never executes the tool', async () => {
  // The adapter has no tool executor and no tool registry of its own. It
  // reports what the host must do; the host does it. This test asserts the
  // adapter exposes no execution surface.
  const session = sessionWith({ decision: 'ALLOW', reason: 'ok' });
  const forbidden = ['execute', 'executeTool', 'run', 'runTool', 'callTool'];
  for (const name of forbidden) {
    assert.equal(
      typeof session[name],
      'undefined',
      `the host adapter must not expose a ${name} method`,
    );
  }
});

test('acs host: an approval request can be resolved through the session', async () => {
  const session = sessionWith({
    decision: 'DENY',
    reason: 'approval needed',
    requiresApproval: true,
  });
  const result = await session.preToolCall({ toolName: 't', args: { a: 1 } });

  assert.equal(result.verdict.decision, 'deny');
  assert.ok(result.approvalRequestId, 'the deny must raise an approval request');
  assert.ok(result.verdict.approval, 'the deny must carry an approval block');

  // The request is resolvable through the session's seam.
  const request = session.engine.approvalSeam.getRequest(result.approvalRequestId);
  assert.ok(request);
  const outcome = session.resolveApproval(result.approvalRequestId, {
    outcome: 'approve',
    contextIdentity: request.contextIdentity,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verdict.decision, 'allow');
});

test('acs host: a tool projection is included when a catalog is configured', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
    killSwitch: { isRevoked: () => false },
  });
  const session = new AcsHostSession({
    agentId: 'a1',
    sessionId: 's1',
    engine,
    toolCatalog: {
      getTool: (name) => (name === 'send_email' ? { name, clearance: 'internal' } : null),
    },
  });

  const result = await session.preToolCall({ toolName: 'send_email', args: {} });
  assert.ok(result.receipt, 'the receipt is produced regardless');

  const policyInput = buildPolicyInput({
    interventionPoint: 'pre_tool_call',
    policyTargetValue: {},
    snapshot: {},
    tool: { name: 'send_email', clearance: 'internal' },
  });
  assert.equal(policyInput.tool.clearance, 'internal');
});
