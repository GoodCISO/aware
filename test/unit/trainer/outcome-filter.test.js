// test/unit/trainer/outcome-filter.test.js — Unit tests for src/trainer/outcome-filter.js
//
// Phase 4 (ADR (internal) 618-627): outcome filter gates process-RL pipeline preference
// pairs. The filter is a pure function — these tests assert the
// contract directly, with no I/O, no clock, no randomness.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterOutcomePairs,
  listFilterRules,
} from '../../../src/trainer/outcome-filter.js';

// -- Fixtures ------------------------------------------------------------

function makeRecord(overrides = {}) {
  return {
    problem: 'What is 2+2?',
    chosen: { reasoning: '4', prm_score: 0.9 },
    rejected: { reasoning: '5', prm_score: 0.3 },
    task_type: 'arithmetic',
    _content_hash: 'abc123',
    ...overrides,
  };
}

// Judge declaration helpers (kanban t_155a95a1).
//
// Every preference pair now carries the ROLE of the judge that scored it,
// whether that judge is INDEPENDENT of the candidate, and which model
// served the judge. A record with NO declaration is a diagnostic by default
// ("If you cannot name which of the three it is, it is a diagnostic" --
// 04-ai-product-evaluation.md:35-36), so a gap computed by an undeclared or
// same-family judge is a DIAGNOSTIC and may not gate.
//
// The gap-magnitude tests below are about the GAP, so they declare an
// INDEPENDENT judge with a gating role -- the only case in which the gap
// may decide membership of the training set.
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

// A same-family judge: the producer's own client. Its verdict is a
// diagnostic and may not gate.
function declareSameFamilyJudge(rec, judgeModel = 'MiniMax-M3.1-Flash') {
  const decl = {
    prm_score_role: 'diagnostic',
    prm_score_independent: false,
    prm_score_judge_model: judgeModel,
  };
  rec.prm_score_role = decl.prm_score_role;
  rec.prm_score_independent = decl.prm_score_independent;
  rec.prm_score_judge_model = decl.prm_score_judge_model;
  rec.chosen = { ...rec.chosen, ...decl, prm_score_source: rec.chosen?.prm_score_source || 'prm_judge' };
  rec.rejected = { ...rec.rejected, ...decl, prm_score_source: rec.rejected?.prm_score_source || 'prm_judge' };
  return rec;
}

// -- noop (explicit opt-in) ----------------------------------------------
// As of 2026-06-22 (ADR (internal) Repair 1), 'noop' is no longer the
// default rule. It's still available for explicit opt-in via
// { rule: 'noop' }. These tests verify the explicit noop path still
// works as before.

test('outcome-filter: noop rule (explicit) keeps all valid records', () => {
  const records = [makeRecord(), makeRecord({ problem: 'What is 3+3?' })];
  const result = filterOutcomePairs(records, { rule: 'noop' });
  assert.equal(result.kept.length, 2);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.stats.rule, 'noop');
  assert.equal(result.stats.totalIn, 2);
  assert.equal(result.stats.totalKept, 2);
  assert.equal(result.stats.totalDropped, 0);
});

test('outcome-filter: min_score_gap is the default when options.rule is omitted (changed 2026-06-22 per ADR (internal) Repair 1)', () => {
  const result = filterOutcomePairs([makeRecord()]);
  assert.equal(result.stats.rule, 'min_score_gap');
});

test('outcome-filter: empty input returns empty arrays, not an error', () => {
  const result = filterOutcomePairs([]);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.stats.totalIn, 0);
});

// -- min_score_gap --------------------------------------------------------

test('outcome-filter: min_score_gap drops records with gap < threshold', () => {
  const tight = makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.55 },
    rejected: { reasoning: 'B', prm_score: 0.50 },
  });
  const wide = makeRecord({
    problem: 'What is 4+4?',
    chosen: { reasoning: '8', prm_score: 0.95 },
    rejected: { reasoning: '9', prm_score: 0.20 },
  });
  const result = filterOutcomePairs([declareGateJudge(tight), declareGateJudge(wide)], {
    rule: 'min_score_gap',
    minGap: 0.1,
  });
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].problem, 'What is 4+4?');
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /^min_score_gap:0\.0500<0\.1$/);
});

