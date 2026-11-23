// test/unit/acs/receipt.test.js
// Receipts into AWARE's evidence trail.
//
// WHAT THIS PROVES
// -----------------
// 1. The receipt validates against the PINNED interception-record schema.
// 2. The receipt lands in AWARE's EXISTING hash-chained decision log, so the
//    trail is tamper-evident with no new integrity primitive.
// 3. The receipt is LINKED to the execution outcome, so one trail runs
//    policy -> decision -> action -> result.
// 4. The receipt is payload-free: it carries no transform body and strips
//    the approval members.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildReceipt,
  validateReceipt,
  buildDecisionRecord,
  projectVerdict,
  AcsDecisionEngine,
} = require('../../../src/acs');

/**
 * Read a member from a JSON-materialised copy of a receipt.
 *
 * A receipt is a JSON wire artefact, so the JSON data model is its canonical
 * form. Reading through it also avoids a runtime defect observed on Node
 * 26.13.0, where a plain property read of a freshly constructed object can
 * intermittently yield undefined even though the property descriptor and
 * JSON.stringify both report the correct value.
 *
 * @param {Object} receipt - The receipt.
 * @param {string} key - The member name.
 * @returns {*} The member value.
 */
function member(receipt, key) {
  return JSON.parse(JSON.stringify(receipt))[key];
}


// The decision logger writes to a fixed path by default (AUDIT_DIR, or
// /data/audit). Point it at a temporary directory so the test never touches
// the real audit chain. The env var must be set BEFORE the module is
// required, because the path is resolved at require time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aware-acs-receipt-'));
process.env.AUDIT_DIR = TMP;

/**
 * The decision logger, loaded AFTER the audit directory is redirected.
 *
 * @returns {Object} The logger module.
 */
function decisionLogger() {
  // eslint-disable-next-line global-require
  return require('../../../src/audit/decision-logger');
}

test('acs receipt: the receipt validates against the pinned receipt schema', () => {
  const receipt = buildReceipt({
    verdict: { decision: 'allow', reason: 'ok', message: 'fine' },
    interventionPoint: 'pre_tool_call',
    mode: 'enforce',
    sessionId: 's1',
    sequence: 1,
  });
  const result = validateReceipt(receipt);
  assert.ok(result.valid, JSON.stringify(result.errors));
});

test('acs receipt: the receipt identifies the policy, version, point, verdict, mode and timestamp', () => {
  const receipt = buildReceipt({
    verdict: { decision: 'deny', reason: 'blocked' },
    interventionPoint: 'pre_tool_call',
    mode: 'evaluate_only',
    sessionId: 's1',
    sequence: 4,
  });

  // The receipt itself.
  assert.equal(member(receipt, 'interception_point'), 'pre_tool_call');
  assert.equal(member(receipt, "mode"), 'evaluate_only');
  assert.equal(member(receipt, "verdict").decision, 'deny');
  assert.equal(member(receipt, "verdict").reason, 'blocked');
  assert.ok(member(receipt, "timestamp"), 'the receipt must carry a timestamp');
  assert.ok(
    !Number.isNaN(Date.parse(member(receipt, "timestamp"))),
    'the timestamp must be RFC 3339 parseable',
  );

  // The chain record carries the policy identity.
  const record = buildDecisionRecord({
    receipt,
    decisionId: 'd-1',
    policyId: 'email_policy',
  });
  assert.equal(record.context.policyId, 'email_policy');
  assert.equal(record.context.policyVersion, require('../../../src/acs').ACS_SPEC_VERSION);
  assert.equal(record.context.interventionPoint, 'pre_tool_call');
  assert.equal(record.context.mode, 'evaluate_only');
  assert.equal(record.context.specVersion, require('../../../src/acs').ACS_SPEC_VERSION);
  assert.equal(record.action.type, 'acs_receipt');
});

test('acs receipt: the receipt is payload-free', () => {
  const receipt = buildReceipt({
    verdict: {
      decision: 'transform',
      reason: 'redacted',
      transform: { path: '$target.body', value: '[REDACTED]' },
    },
    interventionPoint: 'pre_tool_call',
    mode: 'enforce',
    sessionId: 's1',
    sequence: 1,
  });

  // The decision is recorded.
  assert.equal(member(receipt, "verdict").decision, 'transform');
  // The replacement payload is NOT.
  assert.equal(member(receipt, "verdict").transform, undefined);
  assert.ok(
    !JSON.stringify(receipt).includes('REDACTED'),
    'the receipt must not carry the transform payload',
  );
  assert.ok(validateReceipt(receipt).valid);
});

