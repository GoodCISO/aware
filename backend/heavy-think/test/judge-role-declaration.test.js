// test/judge-role-declaration.test.js
//
// Regression test for kanban t_155a95a1.
//
// The DPO gate was decided by a PRM judge that shared the producer's client
// (same family) while carrying NO declared role. Every preference pair must
// now declare:
//   - the ROLE of the judge verdict (launch_gate / diagnostic / guardrail)
//   - whether the judge was INDEPENDENT of the candidate
//   - which model served the judge
//
// and a same-family judge must be a DIAGNOSTIC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { heavy_think } from '../src/index.js';

function buildClient({ model = 'mock-model-1', refinedJudgeScore = 10, initialJudgeScore = 8 } = {}) {
  return {
    model,
    async generate(prompt, opts) {
      if (opts?.phase === 'prm_score') {
        const isRefined = JSON.stringify(prompt).includes('REFINED');
        const score = isRefined ? refinedJudgeScore : initialJudgeScore;
        return { reasoning: JSON.stringify({ score, strengths: ['ok'], weaknesses: [] }), cost_usd: 0 };
      }
      if (opts?.phase === 'refine') {
        return { reasoning: 'REFINED: better answer', cost_usd: 0 };
      }
      return { reasoning: 'raw attempt', cost_usd: 0 };
    },
  };
}

async function writePair(client, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ht-judge-role-'));
  const pairPath = join(dir, 'pairs.jsonl');
  try {
    await heavy_think({
      problem: 'Q?',
      K: 1,
      task_type: 'standard',
      client,
      preferencePairPath: pairPath,
      ...opts,
    });
    const raw = (await readFile(pairPath, 'utf8')).trim();
    return JSON.parse(raw.split('\n')[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('judge-role: every pair declares the judge role, independence and judge model', async () => {
  const rec = await writePair(buildClient({ model: 'MiniMax-M3.1-Flash' }));
  assert.equal(rec.prm_score_role, 'diagnostic');
  assert.equal(rec.prm_score_independent, false);
  assert.equal(rec.prm_score_judge_model, 'MiniMax-M3.1-Flash');
  // Both sides carry the same declaration.
  assert.equal(rec.chosen.prm_score_role, 'diagnostic');
  assert.equal(rec.chosen.prm_score_independent, false);
  assert.equal(rec.chosen.prm_score_judge_model, 'MiniMax-M3.1-Flash');
  assert.equal(rec.rejected.prm_score_role, 'diagnostic');
  assert.equal(rec.rejected.prm_score_independent, false);
  assert.equal(rec.rejected.prm_score_judge_model, 'MiniMax-M3.1-Flash');
});

test('judge-role: a same-family judge is diagnostic even when a gate role is requested', async () => {
  const rec = await writePair(buildClient({ model: 'MiniMax-M3.1-Flash' }), {
    prm: { role: 'launch_gate' },
  });
  assert.equal(rec.prm_score_role, 'diagnostic');
  assert.equal(rec.prm_score_independent, false);
});

test('judge-role: a separate judge client of another family IS independent', async () => {
  const candidate = buildClient({ model: 'MiniMax-M3.1-Flash' });
  const judge = buildClient({ model: 'claude-opus-4' });
  const rec = await writePair(candidate, { judgeClient: judge, prm: { role: 'launch_gate' } });
  assert.equal(rec.prm_score_independent, true);
  assert.equal(rec.prm_score_role, 'launch_gate');
  assert.equal(rec.prm_score_judge_model, 'claude-opus-4');
});

test('judge-role: an independent judge with no requested role stays diagnostic', async () => {
  const candidate = buildClient({ model: 'MiniMax-M3.1-Flash' });
  const judge = buildClient({ model: 'claude-opus-4' });
  const rec = await writePair(candidate, { judgeClient: judge });
  assert.equal(rec.prm_score_independent, true);
  assert.equal(rec.prm_score_role, 'diagnostic');
});