test('outcome-filter: min_score_gap drops records with missing prm_scores (strict policy, ADR (internal) Repair 1)', () => {
  // Was 'keep' (lenient), now 'drop' (strict). Rationale: ADR (internal)
  // §Precondition 2 requires "PRM scores from real extraction";
  // a pair without scores cannot satisfy that bar.
  const noScores = makeRecord({
    chosen: { reasoning: 'X' },     // no prm_score
    rejected: { reasoning: 'Y' },   // no prm_score
  });
  const result = filterOutcomePairs([noScores], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 0, 'missing scores should now drop the pair');
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].reason, 'min_score_gap:missing_prm_scores');
});

test('outcome-filter: min_score_gap drops records with only chosen.prm_score missing', () => {
  const noChosenScore = makeRecord({
    chosen: { reasoning: 'X' },     // no prm_score
    rejected: { reasoning: 'Y', prm_score: 0.5 },
  });
  const result = filterOutcomePairs([noChosenScore], { rule: 'min_score_gap' });
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].reason, 'min_score_gap:missing_prm_scores');
});

test('outcome-filter: min_score_gap drops records with only rejected.prm_score missing', () => {
  const noRejectedScore = makeRecord({
    chosen: { reasoning: 'X', prm_score: 0.9 },
    rejected: { reasoning: 'Y' },   // no prm_score
  });
  const result = filterOutcomePairs([noRejectedScore], { rule: 'min_score_gap' });
  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].reason, 'min_score_gap:missing_prm_scores');
});

test('outcome-filter: min_score_gap uses default 0.20 when minGap is omitted (changed 2026-06-22 per ADR (internal) Repair 1)', () => {
  const rec = declareGateJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.70 },
    rejected: { reasoning: 'B', prm_score: 0.55 },
  }));
  // gap = 0.15, below 0.20 → drop
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /^min_score_gap/);
});

test('outcome-filter: min_score_gap keeps records with gap >= 0.20 (new default)', () => {
  const rec = declareGateJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.85 },
    rejected: { reasoning: 'B', prm_score: 0.50 },
  }));
  // gap = 0.35, above 0.20 → keep
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 1);
});

test('outcome-filter: min_score_gap directionality check — drops pairs where chosen < rejected (PRM inversion)', () => {
  // The exact pattern from ADR (internal) §Finding 1: PRM scoring inverts
  // chosen/rejected on hedging-vs-hallucination. The directionality
  // check catches these as a hard negative regardless of magnitude.
  const inverted = declareGateJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.75, prm_score_source: 'prm_judge' },
    rejected: { reasoning: 'B', prm_score: 0.80, prm_score_source: 'prm_judge' },
  }));
  const result = filterOutcomePairs([inverted], { rule: 'min_score_gap' });
  assert.equal(result.dropped.length, 1);
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /^min_score_gap:inverted:/);
  assert.match(result.dropped[0].reason, /<=0$/);
});

test('outcome-filter: min_score_gap directionality check — drops pairs where chosen == rejected (tie)', () => {
  // gap = 0 — was previously dropped by magnitude gate (gap + epsilon
  // < minGap), now dropped explicitly by directionality check with a
  // clearer reason string.
  const tied = declareGateJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.5 },
    rejected: { reasoning: 'B', prm_score: 0.5 },
  }));
  const result = filterOutcomePairs([tied], { rule: 'min_score_gap' });
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /^min_score_gap:inverted:0\.0000<=0$/);
});

