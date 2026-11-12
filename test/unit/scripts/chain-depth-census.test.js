// test/unit/scripts/chain-depth-census.test.js
//
// ADR-079 — validates scripts/chain-depth-census.js.
//
// The census is a read-time derived metric over the audit chain. Its report
// is the deliverable, so the tests assert the REPORT CONTRACT, not the
// internals:
//
//   1. A synthetic chain with a known shape (root -> child -> grandchild,
//      plus a dangling child and a malformed line) produces the expected
//      depthP95 / depthMax / danglingCount / malformedLines.
//   2. A dangling parent is NOT counted as a root (ADR-079 §D2 / §6.3) —
//      counting it as a root is the specific defect the metric exists to
//      avoid, because it understates the chained share.
//   3. `malformedLines` is ALWAYS reported (ADR-079 §6.2) — never silently
//      skipped.
//   4. The report never contains a bare mean (ADR-079 §D3).
//   5. The script is READ-ONLY (ADR-079 §6.4): the chain file's size and
//      mtime are unchanged after a run, and the source contains no
//      write-mode file call.
//
// The script runs as a child process so the test can check stdout, the exit
// code, and the filesystem independently.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../../scripts/chain-depth-census.js');

/**
 * Build a decision-chain record in the shape the live logger writes.
 *
 * @param {string} decisionId
 * @param {string|null} parentDecisionId
 * @param {string} actionType
 * @returns {string} a JSONL line
 */
function record(decisionId, parentDecisionId, actionType = 'coordinate') {
  return JSON.stringify({
    decisionId,
    parentDecisionId,
    timestamp: '2026-11-12T00:00:00.000Z',
    actor: { agentId: 'tester', trustScore: 1 },
    action: { type: actionType, target: 'chain', reason: 'fixture' },
    context: {},
    outcome: { success: true, latencyMs: 0, errorMessage: null },
    prevHash: '0'.repeat(64),
    hash: '0'.repeat(64)
  });
}

/**
 * Write a fixture chain into a fresh temp dir and return its path.
 *
 * @param {string[]} lines raw file lines
 * @returns {string} the chain file path
 */
function writeFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-depth-census-'));
  const file = path.join(dir, 'decision-chain.jsonl');
  fs.writeFileSync(file, lines.length ? lines.join('\n') + '\n' : '');
  return file;
}

/**
 * Run the census against a chain file and parse its report.
 *
 * @param {string} chainPath
 * @returns {{status: number, report: object|null, stderr: string}}
 */
function runCensus(chainPath) {
  const result = spawnSync(process.execPath, [SCRIPT, chainPath], {
    encoding: 'utf8',
    env: { ...process.env, AUDIT_DIR: path.dirname(chainPath) }
  });
  let report = null;
  if (result.stdout && result.stdout.trim()) {
    report = JSON.parse(result.stdout);
  }
  return { status: result.status, report, stderr: result.stderr };
}

// ── 1. Known-shape synthetic chain ────────────────────────────────────
//
//   root      -> depth 0
//   child     -> depth 1  (parent = root)
//   grandchild-> depth 2  (parent = child)
//   dangling  -> depth undefined (parent id absent from the chain)
//   + 1 malformed line
//
// Expected: depthMax = 2, depthP95 = 2, danglingCount = 1, malformedLines = 1.
//
test('synthetic chain with a known shape reports the expected depths', () => {
  const chain = writeFixture([
    record('root-1', null),
    record('child-1', 'root-1'),
    record('grandchild-1', 'child-1'),
    record('dangling-1', 'no-such-parent'),
    '{"decisionId":"torn","parentDecisionId":null,"timestamp":'
  ]);

  const { status, report } = runCensus(chain);

  assert.equal(status, 0);
  assert.equal(report.records, 4, 'four parseable records');
  assert.equal(report.malformedLines, 1, 'the torn line is counted, not skipped');
  assert.equal(report.danglingCount, 1, 'the orphan is counted as dangling');
  assert.equal(report.depthMax, 2, 'the deepest resolved depth is 2');
  assert.equal(report.depthP95, 2, 'p95 over the resolved set is 2');
  assert.equal(report.unresolvedCount, 1, 'the orphan has no defined depth');
  assert.deepEqual(report.depthHistogram, { 0: 1, 1: 1, 2: 1 });
  assert.equal(report.recordsRead, report.records);
});

// ── 2. A dangling parent is NOT a root ─────────────────────────────────
//
// ADR-079 §D2: "A dangling record must not be treated as a root: that would
// understate the chained share and hide a chain gap." If the orphan were
// scored as depth 0, it would land in the histogram as a root and the
// chainedShare denominator/numerator would both shift. This test pins that
// it does not.
//
test('a dangling parent is reported as dangling, not as a root', () => {
  const chain = writeFixture([
    record('root-1', null),
    record('orphan-1', 'missing-parent')
  ]);

  const { report } = runCensus(chain);

  assert.equal(report.danglingCount, 1);
  assert.equal(report.depthHistogram['0'], 1, 'only the real root is depth 0');
  assert.equal(
    Object.keys(report.depthHistogram).length,
    1,
    'the orphan contributes no depth bucket'
  );
  assert.equal(report.unresolvedCount, 1);
  // The share is computed over ALL records; the orphan is not chained and
  // not counted as chained, so it does not inflate the numerator.
  assert.equal(report.chainedShare, 0);
});

