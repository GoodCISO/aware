// test/unit/trainer/judge-override-guard.test.js — kanban t_dc053dc2
//
// The per-call `prmConfig.model` override must not be able to make a judge
// GATE the DPO set, and the pair record must name the model that actually
// served the score.
//
// WHY THIS FILE EXISTS
// --------------------
// `options.prm.model` is the documented per-call judge model override. It
// travels into the generate options and every AWARE client honours
// `opts.model` over its own default — so the override really does decide
// which model served the score.
//
// The pair record's judge tags were computed from a DIFFERENT model: the
// override was honoured only when a `judgeClient` was configured. In the
// no-`judgeClient` branch — AWARE's PRODUCTION default, since a judge
// client is built only when `AWARE_JUDGE_MODEL` is set — the override
// changed the serving model while the record named the producer's model.
//
// Two consequences, both on the fields THIS REPO's trainer trusts:
//   * `prm_score_judge_model` was a false statement about which model
//     produced the score;
//   * the independence verdict was computed against the wrong model, so a
//     genuinely independent override was not recognised as independent.
//
// t_2a91cc4b fixed the COMPARISON (model family, not model id). This card
// fixes the BYPASS: the effective judge model is resolved once and used for
// the cache key, the score's `judge_model` and the pair record's judge tags.
//
// THE RULE
// --------
//   "Same family -> the verdict is a DIAGNOSTIC, never a launch gate."
//   (04-ai-product-evaluation.md:240-243)
//
// THE DECISION (AC4)
// -------------------
// DEMOTE THE VERDICT, DO NOT REFUSE THE CALL: the override is honoured for
// scoring, and a same-family effective judge is demoted to 'diagnostic' with
// `prm_score_independent=false` so it can never gate.
//
// Every assertion below is NON-VACUOUS: each names the artefact the sweep
// WOULD remove (the override that silently changes the serving model), so
// the suite fails against the pre-fix implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import path from 'node:path';

import { filterOutcomePairs } from '../../../src/trainer/outcome-filter.js';
import { mayJudgeGate, judgeDeclaration } from '../../../src/trainer/judge-role.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname), '../../..'
);

const CANDIDATE = 'MiniMax-M3.1-Flash';

/**
 * The vendored producer's heavy_think. AWARE ships this tree in the
 * coordinator image (`backend/heavy-think/src`), so it is the code that
 * actually produces the pairs this repo's trainer filters.
 */
async function loadHeavyThink() {
  const entry = path.join(REPO_ROOT, 'backend', 'heavy-think', 'src', 'index.js');
  return await import(entry);
}

function buildClient(name, { model, score = 8, refinedScore = 10 } = {}) {
  const calls = [];
  return {
    name,
    model,
    calls,
    async generate(prompt, opts) {
      calls.push({ opts: { ...(opts || {}) } });
      if (opts?.phase === 'prm_score') {
        // The refined trace must score HIGHER than the initial attempt, or
        // the pair's own gap is zero and the trainer drops it as inverted
        // before the judge-role gate is ever reached.
        const isRefined = JSON.stringify(prompt).includes('REFINED');
        return {
          reasoning: JSON.stringify({
            score: isRefined ? refinedScore : score,
            strengths: [],
            weaknesses: [],
          }),
          cost_usd: 0,
        };
      }
      if (opts?.phase === 'refine') {
        return { reasoning: 'REFINED: better answer', cost_usd: 0 };
      }
      return { reasoning: `${name} attempt`, cost_usd: 0 };
    },
  };
}

/** The model that actually served the PRM score. */
function servedModel(client) {
  const call = client.calls.find((c) => c.opts?.phase === 'prm_score');
  return call?.opts?.model || client.model;
}

