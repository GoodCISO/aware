// test/unit/trainer/judge-role.test.js — the judge-role contract (kanban t_155a95a1)
//
// The DPO gate was decided by a PRM judge that shared the producer's client,
// so it was same-family by construction — while being wired into a GATE
// position, with no role declared anywhere. The rule being enforced:
//
//   "Same family -> the verdict is a DIAGNOSTIC, never a launch gate."
//   (measurement-experimentation-ops/references/04-ai-product-evaluation.md:187-190)
//   "Write the role on the eval ticket BEFORE the eval runs. If you cannot
//    name which of the three it is, it is a diagnostic." (04:35-36)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JUDGE_ROLES,
  DEFAULT_JUDGE_ROLE,
  GATING_JUDGE_ROLES,
  isJudgeRole,
  judgeDeclaration,
  mayJudgeGate,
} from '../../../src/trainer/judge-role.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AWARE_ROOT = path.resolve(HERE, '..', '..', '..');
const PRODUCER_MODULE = path.join(
  AWARE_ROOT, 'backend', 'heavy-think', 'src', 'judge-role.js'
);

// -- The vocabulary --------------------------------------------------------

test('judge-role: the role vocabulary is exactly launch_gate / diagnostic / guardrail', () => {
  assert.deepEqual([...JUDGE_ROLES].sort(), [
    'diagnostic', 'guardrail', 'launch_gate',
  ]);
  assert.equal(DEFAULT_JUDGE_ROLE, 'diagnostic');
  // A diagnostic never gates; the other two may.
  assert.deepEqual([...GATING_JUDGE_ROLES].sort(), ['guardrail', 'launch_gate']);
  assert.ok(!GATING_JUDGE_ROLES.includes('diagnostic'));
});

test('judge-role: isJudgeRole accepts only the three declared roles', () => {
  for (const r of JUDGE_ROLES) assert.equal(isJudgeRole(r), true);
  for (const r of ['Launch Gate', 'LAUNCH_GATE', 'screening', '', null, undefined, 7]) {
    assert.equal(isJudgeRole(r), false, `${r} must not be a declared role`);
  }
});

// -- judgeDeclaration ------------------------------------------------------

test('judge-role: judgeDeclaration reads the declaration off the record and both sides', () => {
  const rec = {
    prm_score_role: 'diagnostic',
    prm_score_independent: false,
    prm_score_judge_model: 'MiniMax-M3.1-Flash',
    chosen: { prm_score_role: 'diagnostic', prm_score_independent: false },
    rejected: { prm_score_role: 'diagnostic', prm_score_independent: false },
  };
  const decl = judgeDeclaration(rec);
  assert.equal(decl.role, 'diagnostic');
  assert.equal(decl.independent, false);
  assert.equal(decl.judgeModel, 'MiniMax-M3.1-Flash');
  assert.equal(decl.declared, true);
  assert.equal(decl.conflict, false);
});

test('judge-role: a record with NO declaration is undeclared, not "independent"', () => {
  const decl = judgeDeclaration({ chosen: {}, rejected: {} });
  assert.equal(decl.declared, false);
  assert.equal(decl.independent, null);
  assert.equal(decl.role, null);
});

test('judge-role: a CONTRADICTORY declaration is treated as undeclared', () => {
  // The record says one thing and its side says another. A contradiction
  // about who judged the pair is not evidence that the judge could gate.
  const decl = judgeDeclaration({
    prm_score_role: 'launch_gate',
    prm_score_independent: true,
    chosen: { prm_score_role: 'diagnostic', prm_score_independent: false },
    rejected: { prm_score_role: 'diagnostic', prm_score_independent: false },
  });
  assert.equal(decl.conflict, true);
  assert.equal(decl.declared, false);
  assert.equal(mayJudgeGate({ prm_score_role: 'launch_gate', prm_score_independent: true }), true);
  assert.equal(mayJudgeGate({
    prm_score_role: 'launch_gate',
    prm_score_independent: true,
    chosen: { prm_score_role: 'diagnostic', prm_score_independent: false },
  }), false);
});

// -- mayJudgeGate ----------------------------------------------------------

test('judge-role: an independent judge with a gating role MAY gate', () => {
  assert.equal(mayJudgeGate({
    prm_score_role: 'launch_gate',
    prm_score_independent: true,
    prm_score_judge_model: 'judge-model-x',
  }), true);
  assert.equal(mayJudgeGate({
    prm_score_role: 'guardrail',
    prm_score_independent: true,
    prm_score_judge_model: 'judge-model-x',
  }), true);
});

test('judge-role: a SAME-FAMILY judge may NEVER gate, whatever role it claims', () => {
  // The load-bearing assertion of this card. Same family => diagnostic.
  for (const role of ['launch_gate', 'diagnostic', 'guardrail']) {
    assert.equal(mayJudgeGate({
      prm_score_role: role,
      prm_score_independent: false,
      prm_score_judge_model: 'MiniMax-M3.1-Flash',
    }), false, `same-family judge claiming '${role}' must not gate`);
  }
});

test('judge-role: an independent judge with a DIAGNOSTIC role may not gate', () => {
  // Independence is NECESSARY for a gate, not SUFFICIENT.
  assert.equal(mayJudgeGate({
    prm_score_role: 'diagnostic',
    prm_score_independent: true,
    prm_score_judge_model: 'judge-model-x',
  }), false);
});

test('judge-role: an undeclared judge may not gate', () => {
  assert.equal(mayJudgeGate({}), false);
  assert.equal(mayJudgeGate({ chosen: { prm_score: 0.9 }, rejected: { prm_score: 0.1 } }), false);
});

// -- The producer mirror must not drift -----------------------------------

test('judge-role: the AWARE-side mirror matches the producer module', async (t) => {
  if (!fs.existsSync(PRODUCER_MODULE)) {
    t.skip('the vendored producer copy is not present in this tree');
    return;
  }
  const producer = await import(PRODUCER_MODULE);
  assert.deepEqual(
    [...producer.JUDGE_ROLES].sort(),
    [...JUDGE_ROLES].sort(),
    'the role vocabulary has drifted from the producer module'
  );
  assert.equal(
    producer.DEFAULT_JUDGE_ROLE,
    DEFAULT_JUDGE_ROLE,
    'the default role has drifted from the producer module'
  );
  assert.deepEqual(
    [...producer.GATING_JUDGE_ROLES].sort(),
    [...GATING_JUDGE_ROLES].sort(),
    'the gating-role set has drifted from the producer module'
  );
});