test('outcome-filter: min_score_gap directionality check — catches ADR (internal) production pair 0 (gap=-0.05)', () => {
  // Reproduction of the exact inversion pattern from
  // /data/awareness-pairs/2026-06-22.jsonl pair 0:
  // "What is AWARE 2.0?" → chosen=0.75, rejected=0.80, gap=-0.05
  //
  // 2026-11-11 (kanban t_99423c45): both sides are tagged judge-sourced.
  // The fixture previously used an untagged chosen=0.75 — which is the
  // legacy LENGTH HEURISTIC bucket, not a judge score — so this test was
  // asserting the behaviour of the very defect this card fixes (a
  // heuristic-vs-judge pair scored as if both were judge scores). The
  // directionality check itself is unchanged; only the fixture's score
  // source is now explicit.
  const rec = declareGateJudge(makeRecord({
    problem: 'What is AWARE 2.0?',
    chosen: { reasoning: 'hedged answer', prm_score: 0.75, prm_score_source: 'prm_judge' },
    rejected: { reasoning: 'confident answer', prm_score: 0.80, prm_score_source: 'prm_judge' },
  }));
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap', minGap: 0.20 });
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /^min_score_gap:inverted:-0\.0500<=0$/);
});

test('outcome-filter: min_score_gap directionality check — catches ADR (internal) production pair 1 (gap=-0.40)', () => {
  // Reproduction of pair 1 from the same file:
  // "Reply with hello" → chosen=0.60, rejected=1.00, gap=-0.40
  //
  // 2026-11-11 (kanban t_99423c45): both sides tagged judge-sourced — the
  // untagged chosen=0.60 was a legacy heuristic bucket, so this fixture
  // was reproducing the mixed-instrument defect rather than a genuinely
  // inverted judge-scored pair.
  const rec = declareGateJudge(makeRecord({
    problem: 'Reply with the single word: hello',
    chosen: { reasoning: 'some answer', prm_score: 0.60, prm_score_source: 'prm_judge' },
    rejected: { reasoning: 'hello', prm_score: 1.00, prm_score_source: 'prm_judge' },
  }));
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap', minGap: 0.20 });
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /^min_score_gap:inverted:-0\.4000<=0$/);
});

test('outcome-filter: min_score_gap directionality check — keeps records where chosen > rejected (positive direction)', () => {
  const rec = makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.85 },
    rejected: { reasoning: 'B', prm_score: 0.50 },
  });
  // gap = 0.35, positive, above 0.20 default → keep
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 1);
});

// -- tag_match ------------------------------------------------------------

test('outcome-filter: tag_match keeps records whose task_type is in the allow-list', () => {
  const math = makeRecord({ task_type: 'arithmetic' });
  const code = makeRecord({ task_type: 'code', problem: 'reverse a string' });
  const result = filterOutcomePairs([math, code], {
    rule: 'tag_match',
    allowedTaskTypes: ['arithmetic'],
  });
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].task_type, 'arithmetic');
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /^tag_match:code/);
});

test('outcome-filter: tag_match with empty allow-list keeps everything', () => {
  // Empty allow-list means "operator hasn't decided yet" — keep all
  const rec = makeRecord({ task_type: 'chitchat' });
  const result = filterOutcomePairs([rec], {
    rule: 'tag_match',
    allowedTaskTypes: [],
  });
  assert.equal(result.kept.length, 1);
});

test('outcome-filter: tag_match drops records with no task_type', () => {
  const rec = makeRecord();
  delete rec.task_type;
  const result = filterOutcomePairs([rec], {
    rule: 'tag_match',
    allowedTaskTypes: ['arithmetic'],
  });
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /<unset>/);
});

// -- azr_result ---------------------------------------------------------
// Phase 4 deliverable 1: ADR (internal) Decision 2 ("AZR pass/fail gates
// process-RL pipeline process training") is enforced here. The index maps
// content_hash → {passed, runId, recordedAt}, populated from the
// aware_azr_results table by the trainer, filtered to passed=true.
//
// Policy (consistent with the missing-scores policy in min_score_gap):
//   - content_hash IN index   → verified PASSED before → KEEP
//   - content_hash NOT IN index → never verified → KEEP (missing-data)
//   - content_hash missing/empty → can't join → KEEP
// The negative case (AZR-verified AND did not pass) is excluded by
// the trainer's query (it only populates azrIndex with passed=true
// rows), so it can never reach the filter.

