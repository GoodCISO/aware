// test/unit/trainer/dpo-dataset.test.js — Unit tests for src/trainer/dpo-dataset.js
//
// Phase 4 (ADR (internal) 618-627, ADR (internal) Repair 4): DPO dataset assembly
// for the trainer. Pure function — these tests assert the contract
// directly with no I/O, no clock, no randomness.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toDpoDataset,
  listDpoFormats,
} from '../../../src/trainer/dpo-dataset.js';

// -- Fixtures ------------------------------------------------------------

function makeRecord(overrides = {}) {
  return {
    problem: 'What is 2+2?',
    chosen: { reasoning: '4', prm_score: 0.9 },
    rejected: { reasoning: '5', prm_score: 0.1 },
    task_type: 'arithmetic',
    _content_hash: 'abc123',
    ...overrides,
  };
}

// Judge declaration (kanban t_155a95a1). The assembler's GAP check is a
// quality certification, so it may only fire for an INDEPENDENT judge
// declared with a gating role. The gap-magnitude tests below therefore
// declare one; the demotion tests do not.
function declareGateJudge(rec, judgeModel = 'judge-model-x') {
  const decl = {
    prm_score_role: 'launch_gate',
    prm_score_independent: true,
    prm_score_judge_model: judgeModel,
  };
  rec.prm_score_role = decl.prm_score_role;
  rec.prm_score_independent = decl.prm_score_independent;
  rec.prm_score_judge_model = decl.prm_score_judge_model;
  rec.chosen = { ...rec.chosen, ...decl, prm_score_source: rec.chosen?.prm_score_source || 'prm_judge' };
  rec.rejected = { ...rec.rejected, ...decl, prm_score_source: rec.rejected?.prm_score_source || 'prm_judge' };
  return rec;
}

// -- Empty / invalid input ----------------------------------------------

test('dpo-dataset: empty input returns empty rows, zero skipped', () => {
  const result = toDpoDataset([]);
  assert.deepEqual(result.rows, []);
  // mixedInstrument was added 2026-11-11 (kanban t_99423c45) alongside the
  // score-instrument parity guard.
  assert.deepEqual(result.skipped, {
    lowGap: 0, duplicate: 0, invalid: 0, mixedInstrument: 0, nonIndependentJudge: 0,
    // inverted was added 2026-11-17 (kanban t_ebf7e27f) alongside the
    // directionality check in the assembler.
    inverted: 0,
  });
});

test('dpo-dataset: rejects unknown format with clear error', () => {
  assert.throws(
    () => toDpoDataset([makeRecord()], { format: 'magic' }),
    /unknown format 'magic'/
  );
});

test('dpo-dataset: rejects non-array input', () => {
  assert.throws(
    () => toDpoDataset('not an array'),
    /records must be an array/
  );
});

test('dpo-dataset: drops malformed records (null, string, number)', () => {
  const result = toDpoDataset([null, 'a string', 42, makeRecord()]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.skipped.invalid, 3);
});

test('dpo-dataset: drops records missing chosen.reasoning or rejected.reasoning', () => {
  const noChosenReasoning = makeRecord({
    chosen: { prm_score: 0.9 },
    rejected: { reasoning: '5', prm_score: 0.1 },
    _content_hash: 'h-no-chosen',
  });
  const noRejectedReasoning = makeRecord({
    problem: 'different',
    chosen: { reasoning: '4', prm_score: 0.9 },
    rejected: { prm_score: 0.1 },
    _content_hash: 'h-no-rejected',
  });
  const result = toDpoDataset([noChosenReasoning, noRejectedReasoning]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.invalid, 2);
});

// -- Output format ------------------------------------------------------

test('dpo-dataset: messages format produces correct row shape', () => {
  const result = toDpoDataset([makeRecord()]);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(Array.isArray(row.prompt));
  assert.ok(Array.isArray(row.chosen));
  assert.ok(Array.isArray(row.rejected));
  // prompt is user-message with the problem text
  assert.equal(row.prompt.length, 1);
  assert.equal(row.prompt[0].role, 'user');
  assert.equal(row.prompt[0].content, 'What is 2+2?');
  // chosen is assistant-message with chosen.reasoning
  assert.equal(row.chosen.length, 1);
  assert.equal(row.chosen[0].role, 'assistant');
  assert.equal(row.chosen[0].content, '4');
  // rejected is assistant-message with rejected.reasoning
  assert.equal(row.rejected.length, 1);
  assert.equal(row.rejected[0].role, 'assistant');
  assert.equal(row.rejected[0].content, '5');
});

test('dpo-dataset: messages format is the default when format is omitted', () => {
  const result = toDpoDataset([makeRecord()]);
  // Same shape assertion as the explicit-format test
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].prompt[0].role, 'user');
});

// -- minScoreGap filter ------------------------------------------------

test('dpo-dataset: minScoreGap drops records with gap < threshold', () => {
  const tight = makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.55 },
    rejected: { reasoning: 'B', prm_score: 0.50 },
    _content_hash: 'h-tight',
  });
  const wide = makeRecord({
    problem: 'What is 4+4?',
    chosen: { reasoning: '8', prm_score: 0.95 },
    rejected: { reasoning: '9', prm_score: 0.20 },
    _content_hash: 'h-wide',
  });
  const result = toDpoDataset([declareGateJudge(tight), declareGateJudge(wide)], { minScoreGap: 0.1 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].prompt[0].content, 'What is 4+4?');
  assert.equal(result.skipped.lowGap, 1);
});

test('dpo-dataset: minScoreGap uses default 0.05 when omitted', () => {
  const tight = makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.51 },
    rejected: { reasoning: 'B', prm_score: 0.50 },
    _content_hash: 'h-default-tight',
  });
  const result = toDpoDataset([declareGateJudge(tight)]);
  // gap = 0.01 < 0.05 → drop
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.lowGap, 1);
});

