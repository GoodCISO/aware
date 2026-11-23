// test/unit/acs/adversarial-review.test.js
// Regression tests for the defects an adversarial review found.
//
// EVERY TEST HERE IS A REGRESSION TEST. Each one was a live defect on this
// branch at the time of the review, and each one is a FAIL-OPEN defect:
// the adapter allowed something it should have denied. The names are the
// finding identifiers from that review, so a future reader can trace each
// test back to the defect it guards.
//
// These are the tests that make the branch's central claim -- "every error
// path denies" -- true rather than aspirational.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AcsDecisionEngine, AcsHostSession } = require('../../../src/acs');
const { ApprovalSeam } = require('../../../src/acs/approval');
const { validate, deepEqual } = require('../../../src/acs/validator');

/**
 * A valid pre_tool_call policy input.
 *
 * @returns {Object} The policy input.
 */
function policyInput() {
  return {
    intervention_point: 'pre_tool_call',
    policy_target: { kind: 'tool_args', path: '$snap.tool_call.args', value: { body: 'b' } },
    snapshot: { tool_call: { name: 't', args: { body: 'b' } } },
    annotations: {},
    tool: { name: 't' },
  };
}

/**
 * An engine whose policy engine returns a fixed decision.
 *
 * @param {Object} decision - The AWARE decision.
 * @param {Object} [config] - Extra engine config.
 * @returns {AcsDecisionEngine} The engine.
 */
function engineReturning(decision, config = {}) {
  return new AcsDecisionEngine({
    policyEngine: { evaluate: () => decision },
    killSwitch: { isRevoked: () => false },
    ...config,
  });
}

test('regression CRITICAL-1: a DENY carrying a transform must NOT become a permitting transform', async () => {
  // The defect: the transform body took precedence over the policy
  // decision, so a DENY was emitted as `transform`. The host computes
  // `permits` from the decision, and `transform` permits, so a DENY
  // became an ALLOW.
  const engine = engineReturning({
    decision: 'DENY',
    reason: 'data_exfiltration_blocked',
    requiresApproval: false,
    transform: { path: '$target.body', value: '[REDACTED]' },
  });

  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });

  assert.equal(
    result.verdict.decision,
    'deny',
    'a deny must stay a deny even when a transform body is present',
  );
  const permits = result.verdict.decision === 'allow' || result.verdict.decision === 'transform';
  assert.equal(permits, false, 'the verdict must not permit the action');
  assert.ok(result.verdict.reason.startsWith('runtime_error:'), 'the failure must be a reserved reason');
});

test('regression CRITICAL-1: the host adapter must not permit a deny-with-transform', async () => {
  const engine = engineReturning({
    decision: 'DENY',
    reason: 'blocked',
    transform: { path: '$target.body', value: 'X' },
  });
  const session = new AcsHostSession({ agentId: 'a1', sessionId: 's1', engine });

  const result = await session.preToolCall({ toolName: 't', args: { body: 'b' } });
  assert.equal(result.permits, false);
  assert.equal(result.mayExecute, false);
});

test('regression CRITICAL-2: the kill switch must be consulted when no agent id is supplied', async () => {
  // The defect: the kill-switch check was gated on the truthiness of
  // agentId, so a caller that omitted the id skipped the gate entirely.
  // The HTTP transport is a separate entry point where the id can be
  // omitted, so this was a real path.
  //
  // The fix: with no agent identity the gate CANNOT be evaluated, and a
  // gate that cannot be evaluated must not be treated as a gate that
  // passed. So the evaluation fails closed rather than allowing.
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
    killSwitch: { isRevoked: () => true },
  });

  const result = await engine.evaluate({ policyInput: policyInput() });

  assert.equal(result.verdict.decision, 'deny', 'no agent id must not skip the gate');
  assert.ok(
    result.verdict.reason.startsWith('runtime_error:'),
    'the failure must be a reserved reason',
  );
});

test('regression CRITICAL-2: a revoked agent is denied even when the id IS supplied', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
    killSwitch: { isRevoked: () => true },
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'kill_switch_active');
});

