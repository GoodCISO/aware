// test/unit/acs/approval.test.js
// The approval seam.
//
// ACS SPEC section 13: a `deny` carrying an `approval` block is a LIFTABLE
// deny. ACS SPEC section 17: the host MUST route an `escalate` verdict to
// an approval path and MUST NOT carry out the action until that path
// resolves.
//
// AGENT-HOOKS-0.1 section 9 (vendored as
// docs/acs/schemas/approval.schema.json) adds the ECHO RULE: a resolution's
// context_identity "MUST equal the request's context_identity byte for
// byte (echo rule, section 9); null echoes as null."
//
// The outcomes are approve, reject and unresolved. Only approve lifts the
// deny. Everything else leaves the deny standing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ApprovalSeam,
  ApprovalOutcome,
  ApprovalStore,
  computeContextIdentity,
} = require('../../../src/acs/approval');

/**
 * Create a request on a fresh seam.
 *
 * @param {ApprovalSeam} seam - The seam.
 * @param {Object} [context] - The approver context.
 * @returns {Object} The request.
 */
function makeRequest(seam, context = { tool: 'send_email', target: { to: 'a@b.c' } }) {
  return seam.createRequest({
    verdict: { decision: 'deny', reason: 'approval_required' },
    interventionPoint: 'pre_tool_call',
    context,
  });
}

test('acs approval: a request carries an identity, a status and an expiry', () => {
  const seam = new ApprovalSeam();
  const request = makeRequest(seam);

  assert.ok(request.requestId, 'the request must carry an id');
  assert.equal(request.status, ApprovalOutcome.UNRESOLVED);
  assert.equal(request.interventionPoint, 'pre_tool_call');
  assert.ok(request.contextIdentity.startsWith('sha256:'), 'the identity must be a sha256 digest');
  assert.ok(request.expiresAt > request.createdAt, 'the request must expire');
  assert.equal(request.resolvedAt, null);
});