test('outcome-filter: azr_result keeps records with content_hash in the index', () => {
  const rec = makeRecord({ _content_hash: 'hash_pass_1' });
  const idx = new Map([['hash_pass_1', { passed: true, runId: 'r1', recordedAt: '2026-06-12T00:00:00Z' }]]);
  const result = filterOutcomePairs([rec], { rule: 'azr_result', azrIndex: idx });
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.stats.rule, 'azr_result');
});

test('outcome-filter: azr_result keeps records whose content_hash is NOT in the index (unverified = missing-data policy)', () => {
  // Per the spec comment: missing data (no AZR result) → KEEP. This
  // matches the missing-scores policy in min_score_gap. The strict
  // policy ("drop unverified") would yield empty datasets for the
  // first few training cycles; the lenient policy lets the corpus
  // grow naturally.
  const rec = makeRecord({ _content_hash: 'hash_no_azr' });
  const idx = new Map();  // empty → no record has been AZR-verified
  const result = filterOutcomePairs([rec], { rule: 'azr_result', azrIndex: idx });
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
});

test('outcome-filter: azr_result keeps records with no _content_hash (defensive, can\'t join)', () => {
  const rec = makeRecord({ _content_hash: undefined });
  const idx = new Map();
  const result = filterOutcomePairs([rec], { rule: 'azr_result', azrIndex: idx });
  // No content hash → can't even check the index → keep. Same as
  // missing-data policy.
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
});

test('outcome-filter: azr_result with non-Map azrIndex treats index as empty (defensive)', () => {
  const rec = makeRecord({ _content_hash: 'hash_abc' });
  const result = filterOutcomePairs([rec], { rule: 'azr_result', azrIndex: 'not a map' });
  // Non-Map defaults to empty Map → behaves like empty index → keep.
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
});

test('outcome-filter: azr_result result.stats reflects the lenient policy (all kept, none dropped)', () => {
  const recs = [
    makeRecord({ _content_hash: 'h1' }),
    makeRecord({ _content_hash: 'h2' }),
    makeRecord({ _content_hash: 'h3' }),
  ];
  // Even with only h1 in the index, all 3 records are kept under
  // the lenient policy. This is the contract: azr_result's job is
  // to allow pass-through with verification status, not to require
  // verification.
  const idx = new Map([['h1', { passed: true, runId: 'r1', recordedAt: '' }]]);
  const result = filterOutcomePairs(recs, { rule: 'azr_result', azrIndex: idx });
  assert.equal(result.stats.totalIn, 3);
  assert.equal(result.stats.totalKept, 3);
  assert.equal(result.stats.totalDropped, 0);
  assert.equal(result.stats.rule, 'azr_result');
});

// -- malformed input ------------------------------------------------------

test('outcome-filter: rejects unknown rule name with a clear error', () => {
  assert.throws(
    () => filterOutcomePairs([makeRecord()], { rule: 'magic_beans' }),
    /unknown rule 'magic_beans'/
  );
});

test('outcome-filter: rejects non-array input', () => {
  assert.throws(
    () => filterOutcomePairs('not an array'),
    /records must be an array/
  );
});

test('outcome-filter: drops malformed records (null, string, number)', () => {
  const result = filterOutcomePairs([null, 'a string', 42, makeRecord()]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 3);
  for (const d of result.dropped) {
    assert.equal(d.reason, 'malformed_record');
  }
});

// -- introspection -------------------------------------------------------

test('outcome-filter: listFilterRules returns the canonical set', () => {
  const rules = listFilterRules();
  assert.deepEqual(rules.sort(), [
    'azr_result',
    'min_score_gap',
    'noop',
    'require_independent_judge',
    'tag_match',
  ]);
});

test('outcome-filter: result shape is stable (kept, dropped, stats)', () => {
  const result = filterOutcomePairs([makeRecord()]);
  assert.ok(Array.isArray(result.kept));
  assert.ok(Array.isArray(result.dropped));
  assert.equal(typeof result.stats, 'object');
  assert.ok('rule' in result.stats);
  assert.ok('totalIn' in result.stats);
  assert.ok('totalKept' in result.stats);
  assert.ok('totalDropped' in result.stats);
});