test('dpo-dataset: minScoreGap allows records with missing scores (defensive)', () => {
  // Distinct from outcome-filter.js's "missing scores → drop" policy.
  // dpo-dataset is the second-layer filter; missing scores here means
  // "we can't evaluate gap, so we pass through". outcome-filter is
  // the gate that decides whether the record enters the trainer at all.
  const noScores = makeRecord({
    chosen: { reasoning: 'X' },
    rejected: { reasoning: 'Y' },
    _content_hash: 'h-no-scores',
  });
  const result = toDpoDataset([noScores]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.skipped.lowGap, 0);
});

test('dpo-dataset: minScoreGap also drops inverted pairs (gap < 0)', () => {
  // Documents the gap=−0.05 inversion pattern from ADR (internal) Finding 1.
  // Note: outcome-filter.js now has a directionality check that catches
  // these upstream. This test confirms dpo-dataset also catches them,
  // providing defense in depth.
  //
  // Since t_ebf7e27f the drop is counted as `inverted` rather than
  // `lowGap`: the directionality check now runs for EVERY judge, before the
  // magnitude gate, so the reason for the drop is explicit instead of being
  // a side effect of the magnitude comparison.
  const inverted = makeRecord({
    chosen: { reasoning: 'hedged', prm_score: 0.75, prm_score_source: 'prm_judge' },
    rejected: { reasoning: 'confident', prm_score: 0.80, prm_score_source: 'prm_judge' },
    _content_hash: 'h-inverted',
  });
  const result = toDpoDataset([declareGateJudge(inverted)]);
  // gap = -0.05 → drop
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.inverted, 1);
  assert.equal(result.skipped.lowGap, 0);
});

// -- dedupeByHash -------------------------------------------------------

test('dpo-dataset: dedupeByHash drops second occurrence (first wins)', () => {
  const a = makeRecord({ problem: 'first', _content_hash: 'h-dup' });
  const b = makeRecord({ problem: 'second', _content_hash: 'h-dup' });
  const result = toDpoDataset([a, b]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].prompt[0].content, 'first');
  assert.equal(result.skipped.duplicate, 1);
});

test('dpo-dataset: dedupeByHash=true is the default when option is omitted', () => {
  const a = makeRecord({ problem: 'first', _content_hash: 'h-dup-default' });
  const b = makeRecord({ problem: 'second', _content_hash: 'h-dup-default' });
  const result = toDpoDataset([a, b]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.skipped.duplicate, 1);
});

test('dpo-dataset: dedupeByHash=false keeps duplicates', () => {
  const a = makeRecord({ problem: 'first', _content_hash: 'h-no-dedup' });
  const b = makeRecord({ problem: 'second', _content_hash: 'h-no-dedup' });
  const result = toDpoDataset([a, b], { dedupeByHash: false });
  assert.equal(result.rows.length, 2);
  assert.equal(result.skipped.duplicate, 0);
});

test('dpo-dataset: records without _content_hash are not deduplicated', () => {
  const a = makeRecord({ problem: 'first' });   // no _content_hash
  delete a._content_hash;
  const b = makeRecord({ problem: 'second' });  // no _content_hash
  delete b._content_hash;
  const result = toDpoDataset([a, b]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.skipped.duplicate, 0);
});

// -- Result shape stability --------------------------------------------

test('dpo-dataset: result shape is stable (rows, skipped.{lowGap,duplicate,invalid})', () => {
  const result = toDpoDataset([makeRecord()]);
  assert.ok(Array.isArray(result.rows));
  assert.equal(typeof result.skipped, 'object');
  assert.ok('lowGap' in result.skipped);
  assert.ok('duplicate' in result.skipped);
  assert.ok('invalid' in result.skipped);
});

// -- Introspection -----------------------------------------------------

test('dpo-dataset: listDpoFormats returns the canonical set', () => {
  const formats = listDpoFormats();
  assert.deepEqual(formats, ['messages']);
});

// -- Integration smoke: outcome-filter output → dpo-dataset input -------

test('dpo-dataset: works as second-layer filter after outcome-filter (integration smoke)', () => {
  // Simulate the trainer pipeline: outcome-filter passes records,
  // dpo-dataset assembles them into DPO rows.
  //
  // Pair 0: ADR (internal) production sample (gap=-0.05, inverted)
  // Pair 1: ADR (internal) production sample (gap=-0.40, inverted)
  // Pair 2: clean pair (gap=0.7, should pass both filters)
  const inverted1 = makeRecord({
    problem: 'What is AWARE 2.0?',
    chosen: { reasoning: 'hedged', prm_score: 0.75 },
    rejected: { reasoning: 'confident', prm_score: 0.80 },
    _content_hash: 'h-prod-1',
  });
  const inverted2 = makeRecord({
    problem: 'Reply with hello',
    chosen: { reasoning: 'some', prm_score: 0.60 },
    rejected: { reasoning: 'hello', prm_score: 1.00 },
    _content_hash: 'h-prod-2',
  });
  const clean = makeRecord({
    problem: 'What is 2+2?',
    chosen: { reasoning: '4', prm_score: 0.95 },
    rejected: { reasoning: '5', prm_score: 0.25 },
    _content_hash: 'h-prod-3',
  });

  // After outcome-filter (directionality check): only the clean pair
  // would survive if outcome-filter is run first.
  // Here we simulate "outcome-filter has already run" and pass the
  // clean pair to dpo-dataset.
  const result = toDpoDataset([clean], { minScoreGap: 0.20 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].prompt[0].content, 'What is 2+2?');
});