// test/unit/coordinator/judge-served-model.test.js — kanban t_49d955b7
//
// The Ollama judge client must honour the per-call `prm.model` override,
// and must report WHICH MODEL ACTUALLY SERVED the call so the pair record
// cannot name a model that did not serve.
//
// WHY THIS FILE EXISTS
// --------------------
// The effective-judge-model fix (t_dc053dc2) resolved the override ONCE and
// asserted a strong invariant — "the record can no longer name a model that
// did not serve" — on the premise that "every AWARE client honours
// `opts.model` over its own default".
//
// That premise was FALSE for this client. `buildDefaultJudgeClient()`'s
// Ollama branch posted `judgeOllamaModel` on the wire and never read
// `genOpts.model`. The per-call override was silently ignored on THIS path,
// so the pair record named a model that did not serve.
//
// THE CONSEQUENCE (the dangerous half)
// -----------------------------------
// The misnamed judge is not merely a wrong label. AWARE's family rule
// demotes a SAME-FAMILY judge to `diagnostic` with
// `prm_score_independent=false` (04-ai-product-evaluation.md:240-243). A
// record that names the OVERRIDE instead of the SERVED model escapes that
// demotion entirely:
//
//   candidate      : MiniMax-M3.1-Flash   (family: minimax)
//   judge SERVED   : MiniMax-M2           (family: minimax)  <-- same family
//   record NAMES   : qwen3-32b            (family: qwen)     <-- different
//
// The record then declares `prm_score_independent=true` and
// `prm_score_role='launch_gate'` for a judge that is in the candidate's own
// model family — exactly the contradiction audit t_8f049433 found.
//
// NON-VACUITY
// -----------
// Every assertion below names the artefact the sweep WOULD remove: an
// Ollama judge that posts its own model whatever the override says. The
// suite fails against the pre-fix client.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDefaultJudgeClient } from '../../../src/coordinator/judge-client.js';

/**
 * Run a body with `globalThis.fetch` stubbed, recording what was POSTED.
 * Returns { posted, result }.
 */
async function withStubbedFetch(body) {
  const posted = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const payload = init && init.body ? JSON.parse(init.body) : null;
    posted.push({ url, model: payload && payload.model, payload });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return { response: JSON.stringify({ score: 8, strengths: [], weaknesses: [] }) };
      },
      async text() {
        return '';
      },
    };
  };
  try {
    return { posted, result: await body(posted) };
  } finally {
    globalThis.fetch = original;
  }
}

// === the Ollama judge honours the per-call override ====================

test('judge-served-model: the Ollama judge posts the per-call override, not its own model', async () => {
  const judge = await buildDefaultJudgeClient({
    judgeOllamaModel: 'MiniMax-M2',
    ollamaUrl: 'http://127.0.0.1:11434',
  });
  assert.ok(judge, 'an Ollama judge model must produce a judge client');

  const { posted } = await withStubbedFetch(async () => {
    await judge.generate('prompt', { phase: 'prm_score', model: 'qwen3-32b' });
  });

  assert.equal(posted.length, 1);
  assert.equal(
    posted[0].model,
    'qwen3-32b',
    'the override must reach the wire — the Ollama judge ignored it before the fix'
  );
});

test('judge-served-model: with no override the Ollama judge still posts its own model', async () => {
  const judge = await buildDefaultJudgeClient({
    judgeOllamaModel: 'MiniMax-M2',
    ollamaUrl: 'http://127.0.0.1:11434',
  });

  const { posted } = await withStubbedFetch(async () => {
    await judge.generate('prompt', { phase: 'prm_score' });
  });

  assert.equal(posted[0].model, 'MiniMax-M2');
});

// === the client reports the model it SERVED ============================

test('judge-served-model: the Ollama judge reports the model it served', async () => {
  const judge = await buildDefaultJudgeClient({
    judgeOllamaModel: 'MiniMax-M2',
    ollamaUrl: 'http://127.0.0.1:11434',
  });

  const { result } = await withStubbedFetch(async () => {
    return await judge.generate('prompt', { phase: 'prm_score', model: 'qwen3-32b' });
  });

  assert.equal(
    result.served_model,
    'qwen3-32b',
    'the client must report what it put on the wire'
  );
});

test('judge-served-model: the Ollama judge resolves the served model BEFORE the call', async () => {
  // The PRM cache key is computed before any score exists, so it needs the
  // pre-call half of the served-model contract.
  const judge = await buildDefaultJudgeClient({
    judgeOllamaModel: 'MiniMax-M2',
    ollamaUrl: 'http://127.0.0.1:11434',
  });

  assert.equal(typeof judge.resolveServedModel, 'function');
  assert.equal(judge.resolveServedModel({ model: 'qwen3-32b' }), 'qwen3-32b');
  assert.equal(judge.resolveServedModel({}), 'MiniMax-M2');
  assert.equal(judge.resolveServedModel({ model: '   ' }), 'MiniMax-M2');
});

// === the provider judge path keeps its behaviour =======================

test('judge-served-model: the provider judge still honours the override and reports it', async () => {
  const judge = await buildDefaultJudgeClient({
    judgeModel: 'gpt-5-judge',
    makeProviderClient: (opts) => ({
      model: opts.model,
      async generate(_prompt, genOpts) {
        return {
          reasoning: '{"score": 9}',
          cost_usd: 0,
          // The underlying client reports what it served.
          served_model: genOpts.model || opts.model,
        };
      },
    }),
  });
  assert.ok(judge);

  const res = await judge.generate('prompt', { phase: 'prm_score', model: 'qwen3-32b' });
  assert.equal(res.served_model, 'qwen3-32b');
  assert.equal(judge.resolveServedModel({ model: 'qwen3-32b' }), 'qwen3-32b');
  assert.equal(judge.resolveServedModel({}), 'gpt-5-judge');
});

test('judge-served-model: the provider judge reports a served model even when the client does not', async () => {
  // A provider client that does NOT report a served model: the wrapper
  // falls back to what it knows it asked for.
  const judge = await buildDefaultJudgeClient({
    judgeModel: 'gpt-5-judge',
    makeProviderClient: (opts) => ({
      model: opts.model,
      async generate() {
        return { reasoning: '{"score": 9}', cost_usd: 0 };
      },
    }),
  });

  const res = await judge.generate('prompt', { phase: 'prm_score', model: 'qwen3-32b' });
  assert.equal(res.served_model, 'qwen3-32b');

  const res2 = await judge.generate('prompt', { phase: 'prm_score' });
  assert.equal(res2.served_model, 'gpt-5-judge');
});