// ── 3. chainedShare over a mixed population ────────────────────────────
//
// 1 root + 2 chained + 1 dangling over 4 records -> 2/4 = 0.5.
//
test('chainedShare counts only records with depth > 0', () => {
  const chain = writeFixture([
    record('root-1', null),
    record('child-1', 'root-1'),
    record('grandchild-1', 'child-1'),
    record('orphan-1', 'missing-parent')
  ]);

  const { report } = runCensus(chain);

  assert.equal(report.records, 4);
  assert.equal(report.chainedShare, 0.5, 'two of four records are chained');
  assert.equal(report.depthMax, 2);
});

// ── 4. malformedLines is always reported ────────────────────────────────
//
// ADR-079 §6.2: skipping unparseable lines under-reports the population.
// A chain of ONLY malformed lines must still report a non-zero
// malformedLines, not an empty population with no error signal.
//
test('malformedLines is reported even when every line is malformed', () => {
  const chain = writeFixture([
    '{not json',
    'also not json',
    '{"unterminated": '
  ]);

  const { status, report } = runCensus(chain);

  assert.equal(status, 0);
  assert.equal(report.records, 0);
  assert.equal(report.malformedLines, 3);
  assert.equal(report.danglingCount, 0);
  assert.deepEqual(report.depthHistogram, {});
  assert.equal(report.chainedShare, 0);
});

// ── 5. A blank line is skipped, not counted as malformed ───────────────
//
// This matches the decision-logger's cold-index rebuild, which skips blank
// lines and counts only JSON parse failures.
//
test('blank lines are skipped rather than counted as malformed', () => {
  const chain = writeFixture([
    record('root-1', null),
    '',
    '   ',
    record('child-1', 'root-1')
  ]);

  const { report } = runCensus(chain);

  assert.equal(report.records, 2);
  assert.equal(report.malformedLines, 0);
  assert.equal(report.depthMax, 1);
});

// ── 6. No bare mean in the report ──────────────────────────────────────
//
// ADR-079 §D3: "A bare mean is prohibited in the first cut." The report
// exposes chainedShare + depthP95 + depthMax + danglingCount and must not
// carry a `mean`/`average` field.
//
test('the report contains no bare mean field', () => {
  const chain = writeFixture([record('root-1', null), record('child-1', 'root-1')]);

  const { report } = runCensus(chain);

  const keys = Object.keys(report).map((k) => k.toLowerCase());
  assert.equal(
    keys.some((k) => k === 'mean' || k === 'average' || k === 'avg' || k === 'depthmean'),
    false,
    `report must not carry a mean field (keys: ${keys.join(', ')})`
  );
  // The three numbers D3 names must all be present.
  assert.ok('chainedShare' in report);
  assert.ok('depthP95' in report);
  assert.ok('depthMax' in report);
  assert.ok('danglingCount' in report);
});

// ── 7. Read-only proof (ADR-079 §6.4) ──────────────────────────────────
//
// The chain file's size AND mtime must be unchanged after a run, and the
// source must contain no write-mode file call.
//
test('the census does not modify the chain file', () => {
  const chain = writeFixture([
    record('root-1', null),
    record('child-1', 'root-1'),
    'garbage'
  ]);

  const before = fs.statSync(chain);
  const beforeSize = before.size;
  const beforeMtime = before.mtimeMs;

  const { status } = runCensus(chain);
  assert.equal(status, 0);

  const after = fs.statSync(chain);
  assert.equal(after.size, beforeSize, 'chain file size unchanged');
  assert.equal(after.mtimeMs, beforeMtime, 'chain file mtime unchanged');

  // No sibling artefact was written into the audit dir either.
  const siblings = fs.readdirSync(path.dirname(chain));
  assert.deepEqual(siblings, ['decision-chain.jsonl'], 'no report file written to disk');
});

test('the census source contains no write-mode file operation', () => {
  // Comments are stripped first: the script's own header documents that it
  // makes no `writeFile` call, and scanning prose would make the source
  // fail its own proof. What must be checked is the EXECUTABLE code.
  const source = fs
    .readFileSync(SCRIPT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const forbidden = [
    /writeFile/,
    /appendFile/,
    /createWriteStream/,
    /unlink/,
    /rmSync/,
    /mkdir/,
    /truncate/,
    /open\s*\([^)]*['"]w/,
    /openSync\s*\([^)]*['"]w/,
    /openSync\s*\([^)]*['"]a/
  ];
  for (const pattern of forbidden) {
    assert.equal(
      pattern.test(source),
      false,
      `source must not contain a write-mode call matching ${pattern}`
    );
  }
});

// ── 8. Chain path resolution ───────────────────────────────────────────
//
// The path is an argument, defaulting to $AUDIT_DIR/decision-chain.jsonl
// and falling back to /data/audit/decision-chain.jsonl. It must resolve on
// the host AND inside the coordinator container.
//
test('the chain path defaults to $AUDIT_DIR/decision-chain.jsonl', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-depth-census-env-'));
  const file = path.join(dir, 'decision-chain.jsonl');
  fs.writeFileSync(file, record('root-1', null) + '\n');

  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, AUDIT_DIR: dir }
  });

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.chainFile, path.join(dir, 'decision-chain.jsonl'));
  assert.equal(report.records, 1);
});

test('a missing chain file exits 2 with a stderr message and no stdout report', () => {
  const missing = path.join(os.tmpdir(), 'chain-depth-census-does-not-exist', 'decision-chain.jsonl');
  const result = spawnSync(process.execPath, [SCRIPT, missing], { encoding: 'utf8' });

  assert.equal(result.status, 2);
  assert.equal(result.stdout.trim(), '', 'no report is printed on failure');
  assert.match(result.stderr, /cannot open chain file/);
});
