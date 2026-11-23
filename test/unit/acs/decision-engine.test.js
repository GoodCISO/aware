// test/unit/acs/decision-engine.test.js
// The ACS decision engine: policy input, intervention points, verdicts, modes.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AcsDecisionEngine,
  buildPolicyInput,
  ACS_DECISIONS,
} = require('../../../src/acs');

/**
 * A stub AWARE policy engine.
 *
 * @param {Object} decision - The decision the stub returns.
 * @returns {Object} The stub.
 */
function stubPolicyEngine(decision) {
  return {
    evaluate() {
      return decision;
    },
  };
}

/**
 * A stub kill switch.
 *
 * @param {boolean} revoked - Whether the agent is revoked.
 * @returns {Object} The stub.
 */
function stubKillSwitch(revoked) {
  return {
    isRevoked() {
      return revoked;
    },
  };
}

/**
 * A valid pre_tool_call policy input.
 *
 * @param {Object} [overrides] - Members to override.
 * @returns {Object} The policy input.
 */
function policyInput(overrides = {}) {
  return {
    intervention_point: 'pre_tool_call',
    policy_target: {
      kind: 'tool_args',
      path: '$snap.tool_call.args',
      value: { to: 'customer@example.com', body: 'hello' },
    },
    snapshot: {
      tool_call: { name: 'send_email', args: { to: 'customer@example.com', body: 'hello' } },
    },
    annotations: {},
    tool: { name: 'send_email', clearance: 'internal' },
    ...overrides,
  };
}

test('acs: the policy input has exactly the five canonical members', () => {
  const input = policyInput();
  assert.deepEqual(
    Object.keys(input).sort(),
    ['annotations', 'intervention_point', 'policy_target', 'snapshot', 'tool'],
  );
});

test('acs: buildPolicyInput produces the five canonical members', () => {
  const input = buildPolicyInput({
    interventionPoint: 'pre_tool_call',
    policyTargetValue: { a: 1 },
    snapshot: { tool_call: { name: 't', args: { a: 1 } } },
  });
  assert.deepEqual(
    Object.keys(input).sort(),
    ['annotations', 'intervention_point', 'policy_target', 'snapshot', 'tool'],
  );
  assert.equal(input.policy_target.path, '$snap.tool_call.args');
  assert.equal(input.policy_target.kind, null);
});

test('acs: an ALLOW decision becomes an allow verdict', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'ALLOW', reason: 'within policy' }),
    killSwitch: stubKillSwitch(false),
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'allow');
  assert.equal(result.verdict.reason, 'within policy');
  assert.ok(ACS_DECISIONS.includes(result.verdict.decision));
});

test('acs: a DENY decision becomes a deny verdict', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'DENY', reason: 'blocked by policy' }),
    killSwitch: stubKillSwitch(false),
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'blocked by policy');
});

test('acs: an AUDIT decision becomes an allow carrying a warning', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'AUDIT', reason: 'noted for review' }),
    killSwitch: stubKillSwitch(false),
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  // The `warn` intent normalizes to allow + a warnings[] entry.
  assert.equal(result.verdict.decision, 'allow');
  assert.ok(Array.isArray(result.verdict.warnings));
  assert.equal(result.verdict.warnings.length, 1);
  assert.equal(result.verdict.warnings[0].reason, 'noted for review');
});

test('acs: the adapter never emits warn or escalate as a decision', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'AUDIT', reason: 'r' }),
    killSwitch: stubKillSwitch(false),
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.notEqual(result.verdict.decision, 'warn');
  assert.notEqual(result.verdict.decision, 'escalate');
});

test('acs: a kill switch signal denies before any policy is consulted', async () => {
  let policyCalled = false;
  const engine = new AcsDecisionEngine({
    policyEngine: {
      evaluate() {
        policyCalled = true;
        return { decision: 'ALLOW', reason: 'ok' };
      },
    },
    killSwitch: stubKillSwitch(true),
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'kill_switch_active');
  assert.equal(policyCalled, false, 'the kill switch must short-circuit policy evaluation');
});

test('acs: a kill-switch probe that throws denies rather than allowing', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'ALLOW', reason: 'ok' }),
    killSwitch: {
      isRevoked() {
        throw new Error('probe unavailable');
      },
    },
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.ok(result.verdict.reason.startsWith('runtime_error:'));
});

test('acs: a policy engine that throws denies with a reserved reason', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: {
      evaluate() {
        throw new Error('engine exploded');
      },
    },
    killSwitch: stubKillSwitch(false),
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:policy_invocation_failed');
});

test('acs: an approval requirement produces a liftable deny', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({
      decision: 'DENY',
      reason: 'approval needed',
      requiresApproval: true,
    }),
    killSwitch: stubKillSwitch(false),
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.ok(result.verdict.approval, 'the deny must carry an approval block');
  assert.ok(result.approvalRequestId, 'an approval request must be created');
  assert.equal(result.verdict.approval.request_id, result.approvalRequestId);
});

test('acs: the other five intervention points return a well-formed verdict', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'ALLOW', reason: 'ok' }),
    killSwitch: stubKillSwitch(false),
  });
  for (const point of ['agent_startup', 'input', 'pre_model_call', 'post_model_call', 'agent_shutdown']) {
    const result = await engine.evaluate({
      policyInput: policyInput({ intervention_point: point }),
      agentId: 'a1',
    });
    assert.equal(result.verdict.decision, 'allow', `${point} must return a verdict`);
    assert.ok(ACS_DECISIONS.includes(result.verdict.decision));
    assert.ok(result.receipt, `${point} must still produce a receipt`);
  }
});

test('acs: an unknown intervention point denies', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'ALLOW', reason: 'ok' }),
    killSwitch: stubKillSwitch(false),
  });
  const result = await engine.evaluate({
    policyInput: policyInput({ intervention_point: 'not_a_point' }),
    agentId: 'a1',
  });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:intervention_point_unknown');
});

test('acs: evaluate_only computes and records the same verdict without blocking', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'DENY', reason: 'blocked' }),
    killSwitch: stubKillSwitch(false),
  });
  const enforced = await engine.evaluate({
    policyInput: policyInput(), agentId: 'a1', mode: 'enforce',
  });
  const shadow = await engine.evaluate({
    policyInput: policyInput(), agentId: 'a1', mode: 'evaluate_only',
  });
  assert.equal(shadow.verdict.decision, enforced.verdict.decision);
  assert.equal(shadow.verdict.reason, enforced.verdict.reason);
  assert.equal(enforced.enforced, true);
  assert.equal(shadow.enforced, false);
  // The receipt records the mode in both cases.
  assert.equal(enforced.receipt.mode, 'enforce');
  assert.equal(shadow.receipt.mode, 'evaluate_only');
});

test('acs: the default mode is enforce', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'ALLOW', reason: 'ok' }),
    killSwitch: stubKillSwitch(false),
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.equal(result.mode, 'enforce');
  assert.equal(result.enforced, true);
});

test('acs: an unknown mode denies', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: stubPolicyEngine({ decision: 'ALLOW', reason: 'ok' }),
    killSwitch: stubKillSwitch(false),
  });
  const result = await engine.evaluate({
    policyInput: policyInput(), agentId: 'a1', mode: 'yolo',
  });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:request_invalid');
});
