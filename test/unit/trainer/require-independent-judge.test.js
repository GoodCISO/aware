// test/unit/trainer/require-independent-judge.test.js — kanban t_155a95a1
//
// The `require_independent_judge` filter rule, and the demotion of the PRM
// gap to a diagnostic when the judge was not independent.
//
// The rule being enforced (measurement-experimentation-ops/references/04-ai-product-evaluation.md):
//   "Same family -> the verdict is a DIAGNOSTIC, never a launch gate." (04:187-190)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterOutcomePairs, listFilterRules } from '../../../src/trainer/outcome-filter.js';

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

function withJudge(rec, { role, independent, model = 'judge-model-x' }) {
  // Both sides are tagged judge-sourced so the score-instrument parity
  // check (t_99423c45) does not fire first: the legacy-heuristic signature
  // (chosen on a 0.4/0.5/0.6/0.75 bucket, rejected off it) is what this
  // suite is NOT about.
  const decl = {
    prm_score_role: role,
    prm_score_independent: independent,
    prm_score_judge_model: model,
  };
  // Only DEFAULT the source when the fixture has not set one -- a fixture
  // that deliberately sets 'length_heuristic' on one side is testing the
  // parity guard, and overwriting it would hide the very thing it asserts.
  rec.chosen = { ...rec.chosen, prm_score_source: rec.chosen?.prm_score_source || 'prm_judge' };
  rec.rejected = { ...rec.rejected, prm_score_source: rec.rejected?.prm_score_source || 'prm_judge' };
  rec.prm_score_role = decl.prm_score_role;
  rec.prm_score_independent = decl.prm_score_independent;
  rec.prm_score_judge_model = decl.prm_score_judge_model;
  rec.chosen = { ...rec.chosen, ...decl };
  rec.rejected = { ...rec.rejected, ...decl };
  return rec;
}

// -- The rule itself -------------------------------------------------------

test('require_independent_judge: DROPS a pair whose judge was not independent', () => {
  const rec = withJudge(makeRecord(), {
    role: 'diagnostic', independent: false, model: 'MiniMax-M3.1-Flash',
  });
  const result = filterOutcomePairs([rec], { rule: 'require_independent_judge' });
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped.length, 1);
  assert.equal(
    result.dropped[0].reason,
    'require_independent_judge:prm_score_independent=false'
  );
});

test('require_independent_judge: KEEPS a pair judged by an independent judge', () => {
  const rec = withJudge(makeRecord(), {
    role: 'launch_gate', independent: true, model: 'claude-opus-4',
  });
  const result = filterOutcomePairs([rec], { rule: 'require_independent_judge' });
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
});

test('require_independent_judge: an UNDECLARED judge is dropped (no declaration = diagnostic)', () => {
  const rec = makeRecord();   // no judge tags at all
  const result = filterOutcomePairs([rec], { rule: 'require_independent_judge' });
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped.length, 1);
  assert.equal(
    result.dropped[0].reason,
    'require_independent_judge:prm_score_independent=missing'
  );
});

test('require_independent_judge: the rule is registered in listFilterRules', () => {
  assert.ok(listFilterRules().includes('require_independent_judge'));
});

// -- The orthogonal precondition -------------------------------------------

test('requireIndependentJudge precondition: drops a non-independent pair under min_score_gap too', () => {
  const rec = withJudge(makeRecord(), {
    role: 'diagnostic', independent: false, model: 'MiniMax-M3.1-Flash',
  });
  const result = filterOutcomePairs([rec], {
    rule: 'min_score_gap',
    requireIndependentJudge: true,
  });
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped.length, 1);
  assert.equal(
    result.dropped[0].reason,
    'require_independent_judge:prm_score_independent=false'
  );
});

test('requireIndependentJudge precondition: keeps an independent pair under min_score_gap', () => {
  const rec = withJudge(makeRecord(), {
    role: 'launch_gate', independent: true, model: 'claude-opus-4',
  });
  const result = filterOutcomePairs([rec], {
    rule: 'min_score_gap',
    requireIndependentJudge: true,
  });
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
});

// -- The gap is DEMOTED, not removed ---------------------------------------

test('min_score_gap: the gap does not gate on its own while the judge is same-family', () => {
  // A tiny gap (0.05 < the 0.20 default) used to be a DROP. With a
  // same-family judge it is a DIAGNOSTIC: the pair is admitted and the gap
  // is reported, because "A diagnostic result never becomes a launch
  // signal" (04:37-38).
  const rec = withJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.60 },
    rejected: { reasoning: 'B', prm_score: 0.55 },
  }), { role: 'diagnostic', independent: false, model: 'MiniMax-M3.1-Flash' });
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 1, 'the pair must be admitted as a diagnostic');
  assert.equal(result.dropped.length, 0);
  assert.equal(result.stats.totalDiagnostic, 1);
  assert.match(result.diagnostics[0].reason, /^min_score_gap:diagnostic:0\.0500$/);
});

test('min_score_gap: the gap signal is PRESERVED, not removed', () => {
  const rec = withJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.90 },
    rejected: { reasoning: 'B', prm_score: 0.20 },
  }), { role: 'diagnostic', independent: false, model: 'MiniMax-M3.1-Flash' });
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  // The gap (0.70) is still computed and reported — it just does not gate.
  assert.match(result.diagnostics[0].reason, /diagnostic:0\.7000/);
  // And the raw scores are untouched on the record.
  assert.equal(result.kept[0].chosen.prm_score, 0.90);
  assert.equal(result.kept[0].rejected.prm_score, 0.20);
});

test('min_score_gap: an independent judge with a gating role DOES gate on the gap', () => {
  const rec = withJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.60 },
    rejected: { reasoning: 'B', prm_score: 0.55 },
  }), { role: 'launch_gate', independent: true, model: 'claude-opus-4' });
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /^min_score_gap:0\.0500<0\.2$/);
});

test('min_score_gap: an independent judge with a DIAGNOSTIC role does not gate', () => {
  // Independence is necessary for a gate, not sufficient.
  const rec = withJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.60 },
    rejected: { reasoning: 'B', prm_score: 0.55 },
  }), { role: 'diagnostic', independent: true, model: 'claude-opus-4' });
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 1);
  assert.equal(result.stats.totalDiagnostic, 1);
});

test('min_score_gap: the score-instrument PARITY check still runs for a same-family judge', () => {
  // The parity check is about COMPARABILITY, not certification, so it must
  // NOT be demoted. A mixed-instrument pair is still dropped.
  const rec = withJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.75, prm_score_source: 'length_heuristic' },
    rejected: { reasoning: 'B', prm_score: 0.9, prm_score_source: 'prm_judge' },
  }), { role: 'diagnostic', independent: false, model: 'MiniMax-M3.1-Flash' });
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /^min_score_gap:mixed_instruments/);
});

test('min_score_gap: the DIRECTIONALITY check still runs for a same-family judge', () => {
  // The directionality check is LABEL INTEGRITY — the pair's own labels
  // contradict its own scores — so it is not demoted either.
  // chosen (0.70) is BELOW rejected (0.80): the pair's own labels contradict
  // its own numbers, which is a defect in the PAIR -- not a judgement about
  // quality -- so the directionality check drops it regardless of the role.
  const rec = withJudge(makeRecord({
    chosen: { reasoning: 'A', prm_score: 0.70, prm_score_source: 'prm_judge' },
    rejected: { reasoning: 'B', prm_score: 0.80, prm_score_source: 'prm_judge' },
  }), { role: 'diagnostic', independent: false, model: 'MiniMax-M3.1-Flash' });
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /^min_score_gap:inverted:/);
});
