// test/unit/trainer/dpo-inverted-pair.test.js — kanban t_ebf7e27f
//
// D2: the DPO assembler no longer dropped an INVERTED pair when the judge
// may not gate, while the outcome filter still did. The two paths disagreed,
// and the `noop` filter rule let inverted pairs into the training set.
//
// The defect: the assembler dropped an inverted pair (chosen.prm_score <=
// rejected.prm_score) only as a SIDE EFFECT of the gap-magnitude gate. When
// t_155a95a1 demoted that magnitude gate for a same-family judge, the
// inverted-pair drop went with it -- while the filter's own directionality
// check, which sits ABOVE the demotion, kept dropping inverted pairs.
//
// The fix: the directionality check moves OUT of the judgeMayGate guard, for
// the same reason the filter keeps it there -- "the pair's labels contradict
// its own numbers, which is a defect in the PAIR, not a judgement about
// quality" (src/trainer/outcome-filter.js). The gap MAGNITUDE stays demoted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toDpoDataset } from '../../../src/trainer/dpo-dataset.js';
import { filterOutcomePairs } from '../../../src/trainer/outcome-filter.js';

// -- Fixtures ------------------------------------------------------------

function makeRecord({ chosen, rejected, hash }) {
  return {
    problem: 'What is 2+2?',
    chosen: { reasoning: 'C', prm_score: chosen },
    rejected: { reasoning: 'R', prm_score: rejected },
    task_type: 'arithmetic',
    _content_hash: hash,
  };
}

// Tag both sides with a judge declaration. `role` / `independent` control
// whether the judge MAY gate (kanban t_155a95a1).
function declareJudge(rec, { role, independent, model = 'MiniMax-M3.1-Flash' }) {
  const decl = {
    prm_score_role: role,
    prm_score_independent: independent,
    prm_score_judge_model: model,
  };
  rec.prm_score_role = decl.prm_score_role;
  rec.prm_score_independent = decl.prm_score_independent;
  rec.prm_score_judge_model = decl.prm_score_judge_model;
  rec.chosen = { ...rec.chosen, ...decl, prm_score_source: 'prm_judge' };
  rec.rejected = { ...rec.rejected, ...decl, prm_score_source: 'prm_judge' };
  return rec;
}

const SAME_FAMILY = { role: 'launch_gate', independent: false };
const DIAGNOSTIC_ROLE = { role: 'diagnostic', independent: true, model: 'claude-opus-4' };
const INDEPENDENT_GATE = { role: 'launch_gate', independent: true, model: 'claude-opus-4' };

// An INVERTED pair: the rejected side scored HIGHER than the chosen side.
function invertedRecord(hash, decl = SAME_FAMILY) {
  return declareJudge(
    makeRecord({ chosen: 0.30, rejected: 0.90, hash }),
    decl
  );
}

// The same pair, not inverted: chosen above rejected.
function uprightRecord(hash, decl = SAME_FAMILY, chosen = 0.55, rejected = 0.45) {
  return declareJudge(
    makeRecord({ chosen, rejected, hash }),
    decl
  );
}

// -- AC 1: the assembler drops an inverted pair for EVERY judge ------------

test('dpo-dataset: an inverted pair is dropped for a SAME-FAMILY judge (may not gate)', () => {
  // The defect. Before t_ebf7e27f this pair was PACKAGED: rows=1,
  // skipped.inverted undefined, skipped.nonIndependentJudge=1.
  const result = toDpoDataset([invertedRecord('inv-same-family')]);
  assert.equal(result.rows.length, 0, 'an inverted pair must never be packaged');
  assert.equal(result.skipped.inverted, 1);
});

test('dpo-dataset: an inverted pair is dropped for an UNDECLARED judge', () => {
  // No judge declaration at all -- "if you cannot name which of the three it
  // is, it is a diagnostic" (04-ai-product-evaluation.md:35-36).
  const rec = makeRecord({ chosen: 0.30, rejected: 0.90, hash: 'inv-undeclared' });
  const result = toDpoDataset([rec]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.inverted, 1);
});

test('dpo-dataset: an inverted pair is dropped for a DIAGNOSTIC-role judge', () => {
  // Independent but diagnostic: independence is necessary for a gate, not
  // sufficient (04:37-38). The judge may not gate, so the drop must come
  // from the directionality check, not the magnitude gate.
  const result = toDpoDataset([invertedRecord('inv-diagnostic-role', DIAGNOSTIC_ROLE)]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.inverted, 1);
  assert.equal(result.skipped.lowGap, 0);
});