/** Run the vendored heavy_think and return the written pair record. */
async function writePair({ override, role, judgeModel } = {}) {
  const { heavy_think } = await loadHeavyThink();
  const dir = await mkdtemp(join(tmpdir(), 'aware-override-'));
  const pairPath = join(dir, 'pairs.jsonl');
  const producer = buildClient('producer', { model: CANDIDATE });
  const judge = judgeModel ? buildClient('judge', { model: judgeModel }) : null;
  try {
    await heavy_think({
      problem: 'Q?',
      K: 1,
      task_type: 'standard',
      client: producer,
      judgeClient: judge,
      prm: {
        ...(override ? { model: override } : {}),
        ...(role ? { role } : {}),
      },
      preferencePairPath: pairPath,
    });
    const raw = (await readFile(pairPath, 'utf8')).trim();
    return { record: JSON.parse(raw.split('\n')[0]), producer, judge };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// === the record must name the model that actually served the score =======

test('override-guard: the pair record names the model that served the score', async () => {
  // THE defect: before the fix the record named the producer's model while
  // the override served a different one.
  const { record, producer } = await writePair({ override: 'qwen3-32b' });
  assert.equal(servedModel(producer), 'qwen3-32b', 'the override must reach the generate call');
  assert.equal(
    record.prm_score_judge_model,
    'qwen3-32b',
    'the pair record must name the model that actually served the score'
  );
});

test('override-guard: a sibling override is named on the record as the model that served', async () => {
  const { record, producer } = await writePair({ override: 'MiniMax-M3' });
  assert.equal(servedModel(producer), 'MiniMax-M3');
  assert.equal(record.prm_score_judge_model, 'MiniMax-M3');
});

// === AC1/AC2: a same-family judge may never gate ========================

test('override-guard: a same-family SIBLING override is a diagnostic, not a gate', async () => {
  const { record } = await writePair({ override: 'MiniMax-M3', role: 'launch_gate' });
  assert.equal(record.prm_score_independent, false);
  assert.equal(record.prm_score_role, 'diagnostic');
});

test('override-guard: the IDENTICAL model override is a diagnostic, not a gate (control)', async () => {
  const { record } = await writePair({ override: CANDIDATE, role: 'launch_gate' });
  assert.equal(record.prm_score_independent, false);
  assert.equal(record.prm_score_role, 'diagnostic');
});

// === AC3: a genuinely different family still gates =======================

test('override-guard: a DIFFERENT family override is still a launch gate', async () => {
  const { record } = await writePair({ override: 'qwen3-32b', role: 'launch_gate' });
  assert.equal(record.prm_score_independent, true);
  assert.equal(record.prm_score_role, 'launch_gate');
});

// === THE END-TO-END CONSEQUENCE: what the trainer does with the record ===

test('override-guard: a same-family override may NOT gate the DPO set', async () => {
  // The point of the whole contract: the trainer reads the RECORD, so the
  // record's declaration must keep the pair out of the gating path.
  const { record } = await writePair({ override: 'MiniMax-M3', role: 'launch_gate' });
  assert.equal(mayJudgeGate(record), false, 'a same-family judge may never gate');

  const result = filterOutcomePairs([record], { rule: 'min_score_gap' });
  // The gap magnitude is DEMOTED to a diagnostic, not gated on: the pair is
  // kept, but the verdict cannot certify it (04:240-243).
  assert.equal(result.kept.length, 1, 'the pair is kept, but as a diagnostic');
  assert.equal(result.dropped.length, 0);
  assert.equal(result.diagnostics.length, 1, 'the demoted gap is reported, not discarded');
  assert.match(result.diagnostics[0].reason, /min_score_gap:diagnostic/);
});

test('override-guard: a different-family override DOES gate the DPO set', async () => {
  // The fix is not a blanket ban: the override still works for what it is
  // for, and an independent judge still certifies the pair.
  const { record } = await writePair({ override: 'qwen3-32b', role: 'launch_gate' });
  assert.equal(mayJudgeGate(record), true, 'an independent judge may gate');

  const decl = judgeDeclaration(record);
  assert.equal(decl.independent, true);
  assert.equal(decl.role, 'launch_gate');
  assert.equal(decl.judgeModel, 'qwen3-32b');
});

// === the declaration must not CONTRADICT itself =========================

test('override-guard: the record carries one consistent declaration on both sides', async () => {
  const { record } = await writePair({ override: 'MiniMax-M3', role: 'launch_gate' });
  const decl = judgeDeclaration(record);
  assert.equal(decl.conflict, false, 'the record and its sides must agree');
  assert.equal(decl.declared, true);
  assert.equal(decl.independent, false);
  assert.equal(decl.role, 'diagnostic');
});