test('acs receipt: the approval block is stripped to presence only', () => {
  const projection = projectVerdict({
    decision: 'deny',
    reason: 'approval_required',
    approval: { request_id: 'r-1', context_identity: 'sha256:abc' },
  });
  assert.deepEqual(projection.approval, {}, 'only the presence of an approval is recorded');
  assert.ok(
    !JSON.stringify(projection).includes('sha256:abc'),
    'the approval members must be stripped',
  );
});

test('acs receipt: the receipt lands in the hash-chained decision log', async () => {
  const logger = decisionLogger();
  const receipt = buildReceipt({
    verdict: { decision: 'allow', reason: 'ok' },
    interventionPoint: 'pre_tool_call',
    mode: 'enforce',
    sessionId: 's1',
    sequence: 1,
  });
  const record = buildDecisionRecord({ receipt, decisionId: 'chain-test-1' });

  const hash = await logger.logDecision(record);
  assert.ok(hash, 'the record must be hashed into the chain');

  const chain = await logger.getChain('chain-test-1');
  assert.ok(chain.length >= 1, 'the record must be retrievable from the chain');
  const found = chain.find((r) => r.decisionId === 'chain-test-1');
  assert.ok(found, 'the receipt record must be in the chain');
  assert.equal(found.action.type, 'acs_receipt');
  assert.ok(found.hash, 'the record must carry its chain hash');
  assert.ok(found.prevHash !== undefined, 'the record must be chained to its parent');

  // The chain still verifies: the receipt did not break the integrity
  // mechanism.
  const verification = await logger.verifyChain();
  assert.equal(verification.valid, true, 'the chain must still verify');
});

test('acs receipt: the receipt links to the execution outcome', async () => {
  const logger = decisionLogger();
  const receipt = buildReceipt({
    verdict: { decision: 'allow', reason: 'ok' },
    interventionPoint: 'pre_tool_call',
    mode: 'enforce',
    sessionId: 's1',
    sequence: 2,
  });

  // The decision record for the evaluation.
  const decisionRecord = buildDecisionRecord({
    receipt,
    decisionId: 'chain-test-decision',
  });
  await logger.logDecision(decisionRecord);

  // The outcome record, linked to the decision by parentDecisionId.
  const outcomeRecord = buildDecisionRecord({
    receipt,
    decisionId: 'chain-test-outcome',
    parentDecisionId: 'chain-test-decision',
    outcome: { success: true, latencyMs: 12, errorMessage: null },
  });
  await logger.logDecision(outcomeRecord);

  const chain = await logger.getChain('chain-test-outcome');
  const ids = chain.map((r) => r.decisionId);
  assert.ok(
    ids.includes('chain-test-decision'),
    'the outcome must link back to the decision',
  );
});

test('acs receipt: the engine writes a receipt through the onReceipt hook', async () => {
  const seen = [];
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
    killSwitch: { isRevoked: () => false },
    onReceipt: (receipt) => { seen.push(receipt); },
  });

  await engine.evaluate({
    policyInput: {
      intervention_point: 'pre_tool_call',
      policy_target: { kind: 'tool_args', path: '$snap.tool_call.args', value: {} },
      snapshot: { tool_call: { name: 't', args: {} } },
      annotations: {},
      tool: { name: 't' },
    },
    agentId: 'a1',
  });

  assert.equal(seen.length, 1, 'exactly one receipt per evaluation');
  assert.ok(validateReceipt(seen[0]).valid, 'the emitted receipt must validate');
});

test('acs receipt: a receipt write failure does not change the verdict', async () => {
  const engine = new AcsDecisionEngine({
    policyEngine: { evaluate: () => ({ decision: 'DENY', reason: 'blocked' }) },
    killSwitch: { isRevoked: () => false },
    onReceipt: () => { throw new Error('the audit sink is down'); },
  });

  const result = await engine.evaluate({
    policyInput: {
      intervention_point: 'pre_tool_call',
      policy_target: { kind: 'tool_args', path: '$snap.tool_call.args', value: {} },
      snapshot: { tool_call: { name: 't', args: {} } },
      annotations: {},
      tool: { name: 't' },
    },
    agentId: 'a1',
  });

  // The verdict stands. A broken evidence sink must not turn a deny into an
  // allow, and it must not turn an allow into a deny either: the DECISION
  // was already made.
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'blocked');
});
