// test/unit/trainer/score-instrument-parity.test.js
//
// Regression test for kanban t_99423c45.
//
// The defect: the DPO gate compared `chosen.prm_score` (a LENGTH HEURISTIC,
// capped at 0.75) against `rejected.prm_score` (a real PRM-judge score,
// routinely 0.8-1.0). The gap was systematically negative and the
// directionality check dropped BETTER-refined pairs as "PRM-inverted" —
// 74,840 of 329,558 live pairs (39.9%), of which 69,287 were exactly the
// chosen=0.75-heuristic-ceiling vs rejected>0.75-judge case.
//
// These tests assert that the gate no longer compares across instruments.

import { test } from "node:test";
import assert from "node:assert/strict";

import { filterOutcomePairs } from "../../../src/trainer/outcome-filter.js";
import { toDpoDataset, sameScoreInstrument } from "../../../src/trainer/dpo-dataset.js";

// A legacy record: the chosen side carries the length heuristic (0.75),
// the rejected side carries a judge score (0.9). The refined answer is
// better, but the old gate dropped it as "inverted".
function makeLegacyHeuristicRecord() {
  return {
    problem: "What is 2+2?",
    chosen: { reasoning: "4 — verified 2+2 by adding", prm_score: 0.75 },
    rejected: { reasoning: "4", prm_score: 0.9 },
    task_type: "arithmetic",
    _content_hash: "legacy1",
  };
}

// The same pair, now written by the fixed producer: both sides judge-sourced.
function makeJudgePairRecord() {
  return {
    problem: "What is 2+2?",
    chosen: {
      reasoning: "4 — verified 2+2 by adding",
      prm_score: 0.9,
      prm_score_source: "prm_judge",
      refinement_confidence: 0.75,
    },
    rejected: { reasoning: "4", prm_score: 0.8, prm_score_source: "prm_judge" },
    task_type: "arithmetic",
    _content_hash: "judge1",
  };
}

// Judge declaration (kanban t_155a95a1). This suite is about INSTRUMENT
// PARITY, not about the judge's role -- but the gap magnitude is only a gate
// for an independent judge with a gating role, so the fixtures declare one.
// The parity checks themselves run for every judge.
function declareGateJudge(rec, judgeModel = "judge-model-x") {
  const decl = {
    prm_score_role: "launch_gate",
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

// -- outcome-filter: the gate ---------------------------------------------

test('outcome-filter: a better-refined pair is NOT dropped as inverted (judge-sourced on both sides)', () => {
  // The regression this card exists for: chosen 0.9 > rejected 0.8, both
  // from the PRM judge. The gap is positive (0.1), so the pair must NOT be
  // reported as inverted. It falls below the 0.20 minGap default, so it is
  // dropped as below-threshold — a different reason, and the correct one.
  const result = filterOutcomePairs([declareGateJudge(makeJudgePairRecord())], { rule: 'min_score_gap' });
  assert.equal(result.dropped.length, 1);
  assert.doesNotMatch(
    result.dropped[0].reason,
    /inverted/,
    `a judge-scored better-refined pair must never be reported as inverted, got '${result.dropped[0].reason}'`
  );
  assert.match(result.dropped[0].reason, /^min_score_gap:0\.1000</);
});

test('outcome-filter: the refined side being better by the judge keeps the pair (minGap 0.20)', () => {
  // chosen 0.95 vs rejected 0.70 -> gap 0.25, above the 0.20 default.
  const rec = declareGateJudge(makeJudgePairRecord());
  rec.chosen.prm_score = 0.95;
  rec.rejected.prm_score = 0.70;
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
});

test('outcome-filter: a legacy heuristic-vs-judge pair is dropped as mixed instruments, not as inverted', () => {
  const result = filterOutcomePairs([makeLegacyHeuristicRecord()], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped.length, 1);
  assert.match(
    result.dropped[0].reason,
    /^min_score_gap:mixed_instruments/,
    `expected a mixed-instrument reason, got '${result.dropped[0].reason}'`
  );
  // The old reason was 'min_score_gap:inverted:-0.1500<=0' — which claimed
  // the refined answer was WORSE. It was not; the two numbers came from
  // different instruments.
  assert.doesNotMatch(result.dropped[0].reason, /inverted/);
});

test('outcome-filter: an explicitly surrogate-sourced chosen side is dropped as mixed instruments', () => {
  const rec = declareGateJudge(makeJudgePairRecord());
  rec.chosen.prm_score_source = 'length_heuristic';
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /^min_score_gap:mixed_instruments/);
});

test('outcome-filter: two untagged legacy sides on the SAME heuristic bucket are still comparable', () => {
  // chosen 0.75 vs rejected 0.6 — both heuristic buckets. Legacy records
  // like this are genuine same-instrument comparisons and must keep the
  // existing behaviour (gap 0.15 < minGap 0.20 -> dropped as below-threshold,
  // NOT as mixed instruments).
  const rec = declareGateJudge(makeLegacyHeuristicRecord());
  rec.rejected.prm_score = 0.6;
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 0);
  assert.match(result.dropped[0].reason, /^min_score_gap:0\.1500</);
});

test('outcome-filter: two untagged legacy sides with a positive gap above minGap are kept', () => {
  const rec = declareGateJudge(makeLegacyHeuristicRecord());
  rec.chosen.prm_score = 0.6;
  rec.rejected.prm_score = 0.4;
  const result = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 1);
});

// -- dpo-dataset: the assembler -------------------------------------------

test('dpo-dataset: a legacy heuristic-vs-judge pair is skipped, not packaged', () => {
  const result = toDpoDataset([makeLegacyHeuristicRecord()], { format: 'messages' });
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.mixedInstrument, 1);
  assert.equal(result.skipped.lowGap, 0);
});

test('dpo-dataset: a judge-scored better-refined pair IS packaged', () => {
  const result = toDpoDataset([declareGateJudge(makeJudgePairRecord())], { format: 'messages' });
  assert.equal(result.rows.length, 1);
  assert.equal(result.skipped.mixedInstrument, 0);
  assert.equal(result.skipped.lowGap, 0);
});

test('dpo-dataset: sameScoreInstrument recognises the legacy heuristic signature', () => {
  assert.equal(
    sameScoreInstrument({ prm_score: 0.75 }, { prm_score: 0.9 }),
    false,
    'legacy heuristic chosen vs judge rejected must not be comparable'
  );
  assert.equal(
    sameScoreInstrument({ prm_score: 0.75 }, { prm_score: 0.6 }),
    true,
    'two legacy heuristic buckets ARE comparable'
  );
  assert.equal(
    sameScoreInstrument(
      { prm_score: 0.9, prm_score_source: 'prm_judge' },
      { prm_score: 0.8, prm_score_source: 'prm_judge' }
    ),
    true
  );
  assert.equal(
    sameScoreInstrument(
      { prm_score: 0.9, prm_score_source: 'prm_judge' },
      { prm_score: 0.8, prm_score_source: 'length_heuristic' }
    ),
    false
  );
});
