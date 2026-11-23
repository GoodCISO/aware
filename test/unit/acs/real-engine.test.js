// test/unit/acs/real-engine.test.js
// The adapter against the REAL AWARE policy engine.
//
// WHY THIS SUITE EXISTS
// ---------------------
// Every other ACS suite uses a STUB policy engine. A stub proves the
// adapter's own logic, but it cannot prove the adapter works with the
// engine it actually ships against.
//
// The adversarial review found a case this suite now covers: the real
// policy engine returns {decision, reason, policyId, riskLevel,
// requiresApproval}. When the normaliser was taught to reject unknown
// policy-output members, those AWARE-internal members had to be allowed
// explicitly, or the adapter would have rejected every REAL decision.
//
// A note on the process: the real policy store starts an auto-backup
// interval that holds the event loop open, so this suite exits explicitly
// rather than waiting for the runner. That is a property of AWARE's store,
// not of the adapter.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AcsDecisionEngine, validateReceipt } = require('../../../src/acs');

/**
 * The real AWARE policy engine.
 *
 * @returns {Object} The policy engine.
 */
function realPolicyEngine() {
  // eslint-disable-next-line global-require
  const { getPolicyEngine } = require('../../../src/policies/engine');
  return getPolicyEngine();
}

/**
 * A valid pre_tool_call policy input.
 *
 * @returns {Object} The policy input.
 */
function policyInput() {
  return {
    intervention_point: 'pre_tool_call',
    policy_target: { kind: 'tool_args', path: '$snap.tool_call.args', value: { body: 'x' } },
    snapshot: { tool_call: { name: 'send_email', args: { body: 'x' } } },
    annotations: {},
    tool: { name: 'send_email' },
  };
}

test('acs real engine: the adapter evaluates a REAL AWARE policy decision', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: realPolicyEngine(),
    killSwitch: { isRevoked: () => false },
  });

  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });

  // The real engine returns a decision with AWARE-internal members
  // (policyId, riskLevel, requiresApproval). The normaliser must accept
  // those and reject only genuinely unknown members.
  assert.ok(
    ['allow', 'deny', 'transform'].includes(result.verdict.decision),
    `the real engine must yield a conformant verdict, got ${result.verdict.decision}`,
  );
  assert.ok(result.verdict.reason, 'the verdict must carry a reason');
  assert.ok(
    validateReceipt(result.receipt).valid,
    'the receipt must validate against the pinned schema',
  );
});

test('acs real engine: the real engine default is a DENY, and the adapter preserves it', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: realPolicyEngine(),
    killSwitch: { isRevoked: () => false },
  });

  // The real AWARE engine has DEFAULT_DECISION = DENY, and an unknown
  // tool is denied outright. The adapter must NOT soften that into an
  // allow: a deny is a deny.
  const result = await engine.evaluate({
    policyInput: {
      ...policyInput(),
      tool: { name: 'a_tool_that_is_not_in_the_catalog' },
      snapshot: { tool_call: { name: 'a_tool_that_is_not_in_the_catalog', args: {} } },
    },
    agentId: 'a1',
  });

  assert.equal(result.verdict.decision, 'deny', 'the real default deny must be preserved');
  assert.ok(result.verdict.reason, 'the deny must carry a reason');
});

test('acs real engine: the real decision shape passes the member check', async () => {
  // Read the real engine's decision and assert that every member it
  // returns is one the normaliser allows. This is the direct guard
  // against the normaliser rejecting legitimate AWARE decisions.
  const policyEngine = realPolicyEngine();
  const decision = policyEngine.evaluate({
    agentId: 'a1',
    tool: 'send_email',
    context: {},
  });

  const { normalizeVerdict } = require('../../../src/acs/normalize');
  // The AWARE decision vocabulary maps onto the ACS vocabulary, so the
  // normaliser must accept it.
  const verdict = normalizeVerdict({
    ...decision,
    decision: decision.decision,
  });

  assert.ok(
    ['allow', 'deny', 'transform'].includes(verdict.decision),
    `the real decision must normalise, got ${verdict.decision}`,
  );
});
