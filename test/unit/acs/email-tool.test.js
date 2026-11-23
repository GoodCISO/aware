// test/unit/acs/email-tool.test.js
// The ACS email-tool example, reproduced end to end against AWARE.
//
// WHAT THIS IS
// ------------
// The task requires: "Reproduce Microsoft's acs-email-tool example end to end
// with AWARE as the engine, covering all three outcomes (allow, transform
// and deny)."
//
// The upstream example lives at
// github.com/microsoft/agent-governance-toolkit/examples/acs-email-tool
// (commit f85abe1fffc5aaeed716a94bd6654677329215b9). It is MIT-licensed.
// The policy is re-implemented here in AWARE's terms; no upstream source is
// copied. The behaviour is the same.
//
// THE THREE OUTCOMES
// -------------------
//   allow     an internal recipient passes through unchanged
//   transform a tracking token in the body is redacted before the tool runs
//   deny      an external recipient is refused
//
// ONE DIVERGENCE FROM UPSTREAM, AND WHY
// ------------------------------------
// The upstream example returns the transform path "$policy_target.body".
// ACS SPEC section 3.2 says the pre-0.4 "$policy_target" root "MUST fail
// closed with runtime_error:transform_invalid", and the verdict schema
// requires the path to match ^\$target(\.|\[|\$). So the upstream example's
// transform case CANNOT pass against a conformant runtime.
//
// This implementation uses "$target.body", which is the conformant spelling.
// See docs/acs/DESIGN.md finding F-2.
//
// The upstream test also asserts the deny path produces NO output and the
// transform path produces the REDACTED body. Both are asserted here.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AcsHostSession, AcsDecisionEngine } = require('../../../src/acs');

/**
 * The tracking-token pattern from the upstream example.
 *
 * @param {string} body - The message body.
 * @returns {string} The body with tracking tokens redacted.
 */
function redactTrackingToken(body) {
  return body.replace(/TRACK-[A-Z0-9]+/g, '[REDACTED]');
}

/**
 * The upstream email policy, re-implemented as an AWARE policy engine stub.
 *
 * It returns the AWARE decision vocabulary, so the NORMALISATION to the ACS
 * verdict set is exercised too.
 *
 * @param {Object} request - The AWARE policy request.
 * @returns {Object} The AWARE decision.
 */
function emailPolicy(request) {
  const args = (request.context && request.context.targets) || {};
  const recipient = typeof args.to === 'string' ? args.to : '';
  const body = typeof args.body === 'string' ? args.body : '';

  if (recipient.toLowerCase().endsWith('@example.net')) {
    return { decision: 'DENY', reason: 'external_recipient_blocked' };
  }

  const redacted = redactTrackingToken(body);
  if (redacted !== body) {
    // AWARE has no TRANSFORM decision in its own vocabulary. The transform
    // is expressed through the adapter's transform path, so the stub
    // reports the rewrite it wants and the adapter carries it.
    return {
      decision: 'ALLOW',
      reason: 'tracking_token_redacted',
      transform: { path: '$target.body', value: redacted },
    };
  }

  return { decision: 'ALLOW', reason: 'internal_recipient_allowed' };
}

/**
 * A host session wired to the email policy.
 *
 * @returns {AcsHostSession} The session.
 */
function makeSession() {
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: emailPolicy },
    killSwitch: { isRevoked: () => false },
  });
  return new AcsHostSession({
    agentId: 'email-agent',
    sessionId: 'test-session',
    engine,
  });
}

/**
 * The upstream example's send_email stand-in.
 *
 * @param {Object} args - The arguments the tool received.
 * @returns {Object} The tool output.
 */
function sendEmail(args) {
  return { sent: true, ...args };
}

test('acs email-tool: an internal recipient is allowed and the body is unchanged', async () => {
  const session = makeSession();
  const args = { to: 'customer@example.com', body: 'Your case is ready.' };

  const result = await session.preToolCall({ toolName: 'send_email', args, callId: 'email-1' });

  assert.equal(result.verdict.decision, 'allow');
  assert.ok(result.permits, 'the host must be permitted to carry out the action');

  const output = sendEmail(args);
  assert.equal(output.body, 'Your case is ready.');
});

test('acs email-tool: a tracking token is redacted and the tool receives the redacted body', async () => {
  const session = makeSession();
  const args = {
    to: 'customer@example.com',
    body: 'Your case is ready. Tracking token: TRACK-123',
  };

  const result = await session.preToolCall({ toolName: 'send_email', args, callId: 'email-2' });

  assert.equal(result.verdict.decision, 'transform');
  assert.ok(result.permits, 'a transform permits the action');
  assert.ok(result.transformedPolicyTarget, 'the host must receive the transformed target');

  // The host applies the transform and carries out the action with the
  // TRANSFORMED value.
  const enforcedArgs = result.transformedPolicyTarget;
  const output = sendEmail(enforcedArgs);
  assert.equal(output.body, 'Your case is ready. Tracking token: [REDACTED]');
  assert.notEqual(output.body, args.body, 'the untransformed body must not be sent');
});

test('acs email-tool: an external recipient is denied and the tool never runs', async () => {
  const session = makeSession();
  const args = { to: 'partner@example.net', body: 'Status update' };

  let executed = false;
  const result = await session.preToolCall({ toolName: 'send_email', args, callId: 'email-3' });

  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'external_recipient_blocked');
  assert.equal(result.permits, false, 'the host must NOT be permitted to carry out the action');

  // The upstream host pattern: `if not decision.verdict.decision.permits:
  // return decision, None`. The tool must not run.
  if (result.permits) {
    executed = true;
    sendEmail(args);
  }
  assert.equal(executed, false, 'the denied tool call must not execute');
});

test('acs email-tool: the external-domain check is case-insensitive', async () => {
  const session = makeSession();
  const result = await session.preToolCall({
    toolName: 'send_email',
    args: { to: 'partner@EXAMPLE.NET', body: 'Status update' },
    callId: 'email-4',
  });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'external_recipient_blocked');
});

test('acs email-tool: the transform path is rooted at $target, not the retired $policy_target', async () => {
  const session = makeSession();
  const result = await session.preToolCall({
    toolName: 'send_email',
    args: { to: 'customer@example.com', body: 'Tracking token: TRACK-123' },
    callId: 'email-5',
  });
  // The runtime returns the transform UNAPPLIED. The path in the verdict is
  // the conformant spelling.
  assert.equal(result.verdict.transform.path, '$target.body');
  assert.ok(
    !result.verdict.transform.path.startsWith('$policy_target'),
    'the retired root must not be used',
  );
});

test('acs email-tool: every outcome produces a receipt that validates', async () => {
  const { validateReceipt } = require('../../../src/acs');
  const session = makeSession();

  const cases = [
    { to: 'customer@example.com', body: 'ok' },
    { to: 'customer@example.com', body: 'Tracking token: TRACK-123' },
    { to: 'partner@example.net', body: 'ok' },
  ];

  for (const [index, args] of cases.entries()) {
    const result = await session.preToolCall({
      toolName: 'send_email',
      args,
      callId: `email-receipt-${index}`,
    });
    const validation = validateReceipt(result.receipt);
    assert.ok(
      validation.valid,
      `receipt ${index} must validate: ${JSON.stringify(validation.errors)}`,
    );
  }
});