test('dpo-dataset: an inverted pair is dropped for an INDEPENDENT gating judge', () => {
  // The control that already worked before the fix: a gating judge dropped
  // the pair on the magnitude gate. It must STILL be dropped -- and now for
  // the explicit reason, not as a side effect.
  const result = toDpoDataset([invertedRecord('inv-gate-judge', INDEPENDENT_GATE)]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.inverted, 1);
  assert.equal(result.skipped.lowGap, 0);
});

test('dpo-dataset: a TIE (chosen == rejected) is dropped as inverted', () => {
  // gap === 0 is also a contradiction: the two sides are indistinguishable,
  // so "chosen" is not the better one.
  const rec = declareJudge(
    makeRecord({ chosen: 0.50, rejected: 0.50, hash: 'inv-tie' }),
    SAME_FAMILY
  );
  const result = toDpoDataset([rec]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.inverted, 1);
});

// -- The negative control: the drop is caused by the INVERSION ------------

test('dpo-dataset: the SAME judge admits the non-inverted pair (the drop is not vacuous)', () => {
  // NON-VACUOUS CONTROL. Identical judge declaration, identical fixture
  // shape -- only the scores differ. This test passes BOTH before and after
  // the fix: it is here to prove the fix is NARROW (it drops inverted pairs
  // only), not to detect the defect. If the assembler dropped everything for
  // a same-family judge, this would fail.
  const result = toDpoDataset([uprightRecord('upright-same-family')]);
  assert.equal(result.rows.length, 1, 'a non-inverted pair must still be packaged');
});

// -- AC 2: the demotion still holds ---------------------------------------

test('dpo-dataset: a small POSITIVE gap is ADMITTED for a same-family judge (demotion holds)', () => {
  // The fix must not re-admit the magnitude gate. chosen 0.55 / rejected 0.45
  // -> gap 0.10, below the 0.20 filter default and below a 0.05 assembler
  // threshold under a stricter reading -- but the judge may not certify
  // quality, so the pair is admitted and the gap is a diagnostic.
  //
  // This test passes BOTH before and after the fix: it is the control that
  // the fix did not re-admit the magnitude gate.
  const result = toDpoDataset([uprightRecord('demote-same-family')]);
  assert.equal(result.rows.length, 1, 'the demotion must still admit the pair');
  assert.equal(result.skipped.lowGap, 0, 'the magnitude gate must stay demoted');
  assert.equal(result.skipped.nonIndependentJudge, 1, 'the demotion must stay counted');
});

test('min_score_gap: the demoted gap is REPORTED as a diagnostic, not discarded', () => {
  // The signal survives: the filter reports the gap value on the diagnostic
  // reason, and the raw scores stay on the record.
  const rec = uprightRecord('demote-diagnostic', SAME_FAMILY, 0.55, 0.45);
  const filtered = filterOutcomePairs([rec], { rule: 'min_score_gap' });
  assert.equal(filtered.kept.length, 1, 'the pair must be admitted');
  assert.equal(filtered.stats.totalDiagnostic, 1);
  assert.match(filtered.diagnostics[0].reason, /^min_score_gap:diagnostic:0\.1000$/);

  const assembled = toDpoDataset(filtered.kept);
  assert.equal(assembled.rows.length, 1);
  assert.equal(assembled.rows[0].chosen[0].content, 'C');
  assert.equal(assembled.skipped.nonIndependentJudge, 1);
  // The gap is still computable from the preserved scores on the record.
  const kept = filtered.kept[0];
  assert.ok(
    Math.abs((kept.chosen.prm_score - kept.rejected.prm_score) - 0.10) < 1e-9,
    'the gap must still be computable from the preserved scores'
  );
});

test('min_score_gap: an independent gating judge still gates on the magnitude', () => {
  // The magnitude gate is demoted only for a judge that may not gate.
  // This test passes BOTH before and after the fix: the fix changed only the
  // directionality check, not the magnitude gate.
  const rec = uprightRecord('gate-magnitude', INDEPENDENT_GATE, 0.55, 0.45);
  const result = toDpoDataset([rec], { minScoreGap: 0.20 });
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.lowGap, 1);
});

// -- The demoted-judge counter counts ADMISSIONS, not lookups ---------------

test('dpo-dataset: a DROPPED pair is not counted as a demoted-judge admission', () => {
  // `nonIndependentJudge` is the trainer's "pairs admitted WITHOUT their
  // score being allowed to gate" count (src/trainer/index.js rowsDiagnostic).
  // Counting a pair that was DROPPED would report a diagnostic for a pair
  // that never reached the training set.
  const dropped = invertedRecord('diag-dropped');
  const result = toDpoDataset([dropped]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.inverted, 1);
  assert.equal(
    result.skipped.nonIndependentJudge,
    0,
    'a dropped pair must not be counted as a demoted-judge admission'
  );
});

