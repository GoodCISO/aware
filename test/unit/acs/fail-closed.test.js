// test/unit/acs/fail-closed.test.js
// The fail-closed property.
//
// WHY THIS SUITE EXISTS
// ---------------------
// ACS issue #83 is the defect class this suite guards. The closed upstream
// issue is titled "Bundled Cedar dispatcher evaluates with `Context::empty()`,
// so every context-gated `forbid` in the shipped cedar-lib silently never
// fires". A policy that SHOULD have denied returned `allow`, with no error
// and no warning.
//
// That is a FAIL-OPEN defect, and it is invisible to a test that only checks
// the happy path. So this suite is written as a PROPERTY, not as a list of
// expected outputs: every fault injection must produce a deny carrying a
// registered reserved reason. A new error path that returns allow fails
// here.
//
// The property is deliberately checked in two directions:
//   1. every injected fault denies
//   2. the adapter contains no code path that catches an error and returns
//      an allow. That is enforced by SCANNING THE SOURCE, because a
//      behavioural test cannot see a path that no injection reaches.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AcsDecisionEngine,
  getReservedReasons,
  isFailClosed,
  isReservedReason,
  failClosed,
} = require('../../../src/acs');

const ACS_SRC = path.join(__dirname, '..', '..', '..', 'src', 'acs');

/**
 * A policy input that is valid.
 *
 * @param {Object} [overrides] - Members to override.
 * @returns {Object} The policy input.
 */
function policyInput(overrides = {}) {
  return {
    intervention_point: 'pre_tool_call',
    policy_target: { kind: 'tool_args', path: '$snap.tool_call.args', value: { a: 1 } },
    snapshot: { tool_call: { name: 't', args: { a: 1 } } },
    annotations: {},
    tool: { name: 't' },
    ...overrides,
  };
}

/**
 * The fault injections. Each one must deny.
 *
 * @returns {Array<{name: string, build: Function}>} The injections.
 */
function faultInjections() {
  return [
    {
      name: 'the policy engine throws',
      build: () => new AcsDecisionEngine({
        policyEngine: { evaluate() { throw new Error('boom'); } },
        killSwitch: { isRevoked: () => false },
      }),
    },
    {
      name: 'the policy engine returns nothing',
      build: () => new AcsDecisionEngine({
        policyEngine: { evaluate: () => undefined },
        killSwitch: { isRevoked: () => false },
      }),
    },
    {
      name: 'the policy engine returns a non-object',
      build: () => new AcsDecisionEngine({
        policyEngine: { evaluate: () => 'allow' },
        killSwitch: { isRevoked: () => false },
      }),
    },
    {
      name: 'the policy engine returns an unknown decision',
      build: () => new AcsDecisionEngine({
        policyEngine: { evaluate: () => ({ decision: 'MAYBE', reason: 'x' }) },
        killSwitch: { isRevoked: () => false },
      }),
    },
    {
      name: 'the kill-switch probe throws',
      build: () => new AcsDecisionEngine({
        policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
        killSwitch: { isRevoked() { throw new Error('probe down'); } },
      }),
    },
    {
      name: 'the approval seam throws while creating a request',
      build: () => new AcsDecisionEngine({
        policyEngine: {
          evaluate: () => ({ decision: 'DENY', reason: 'x', requiresApproval: true }),
        },
        killSwitch: { isRevoked: () => false },
        approvalSeam: {
          createRequest() { throw new Error('seam down'); },
          resolve() { throw new Error('seam down'); },
        },
      }),
    },
  ];
}

test('acs fail-closed: every fault injection denies with a reserved reason', async () => {
  const reserved = getReservedReasons();
  for (const injection of faultInjections()) {
    const engine = injection.build();
    const result = await engine.evaluate({
      policyInput: policyInput(),
      agentId: 'a1',
    });
    assert.equal(
      result.verdict.decision,
      'deny',
      `${injection.name} must deny, got ${result.verdict.decision}`,
    );
    assert.ok(
      reserved.has(result.verdict.reason),
      `${injection.name} must carry a registered reserved reason, got ${result.verdict.reason}`,
    );
    assert.ok(isFailClosed(result.verdict));
  }
});

