// test/unit/coordinator/judge-client.test.js
//
// The coordinator must build an INDEPENDENT judge client from the operator's
// judge settings, and the pipeline must route every judge call to it
// (kanban t_89720a07).
//
// The judge is a DIRECT client, never a router: a router could fall back to
// the producer's backend, and a silent fallback to the candidate's family
// reintroduces exactly the defect this card exists to remove.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDefaultJudgeClient } from '../../../src/coordinator/judge-client.js';

test('buildDefaultJudgeClient returns null when no judge is configured', async () => {
  const judge = await buildDefaultJudgeClient({ judgeModel: '', judgeOllamaModel: '' });
  assert.equal(judge, null, 'no judge configured must mean no judge client, not a fallback');
});

test('buildDefaultJudgeClient builds a provider judge from the judge model + key', async () => {
  let builtWith = null;
  const judge = await buildDefaultJudgeClient({
    judgeModel: 'gpt-5-judge',
    judgeApiKey: 'judge-key',
    judgeApiHost: 'https://judge.example/anthropic',
    makeProviderClient: (opts) => {
      builtWith = opts;
      return {
        model: opts.model,
        async generate() { return { reasoning: '{"score": 9}', cost_usd: 0 }; },
      };
    },
  });
  assert.ok(judge, 'a configured judge model must produce a judge client');
  assert.equal(judge.model, 'gpt-5-judge');
  assert.equal(judge.name, 'judge');
  assert.equal(builtWith.model, 'gpt-5-judge');
  assert.equal(builtWith.apiKey, 'judge-key');
  assert.equal(builtWith.baseUrl, 'https://judge.example/anthropic');
});

test('buildDefaultJudgeClient judge carries its own model on the client', async () => {
  const judge = await buildDefaultJudgeClient({
    judgeModel: 'gpt-5-judge',
    makeProviderClient: (opts) => ({
      model: opts.model,
      async generate() { return { reasoning: 'ok', cost_usd: 0 }; },
    }),
  });
  const res = await judge.generate('prompt', { phase: 'prm_score' });
  assert.equal(res.reasoning, 'ok');
  assert.equal(judge.model, 'gpt-5-judge');
});

test('buildDefaultJudgeClient builds an Ollama judge from AWARE_JUDGE_OLLAMA_MODEL', async () => {
  const judge = await buildDefaultJudgeClient({
    judgeOllamaModel: 'qwen2.5:7b',
    ollamaUrl: 'http://127.0.0.1:11434',
  });
  assert.ok(judge);
  assert.equal(judge.model, 'qwen2.5:7b');
  assert.equal(judge.name, 'judge-ollama');
  assert.equal(judge.offline, true);
});