test('acs approval: approving lifts the deny', () => {
  const seam = new ApprovalSeam();
  const request = makeRequest(seam);

  const outcome = seam.resolve(request.requestId, {
    outcome: 'approve',
    contextIdentity: request.contextIdentity,
    resolvedBy: 'reviewer@example.com',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.verdict.decision, 'allow');
  assert.equal(outcome.verdict.reason, 'approval_granted');
  assert.equal(outcome.request.status, ApprovalOutcome.APPROVE);
  assert.equal(outcome.request.resolvedBy, 'reviewer@example.com');
});

test('acs approval: rejecting leaves the deny standing', () => {
  const seam = new ApprovalSeam();
  const request = makeRequest(seam);

  const outcome = seam.resolve(request.requestId, {
    outcome: 'reject',
    contextIdentity: request.contextIdentity,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
  assert.equal(outcome.verdict.reason, 'approval_rejected');
  assert.equal(outcome.request.status, ApprovalOutcome.REJECT);
});

test('acs approval: an unresolved approval leaves the deny standing', () => {
  const seam = new ApprovalSeam();
  const request = makeRequest(seam);

  const outcome = seam.resolve(request.requestId, {
    outcome: 'unresolved',
    contextIdentity: request.contextIdentity,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
  assert.equal(outcome.verdict.reason, 'approval_unresolved');
});

test('acs approval: an identity mismatch is rejected and the deny stands', () => {
  // The echo rule. An approval obtained for one content must not be usable
  // against another content.
  const seam = new ApprovalSeam();
  const request = makeRequest(seam);

  const outcome = seam.resolve(request.requestId, {
    outcome: 'approve',
    contextIdentity: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
  assert.ok(outcome.verdict.reason.startsWith('runtime_error:'));
  assert.equal(outcome.request.status, ApprovalOutcome.UNRESOLVED);
});

test('acs approval: an expired request cannot be approved', () => {
  const seam = new ApprovalSeam({ ttlMs: -1 });
  const request = makeRequest(seam);

  const outcome = seam.resolve(request.requestId, {
    outcome: 'approve',
    contextIdentity: request.contextIdentity,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
  assert.ok(outcome.verdict.reason.startsWith('runtime_error:'));
});

test('acs approval: an unknown request id denies', () => {
  const seam = new ApprovalSeam();
  const outcome = seam.resolve('no-such-request', { outcome: 'approve' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
});

test('acs approval: an unknown outcome denies', () => {
  const seam = new ApprovalSeam();
  const request = makeRequest(seam);
  const outcome = seam.resolve(request.requestId, {
    outcome: 'maybe',
    contextIdentity: request.contextIdentity,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict.decision, 'deny');
});

test('acs approval: a missing resolution denies', () => {
  const seam = new ApprovalSeam();
  const request = makeRequest(seam);
  for (const resolution of [null, undefined, 'approve', 42]) {
    const outcome = seam.resolve(request.requestId, resolution);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.verdict.decision, 'deny');
  }
});

test('acs approval: the context identity is content-derived', () => {
  const a = computeContextIdentity({ tool: 'x', args: { to: 'a@b.c' } });
  const b = computeContextIdentity({ tool: 'x', args: { to: 'a@b.c' } });
  const c = computeContextIdentity({ tool: 'x', args: { to: 'z@b.c' } });
  assert.equal(a, b, 'the same context must yield the same identity');
  assert.notEqual(a, c, 'a different context must yield a different identity');
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('acs approval: a null context identity echoes as null', () => {
  const seam = new ApprovalSeam();
  const request = seam.createRequest({
    verdict: { decision: 'deny', reason: 'x' },
    interventionPoint: 'pre_tool_call',
    context: null,
    contextIdentity: null,
  });
  assert.equal(request.contextIdentity, null);

  // A resolution that echoes null resolves normally.
  const outcome = seam.resolve(request.requestId, {
    outcome: 'approve',
    contextIdentity: null,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verdict.decision, 'allow');

  // A resolution that does NOT echo null is rejected.
  const seam2 = new ApprovalSeam();
  const request2 = seam2.createRequest({
    verdict: { decision: 'deny', reason: 'x' },
    interventionPoint: 'pre_tool_call',
    context: null,
    contextIdentity: null,
  });
  const outcome2 = seam2.resolve(request2.requestId, {
    outcome: 'approve',
    contextIdentity: 'sha256:something',
  });
  assert.equal(outcome2.ok, false);
  assert.equal(outcome2.verdict.decision, 'deny');
});

test('acs approval: the seam emits an event for every request and resolution', () => {
  const events = [];
  const seam = new ApprovalSeam({ onEvent: (e) => events.push(e) });
  const request = makeRequest(seam);
  seam.resolve(request.requestId, {
    outcome: 'approve',
    contextIdentity: request.contextIdentity,
  });

  const types = events.map((e) => e.type);
  assert.ok(types.includes('approval_requested'));
  assert.ok(types.includes('approval_resolved'));
});

test('acs approval: an event-listener failure does not break the verdict', () => {
  const seam = new ApprovalSeam({
    onEvent: () => { throw new Error('the audit sink is down'); },
  });
  const request = makeRequest(seam);
  const outcome = seam.resolve(request.requestId, {
    outcome: 'approve',
    contextIdentity: request.contextIdentity,
  });
  // The approval still resolves. A broken audit listener must not turn an
  // approval into a failure.
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verdict.decision, 'allow');
});

test('acs approval: an injected store is used', () => {
  const store = new ApprovalStore();
  const seam = new ApprovalSeam({ store });
  const request = makeRequest(seam);
  assert.equal(store.size, 1);
  assert.equal(store.get(request.requestId).requestId, request.requestId);
});

test('acs approval: the request can be read back', () => {
  const seam = new ApprovalSeam();
  const request = makeRequest(seam);
  const read = seam.getRequest(request.requestId);
  assert.ok(read);
  assert.equal(read.requestId, request.requestId);
  assert.equal(seam.getRequest('nope'), null);
});
