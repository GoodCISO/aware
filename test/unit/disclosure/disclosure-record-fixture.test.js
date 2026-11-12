// test/unit/disclosure/disclosure-record-fixture.test.js
// AC3 for ADR-079: the export -> verify round trip on the REAL 1k fixture,
// cross-checked by the INDEPENDENT stdlib verifier that already ships in
// this repo (scripts/verify_chain.py, from 32081af9).
//
// Why a separate file: node:test runs each test file in its own process,
// so this file can point AUDIT_DIR at a temp dir seeded with the fixture
// BEFORE requiring decision-logger (which reads AUDIT_DIR at require time).
// The point of the test is that a THIRD PARTY — here, a Python process
// that has never seen AWARE's source — can verify the record's window.
//
// pattern: node:test + node:assert.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(REPO_ROOT, 'tests/audit/fixtures/aware_chain_1k.jsonl');
const PY_VERIFIER = path.join(REPO_ROOT, 'scripts/verify_chain.py');

// Seed the audit dir with the real fixture BEFORE requiring the logger.
const TEST_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'disclosure-fixture-test-'));
process.env.AUDIT_DIR = TEST_AUDIT_DIR;
fs.copyFileSync(FIXTURE, path.join(TEST_AUDIT_DIR, 'decision-chain.jsonl'));

const {
  buildDisclosureRecord,
  verifyChainWindow,
  PublicationGranularity
} = require('../../../src/disclosure/disclosure-record');
const { GapTracker } = require('../../../src/compliance/gap-tracker');

const FIXTURE_RECORDS = fs.readFileSync(FIXTURE, 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));

test('the 1k fixture is present and is the real thing', () => {
  assert.ok(fs.existsSync(FIXTURE), `missing fixture at ${FIXTURE}`);
  assert.strictEqual(FIXTURE_RECORDS.length, 1000);
  assert.strictEqual(FIXTURE_RECORDS[0].prevHash, '0'.repeat(64));
});

test('a disclosure record over a 1000-record window verifies', async () => {
  const tracker = new GapTracker();
  const gapId = tracker.createGap({
    controlId: 'MCP02',
    frameworkId: 'OWASP_MCP_TOP_10',
    severity: 'HIGH',
    title: 'Fixture-window disclosure'
  });

  const record = await buildDisclosureRecord({
    gap: tracker.getGap(gapId),
    fromDecisionId: FIXTURE_RECORDS[0].decisionId,
    toDecisionId: FIXTURE_RECORDS[FIXTURE_RECORDS.length - 1].decisionId,
    granularity: PublicationGranularity.P1_CLASS,
    gapTracker: tracker
  });

  assert.strictEqual(record.chain.recordCount, 1000);
  assert.strictEqual(record.chain.anchorVerified, true,
    'the fixture chain starts at genesis, so the anchor is verifiable');

  const verdict = verifyChainWindow(record);
  assert.strictEqual(verdict.valid, true, verdict.error || '');
  assert.strictEqual(verdict.recordsChecked, 1000);
  assert.strictEqual(verdict.firstInvalidRecord, null);
});

test('the INDEPENDENT Python verifier accepts the record\'s window', async () => {
  const tracker = new GapTracker();
  const gapId = tracker.createGap({
    controlId: 'MCP02',
    frameworkId: 'OWASP_MCP_TOP_10',
    severity: 'HIGH',
    title: 'Fixture-window disclosure'
  });

  const record = await buildDisclosureRecord({
    gap: tracker.getGap(gapId),
    fromDecisionId: FIXTURE_RECORDS[0].decisionId,
    toDecisionId: FIXTURE_RECORDS[FIXTURE_RECORDS.length - 1].decisionId,
    gapTracker: tracker
  });

  // Write the record's OWN window out — not the fixture — so what the
  // Python verifier checks is exactly what the record carries.
  const windowPath = path.join(TEST_AUDIT_DIR, 'disclosure-window.jsonl');
  fs.writeFileSync(
    windowPath,
    record.chain.records.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  );

  // The independent verifier: stdlib only, never imported AWARE's source.
  const out = execFileSync('python3', [PY_VERIFIER, windowPath], {
    encoding: 'utf8'
  });
  assert.match(out, /PASS verified 1000 records/);
});

test('the independent Python verifier REJECTS a tampered window', async () => {
  const tracker = new GapTracker();
  const gapId = tracker.createGap({
    controlId: 'MCP02',
    frameworkId: 'OWASP_MCP_TOP_10',
    severity: 'HIGH',
    title: 'Fixture-window disclosure'
  });

  const record = await buildDisclosureRecord({
    gap: tracker.getGap(gapId),
    fromDecisionId: FIXTURE_RECORDS[0].decisionId,
    toDecisionId: FIXTURE_RECORDS[FIXTURE_RECORDS.length - 1].decisionId,
    gapTracker: tracker
  });

  // Tamper with the carried window and re-serialise it.
  const tampered = record.chain.records.map(r => ({ ...r }));
  tampered[500].outcome.errorMessage = 'tampered';
  const tamperedPath = path.join(TEST_AUDIT_DIR, 'tampered-window.jsonl');
  fs.writeFileSync(
    tamperedPath,
    tampered.map(r => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  );

  let rejected = false;
  try {
    execFileSync('python3', [PY_VERIFIER, tamperedPath], { encoding: 'utf8' });
  } catch (err) {
    rejected = true;
    assert.match(String(err.stderr), /hash mismatch/);
  }
  assert.ok(rejected,
    'the independent verifier must reject a tampered window');
});