test('dpo-dataset: a DROPPED mixed-instrument pair is not counted as a demoted-judge admission', () => {
  const rec = declareJudge(
    makeRecord({ chosen: 0.75, rejected: 0.90, hash: 'diag-mixed' }),
    SAME_FAMILY
  );
  rec.chosen.prm_score_source = 'length_heuristic';
  const result = toDpoDataset([rec]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.mixedInstrument, 1);
  assert.equal(result.skipped.nonIndependentJudge, 0);
});

test('dpo-dataset: an ADMITTED pair with a demoted judge IS counted', () => {
  const result = toDpoDataset([uprightRecord('diag-admitted')]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.skipped.nonIndependentJudge, 1);
});

// -- AC 3: the parity check is unchanged ---------------------------------

test('dpo-dataset: the score-instrument PARITY check still drops the same population', () => {
  // t_99423c45's population must be unchanged: a surrogate-vs-judge pair is
  // dropped as MIXED INSTRUMENT, never as inverted -- even though this pair
  // is also inverted (0.75 < 0.90). The parity check runs FIRST, so the drop
  // is attributed to parity in both the pre-fix and post-fix code.
  //
  // This test passes BOTH before and after the fix: it is the regression
  // guard for AC 3 ("the parity check is unchanged and still drops the same
  // population").
  const rec = declareJudge(
    makeRecord({ chosen: 0.75, rejected: 0.90, hash: 'mixed-instrument' }),
    SAME_FAMILY
  );
  rec.chosen.prm_score_source = 'length_heuristic';
  rec.rejected.prm_score_source = 'prm_judge';
  const result = toDpoDataset([rec]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.mixedInstrument, 1, 'the parity population must be unchanged');
  assert.equal(result.skipped.lowGap, 0, 'parity must still take precedence');
});

test('dpo-dataset: the legacy heuristic-vs-judge signature is still dropped as mixed instrument', () => {
  // Both sides untagged: the exact legacy signature (chosen on a heuristic
  // bucket, rejected off it) is what t_99423c45 detects. Passes both before
  // and after the fix.
  const rec = makeRecord({ chosen: 0.75, rejected: 0.9, hash: 'legacy-signature' });
  const result = toDpoDataset([rec]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped.mixedInstrument, 1);
});

// -- AC 4: the filter path and the assembler path AGREE -------------------

for (const rule of ['min_score_gap', 'noop']) {
  test(`filter(${rule}) -> dpo-dataset: an inverted pair is dropped end-to-end`, () => {
    const rec = invertedRecord(`parity-${rule}`);
    const filtered = filterOutcomePairs([rec], { rule });
    const assembled = toDpoDataset(filtered.kept);

    // The two paths must agree: an inverted pair is not in the training set.
    // This is the load-bearing assertion -- before the fix the `noop` path
    // packaged the inverted pair.
    assert.equal(assembled.rows.length, 0, `the ${rule} path packaged an inverted pair`);

    // And the pair is dropped exactly once across the two paths, not zero
    // times and not twice.
    const droppedInFilter = filtered.dropped.length;
    const droppedInAssembler = assembled.skipped.inverted || 0;
    assert.equal(
      droppedInFilter + droppedInAssembler,
      1,
      `the ${rule} path must drop the inverted pair exactly once`
    );
  });
}

test('filter(min_score_gap): the inverted pair is dropped with an explicit reason', () => {
  const filtered = filterOutcomePairs([invertedRecord('reason-check')], { rule: 'min_score_gap' });
  assert.equal(filtered.kept.length, 0);
  assert.equal(filtered.dropped.length, 1);
  assert.match(filtered.dropped[0].reason, /^min_score_gap:inverted:-0\.6000<=0$/);
});

test('filter(noop) -> dpo-dataset: a NON-inverted pair still reaches the training set', () => {
  // The other half of the parity: the noop path must not become a
  // drop-everything path. Only INVERTED pairs are excluded by the assembler.
  // This test passes BOTH before and after the fix -- it is the control
  // proving the fix is narrow.
  const filtered = filterOutcomePairs([uprightRecord('noop-upright')], { rule: 'noop' });
  const assembled = toDpoDataset(filtered.kept);
  assert.equal(filtered.kept.length, 1);
  assert.equal(assembled.rows.length, 1);
});
