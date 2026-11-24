// test/unit/trainer/judge-served-model.test.js — kanban t_49d955b7
//
// The END-TO-END consequence of the served-model fix, on the AWARE side:
// a judge client that ignores the per-call `prm.model` override must not be
// able to slip a same-family judge into a GATING position.
//
// WHY THIS FILE EXISTS
// --------------------
// The card's headline AC is the VERDICT half, not the record-naming half:
// fixing only `prm_score_judge_model` would leave the false
// `prm_score_independent=true` / `prm_score_role='launch_gate'` in place.
//
// The mechanism: AWARE's family rule demotes a SAME-FAMILY judge to
// `diagnostic` with `prm_score_independent=false`
// (04-ai-product-evaluation.md:240-243). That demotion is computed from
// the model the RECORD NAMES. So a record that names the OVERRIDE instead
// of the SERVED model escapes the demotion entirely.
//
//   candidate      : MiniMax-M3.1-Flash   (family: minimax)
//   judge SERVED   : MiniMax-M2           (family: minimax)  <-- same family
//   record NAMES   : qwen3-32b            (family: qwen)     <-- different
//
// The trainer gates on `mayJudgeGate(rec)`, which requires
// `prm_score_independent === true` AND a gating role. So the misnamed
// judge would be admitted to the gating path.
//
// THIS FILE drives the REAL vendored heavy_think with a judge client that
// IGNORES `opts.model` — the shape AWARE's Ollama judge client had — and
// asserts the record and the trainer's verdict both follow the SERVED
// model.
//
// NON-VACUITY
// -----------
// The assertions name the artefact the sweep WOULD remove (a judge that
// ignores the override yet is named on the record as the override). The
// suite fails against the pre-fix tree.

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

/**
 * A judge client that IGNORES `opts.model` — the shape AWARE's Ollama judge
 * client had before t_49d955b7. It serves its OWN model whatever the caller
 * asks for, and reports what it served under `served_model`.
 */
function buildIgnoringJudgeClient(name, { model, score = 8, refinedScore = 10 } = {}) {
  const calls = [];
  return {
    name,
    model,
    calls,
    resolveServedModel() {
      return model;
    },
    async generate(prompt, opts = {}) {
      calls.push({ opts: { ...(opts || {}) } });
      if (opts?.phase === 'prm_score') {
        const isRefined = JSON.stringify(prompt).includes('REFINED');
        return {
          reasoning: JSON.stringify({
            score: isRefined ? refinedScore : score,
            strengths: [],
            weaknesses: [],
          }),
          cost_usd: 0,
          served_model: model,
        };
      }
      if (opts?.phase === 'refine') {
        return { reasoning: 'REFINED: better answer', cost_usd: 0 };
      }
      return { reasoning: `${name} attempt`, cost_usd: 0 };
    },
  };
}

/** A client that honours `opts.model` (the provider-client shape). */
function buildHonouringClient(name, { model, score = 8, refinedScore = 10 } = {}) {
  const calls = [];
  return {
    name,
    model,
    calls,
    resolveServedModel(genOpts = {}) {
      return genOpts.model || model;
    },
    async generate(prompt, opts = {}) {
      calls.push({ opts: { ...(opts || {}) } });
      const served = opts.model || model;
      if (opts?.phase === 'prm_score') {
        const isRefined = JSON.stringify(prompt).includes('REFINED');
        return {
          reasoning: JSON.stringify({
            score: isRefined ? refinedScore : score,
            strengths: [],
            weaknesses: [],
          }),
          cost_usd: 0,
          served_model: served,
        };
      }
      if (opts?.phase === 'refine') {
        return { reasoning: 'REFINED: better answer', cost_usd: 0 };
      }
      return { reasoning: `${name} attempt`, cost_usd: 0 };
    },
  };
}