test('regression HIGH-2: a revoked agent is denied at an UNENFORCED intervention point', async () => {
  // The defect: the unenforced-point branch returned an unconditional
  // allow BEFORE the kill-switch check, so five of the eight
  // intervention points allowed a revoked agent.
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
    killSwitch: { isRevoked: () => true },
  });

  for (const point of ['agent_startup', 'input', 'pre_model_call', 'post_model_call', 'agent_shutdown']) {
    const result = await engine.evaluate({
      policyInput: { ...policyInput(), intervention_point: point },
      agentId: 'a1',
    });
    assert.equal(result.verdict.decision, 'deny', `${point} must deny a revoked agent`);
    assert.equal(result.verdict.reason, 'kill_switch_active');
  }
});

test('regression HIGH-1: a malformed transform body must fail closed, not be dropped', async () => {
  // The defect: a non-object transform was silently dropped, so the
  // decision fell through to an allow and the host executed the
  // ORIGINAL, untransformed target.
  for (const malformed of ['not-an-object', 42, true, ['array']]) {
    const engine = engineReturning({
      decision: 'ALLOW',
      reason: 'ok',
      transform: malformed,
    });
    const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
    assert.equal(
      result.verdict.decision,
      'deny',
      `a transform of ${JSON.stringify(malformed)} must deny`,
    );
    assert.equal(result.verdict.reason, 'runtime_error:policy_output_invalid');
  }
});