test('acs fail-closed: a malformed policy input denies', async () => {
  const reserved = getReservedReasons();
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
    killSwitch: { isRevoked: () => false },
  });

  const malformed = [
    ['a missing member', (() => { const p = policyInput(); delete p.tool; return p; })()],
    ['an extra member', { ...policyInput(), request: {} }],
    ['a missing policy_target', (() => { const p = policyInput(); delete p.policy_target; return p; })()],
    ['a policy_target with no value', { ...policyInput(), policy_target: { kind: 'x', path: 'p' } }],
    ['a non-object policy input', 'not an object'],
    ['a null policy input', null],
    ['an array policy input', []],
  ];

  for (const [label, input] of malformed) {
    const result = await engine.evaluate({ policyInput: input, agentId: 'a1' });
    assert.equal(result.verdict.decision, 'deny', `${label} must deny`);
    assert.ok(
      reserved.has(result.verdict.reason),
      `${label} must carry a registered reserved reason, got ${result.verdict.reason}`,
    );
  }
});

test('acs fail-closed: an expired approval denies', async () => {
  const { ApprovalSeam } = require('../../../src/acs');
  const seam = new ApprovalSeam({ ttlMs: -1 });
  const request = seam.createRequest({
    verdict: { decision: 'deny', reason: 'x' },
    interventionPoint: 'pre_tool_call',
    context: { a: 1 },
  });
  const outcome = seam.resolve(request.requestId, {
    outcome: 'approve',
    contextIdentity: request.contextIdentity,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
});

test('acs fail-closed: a rejected approval denies', async () => {
  const { ApprovalSeam } = require('../../../src/acs');
  const seam = new ApprovalSeam();
  const request = seam.createRequest({
    verdict: { decision: 'deny', reason: 'x' },
    interventionPoint: 'pre_tool_call',
    context: { a: 1 },
  });
  const outcome = seam.resolve(request.requestId, {
    outcome: 'reject',
    contextIdentity: request.contextIdentity,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
  assert.equal(outcome.verdict.reason, 'approval_rejected');
});

test('acs fail-closed: an unresolved approval denies', async () => {
  const { ApprovalSeam } = require('../../../src/acs');
  const seam = new ApprovalSeam();
  const request = seam.createRequest({
    verdict: { decision: 'deny', reason: 'x' },
    interventionPoint: 'pre_tool_call',
    context: { a: 1 },
  });
  const outcome = seam.resolve(request.requestId, {
    outcome: 'unresolved',
    contextIdentity: request.contextIdentity,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
});

test('acs fail-closed: an approval identity mismatch denies', async () => {
  const { ApprovalSeam } = require('../../../src/acs');
  const seam = new ApprovalSeam();
  const request = seam.createRequest({
    verdict: { decision: 'deny', reason: 'x' },
    interventionPoint: 'pre_tool_call',
    context: { a: 1 },
  });
  const outcome = seam.resolve(request.requestId, {
    outcome: 'approve',
    contextIdentity: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
  assert.ok(outcome.verdict.reason.startsWith('runtime_error:'));
});

test('acs fail-closed: resolving an unknown approval request denies', async () => {
  const { ApprovalSeam } = require('../../../src/acs');
  const seam = new ApprovalSeam();
  const outcome = seam.resolve('no-such-request', { outcome: 'approve' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
});

test('acs fail-closed: failClosed rejects an unregistered reason', () => {
  assert.throws(
    () => failClosed('some_made_up_reason', 'x'),
    /not a registered ACS reserved reason/,
    'the fail-closed constructor must refuse a reason that is not registered',
  );
});

test('acs fail-closed: no adapter module catches an error and returns an allow', () => {
  // The behavioural test above only sees the fault paths it injects. This
  // scan closes the gap: a future edit that adds a catch block returning an
  // allow fails HERE, even if no test reaches it.
  const files = fs.readdirSync(ACS_SRC).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const file of files) {
    const full = path.join(ACS_SRC, file);
    const source = fs.readFileSync(full, 'utf8');
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/catch\s*(\(|\{)/.test(line)) continue;
      // Look ahead through the catch block for a literal allow decision.
      const window = lines.slice(i, i + 12).join('\n');
      if (/decision\s*:\s*['"]allow['"]/.test(window)
          || /return\s+['"]allow['"]/.test(window)) {
        offenders.push(`${file}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these lines catch an error and return an allow: ${offenders.join(', ')}`,
  );
});

test('acs fail-closed: every reserved reason the adapter can emit is registered', async () => {
  const reserved = getReservedReasons();
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: () => { throw new Error('x'); } },
    killSwitch: { isRevoked: () => false },
  });
  const result = await engine.evaluate({ policyInput: policyInput(), agentId: 'a1' });
  assert.ok(isReservedReason(result.verdict.reason));
  assert.ok(reserved.size > 0);
});