/** Run the vendored heavy_think and return the written pair record. */
async function writePair({ override, role, judge } = {}) {
  const { heavy_think } = await loadHeavyThink();
  const dir = await mkdtemp(join(tmpdir(), 'aware-served-'));
  const pairPath = join(dir, 'pairs.jsonl');
  const producer = buildHonouringClient('producer', { model: CANDIDATE });
  try {
    await heavy_think({
      problem: 'Q?',
      K: 1,
      task_type: 'standard',
      client: producer,
      judgeClient: judge || null,
      prm: {
        ...(override ? { model: override } : {}),
        ...(role ? { role } : {}),
      },
      preferencePairPath: pairPath,
    });
    const raw = (await readFile(pairPath, 'utf8')).trim();
    return { record: JSON.parse(raw.split('\n')[0]), producer };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// === AC1: the record names the model that ACTUALLY served ==============

test('served-model: a judge that ignores the override is named as the model that served', async () => {
  const judge = buildIgnoringJudgeClient('judge', { model: 'MiniMax-M2' });
  const { record } = await writePair({ override: 'qwen3-32b', judge });

  assert.equal(
    record.prm_score_judge_model,
    'MiniMax-M2',
    'the pair record must name the model that actually served the score'
  );
  assert.notEqual(
    record.prm_score_judge_model,
    'qwen3-32b',
    'the record must NOT name the requested model when the judge ignored it'
  );
});

// === AC2: the same-family judge may NOT gate ===========================

test('served-model: a same-family judge that ignored the override is a diagnostic, not a gate', async () => {
  // The judge SERVES MiniMax-M2 (family: minimax, same as the candidate
  // MiniMax-M3.1-Flash). The override names qwen3-32b (family: qwen).
  const judge = buildIgnoringJudgeClient('judge', { model: 'MiniMax-M2' });
  const { record } = await writePair({ override: 'qwen3-32b', role: 'launch_gate', judge });

  assert.equal(record.prm_score_independent, false, 'a same-family judge is never independent');
  assert.equal(record.prm_score_role, 'diagnostic', 'a same-family judge never gates');
});

test('served-model: a same-family judge that ignored the override may NOT gate the DPO set', async () => {
  // The point of the whole contract: the trainer reads the RECORD, so the
  // record's declaration must keep the pair out of the gating path.
  const judge = buildIgnoringJudgeClient('judge', { model: 'MiniMax-M2' });
  const { record } = await writePair({ override: 'qwen3-32b', role: 'launch_gate', judge });

  assert.equal(mayJudgeGate(record), false, 'a same-family judge may never gate');

  const result = filterOutcomePairs([record], { rule: 'min_score_gap' });
  assert.equal(result.kept.length, 1, 'the pair is kept, but as a diagnostic');
  assert.equal(result.dropped.length, 0);
  assert.equal(result.diagnostics.length, 1, 'the demoted gap is reported, not discarded');
  assert.match(result.diagnostics[0].reason, /min_score_gap:diagnostic/);
});

// === AC3: the fix is not a blanket ban =================================

test('served-model: a served judge in ANOTHER family still gates', async () => {
  // The judge serves qwen3-32b — a different family from the candidate —
  // so the record may gate, exactly as before the fix.
  const judge = buildIgnoringJudgeClient('judge', { model: 'qwen3-32b' });
  const { record } = await writePair({ override: 'MiniMax-M2', role: 'launch_gate', judge });

  assert.equal(record.prm_score_independent, true);
  assert.equal(record.prm_score_role, 'launch_gate');
  assert.equal(record.prm_score_judge_model, 'qwen3-32b');
  assert.equal(mayJudgeGate(record), true, 'an independent judge may gate');
});

test('served-model: a judge that HONOURS the override still gates on the override', async () => {
  // The provider path keeps its current behaviour (AC3 of the card).
  const judge = buildHonouringClient('judge', { model: 'MiniMax-M2' });
  const { record } = await writePair({ override: 'qwen3-32b', role: 'launch_gate', judge });

  assert.equal(record.prm_score_judge_model, 'qwen3-32b');
  assert.equal(record.prm_score_independent, true);
  assert.equal(record.prm_score_role, 'launch_gate');
});

// === the declaration must not CONTRADICT itself ========================

test('served-model: the record carries one consistent declaration on both sides', async () => {
  const judge = buildIgnoringJudgeClient('judge', { model: 'MiniMax-M2' });
  const { record } = await writePair({ override: 'qwen3-32b', role: 'launch_gate', judge });

  const decl = judgeDeclaration(record);
  assert.equal(decl.conflict, false, 'the record and its sides must agree');
  assert.equal(decl.declared, true);
  assert.equal(decl.independent, false);
  assert.equal(decl.role, 'diagnostic');
  assert.equal(decl.judgeModel, 'MiniMax-M2', 'the declaration names the served model');
});