test('regression HIGH-3: an unknown member on the policy output must be rejected', async () => {
  // ACS SPEC section 13: normalisation MUST reject unknown members at
  // the policy-output root with runtime_error:policy_output_invalid. It
  // MUST NOT discard them and validate only the remaining fields.
  const engine = engineReturning({
    decision: 'ALLOW',
    reason: 'ok',
    somethingUnexpected: 'value',
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:policy_output_invalid');
});

test('regression HIGH-4: a reserved-prefixed reason must be rejected', async () => {
  // A policy reason may never carry a runtime_error: or host_error:
  // prefix. The runtime owns that namespace.
  for (const reason of ['runtime_error:spoofed', 'host_error:spoofed']) {
    const engine = engineReturning({ decision: 'ALLOW', reason });
    const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
    assert.equal(result.verdict.decision, 'deny', `a reason of ${reason} must deny`);
    assert.equal(result.verdict.reason, 'runtime_error:policy_output_invalid');
  }
});

test('regression HIGH-4: a warnings entry may not carry a reserved prefix', async () => {
  const engine = engineReturning({
    decision: 'AUDIT',
    reason: 'audited',
    warnings: [{ reason: 'runtime_error:spoofed', message: 'x' }],
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:policy_output_invalid');
});

test('regression HIGH-4: a warnings entry may not use the runtime-owned evidence_truncated reason', async () => {
  const engine = engineReturning({
    decision: 'AUDIT',
    reason: 'audited',
    warnings: [{ reason: 'evidence_truncated', message: 'x' }],
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:policy_output_invalid');
});

test('regression HIGH-3: a warnings entry with an unknown member must be rejected', async () => {
  const engine = engineReturning({
    decision: 'AUDIT',
    reason: 'audited',
    warnings: [{ reason: 'r', message: 'm', extra: true }],
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:policy_output_invalid');
});

test('regression MEDIUM-1: unevaluatedProperties must reject an unevaluated property', () => {
  // The defect: the keyword was declared supported but never evaluated,
  // so a document with an extra property PASSED.
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    unevaluatedProperties: false,
  };
  assert.equal(validate({ a: 'x' }, schema).valid, true);
  const result = validate({ a: 'x', b: 1 }, schema);
  assert.equal(result.valid, false, 'an unevaluated property must be rejected');
});

test('regression MEDIUM-1: unevaluatedProperties must see a property evaluated by an allOf branch', () => {
  const schema = {
    type: 'object',
    allOf: [{ properties: { a: { type: 'string' } } }],
    unevaluatedProperties: false,
  };
  assert.equal(validate({ a: 'x' }, schema).valid, true, 'the allOf branch evaluates "a"');
  assert.equal(validate({ a: 'x', b: 1 }, schema).valid, false);
});

test('regression MEDIUM-1: the pinned receipt schema still validates', () => {
  // The pinned interception-record schema uses unevaluatedProperties, so
  // removing the keyword from the supported set broke receipt validation.
  // This test guards against that regression.
  const { getSchema } = require('../../../src/acs/schemas');
  const { buildReceipt } = require('../../../src/acs/receipt');
  const receipt = buildReceipt({
    verdict: { decision: 'allow', reason: 'ok' },
    interventionPoint: 'pre_tool_call',
    mode: 'enforce',
    sessionId: 's1',
    sequence: 1,
  });
  const result = validate(receipt, getSchema('interceptionRecord'));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('regression MEDIUM-2: an array must not equal a plain object', () => {
  // The defect: deepEqual compared an array and an object as equal when
  // both had zero keys, so `const: {}` accepted `[]`.
  assert.equal(deepEqual([], {}), false);
  assert.equal(deepEqual({}, []), false);
  assert.equal(deepEqual([], []), true);
  assert.equal(deepEqual({}, {}), true);
  assert.equal(deepEqual([1], [1]), true);
  assert.equal(deepEqual([1], [2]), false);

  assert.equal(validate([], { const: {} }).valid, false, 'const: {} must not accept []');
  assert.equal(validate([], { enum: [{}] }).valid, false, 'enum [{}] must not accept []');
});

test('regression MEDIUM-3: a resolved approval must not be re-resolved to an approval', async () => {
  // The defect: a request that had been rejected could be resolved again
  // to an approval, which would let a rejected action be replayed into a
  // permitted one.
  const seam = new ApprovalSeam();
  const request = seam.createRequest({
    verdict: { decision: 'deny', reason: 'x' },
    interventionPoint: 'pre_tool_call',
    context: { a: 1 },
  });

  const first = seam.resolve(request.requestId, {
    outcome: 'reject',
    contextIdentity: request.contextIdentity,
  });
  assert.equal(first.ok, false);
  assert.equal(first.verdict.decision, 'deny');

  const second = seam.resolve(request.requestId, {
    outcome: 'approve',
    contextIdentity: request.contextIdentity,
  });
  assert.equal(second.ok, false, 'a second resolution must not lift the deny');
  assert.equal(second.verdict.decision, 'deny');
  assert.ok(second.verdict.reason.startsWith('runtime_error:'));
});

test('regression MEDIUM-4: a non-string context identity must be rejected', async () => {
  const seam = new ApprovalSeam();
  const request = seam.createRequest({
    verdict: { decision: 'deny', reason: 'x' },
    interventionPoint: 'pre_tool_call',
    context: { a: 1 },
  });

  for (const identity of [{ forged: true }, 42, ['x'], true]) {
    const outcome = seam.resolve(request.requestId, {
      outcome: 'approve',
      contextIdentity: identity,
    });
    assert.equal(outcome.ok, false, 'a non-string identity must be rejected');
    assert.equal(outcome.verdict.decision, 'deny');
  }
});

test('regression MEDIUM-5: evaluate_only must not hand back an applied transform', async () => {
  // ACS SPEC section 14: in evaluate_only the host validates the
  // transform but applies none.
  const engine = engineReturning({
    decision: 'ALLOW',
    reason: 'redacted',
    transform: { path: '$target.body', value: '[REDACTED]' },
  });
  const session = new AcsHostSession({
    agentId: 'a1',
    sessionId: 's1',
    engine,
    mode: 'evaluate_only',
  });

  const result = await session.preToolCall({ toolName: 't', args: { body: 'secret' } });

  assert.equal(result.verdict.decision, 'transform', 'the verdict is still computed');
  assert.equal(result.transformedPolicyTarget, null, 'no applied transform in evaluate_only');
  assert.equal(result.mayExecute, false, 'evaluate_only must not be actionable');
  assert.equal(result.enforced, false);
});

test('regression MEDIUM-5: enforce mode does hand back the applied transform', async () => {
  const engine = engineReturning({
    decision: 'ALLOW',
    reason: 'redacted',
    transform: { path: '$target.body', value: '[REDACTED]' },
  });
  const session = new AcsHostSession({ agentId: 'a1', sessionId: 's1', engine });

  const result = await session.preToolCall({ toolName: 't', args: { body: 'secret' } });
  assert.equal(result.transformedPolicyTarget.body, '[REDACTED]');
  assert.equal(result.mayExecute, true);
});
