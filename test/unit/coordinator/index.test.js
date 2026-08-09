// test/unit/coordinator/index.test.js — coordinator entry point + buildDefaultRouter
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  coordinate,
  COORDINATOR_VERSION,
  COORDINATOR_BUILD_PHASE,
  buildDefaultRouter,
  buildDefaultOllamaClient,
} from '../../../src/coordinator/index.js';

test('buildDefaultRouter accepts opts.rlPipelinePath (used by tests + Docker image)', async () => {
  // Absolute path to the actual rl-pipeline source (sibling repo at $REPO_PARENT/rl-pipeline/)
  // From test/unit/coordinator/, 4 `..` lands at $REPO_PARENT, then rl-pipeline/...
  const rlPipelineAbs = new URL('../../../../rl-pipeline/src/index.js', import.meta.url).pathname;
  const router = await buildDefaultRouter({
    rlPipelinePath: rlPipelineAbs,
    mode: 'online',
    providerClient: { name: 'the provider', generate: async () => ({ reasoning: 'r' }) },
    ollamaClient: { name: 'ollama', offline: true, generate: async () => ({ reasoning: 'r' }) },
  });
  const r = await router.generate('test');
  assert.equal(r.reasoning, 'r');
});

test('buildDefaultRouter honors AWARE_RL_PIPELINE_PATH env var', async () => {
  const prev = process.env.AWARE_RL_PIPELINE_PATH;
  process.env.AWARE_RL_PIPELINE_PATH = new URL('../../../../rl-pipeline/src/index.js', import.meta.url).pathname;
  try {
    const router = await buildDefaultRouter({
      mode: 'online',
      providerClient: { name: 'the provider', generate: async () => ({ reasoning: 'env-path' }) },
    });
    const r = await router.generate('test');
    assert.equal(r.reasoning, 'env-path');
  } finally {
    if (prev === undefined) delete process.env.AWARE_RL_PIPELINE_PATH;
    else process.env.AWARE_RL_PIPELINE_PATH = prev;
  }
});

test('buildDefaultRouter errors loudly if rl-pipeline path cannot be resolved', async () => {
  // Both injection and env point at a missing file
  const prev = process.env.AWARE_RL_PIPELINE_PATH;
  process.env.AWARE_RL_PIPELINE_PATH = '/nonexistent/rl-pipeline/src/index.js';
  try {
    await assert.rejects(
      () =>
        buildDefaultRouter({
          mode: 'online',
          providerClient: { name: 'the provider', generate: async () => ({}) },
        }),
      /Cannot find module|Cannot load|ENOENT/,
    );
  } finally {
    if (prev === undefined) delete process.env.AWARE_RL_PIPELINE_PATH;
    else process.env.AWARE_RL_PIPELINE_PATH = prev;
  }
});

test('COORDINATOR_VERSION and COORDINATOR_BUILD_PHASE are exposed and reflect Phase 1 progress', () => {
  // Phase 1 passthrough (ADR (internal)) closes the two open items from
  // commit 301f672d: passthrough wrap (gateway proxy body-handling)
  // and api.pluginConfig plumbing. The version reflects the bump.
  assert.equal(COORDINATOR_VERSION, '0.3.0-phase-1-pluginconfig');
  assert.equal(COORDINATOR_BUILD_PHASE, 'phase-1-passthrough');
});

test('coordinate() returns a result envelope (delegates to awareRlPipeline)', async () => {
  const result = await coordinate({
    problem: 'p',
    K: 1,
    task_type: 'simple',
    client: {
      async generate() { return { reasoning: 'r' }; },
    },
  });
  assert.equal(result.ok, true);
});

test('buildDefaultRouter in hybrid mode includes both clients', async () => {
  const router = await buildDefaultRouter({
    mode: 'hybrid',
    providerClient: { name: 'the provider-stub', generate: async () => ({ reasoning: 'm' }) },
    ollamaClient: { name: 'ollama-stub', offline: true, generate: async () => ({ reasoning: 'o' }) },
  });
  // Probe a generate; primary should win
  const result = await router.generate('hi');
  assert.equal(result._routed_via, 'the provider-stub');
  assert.equal(result.reasoning, 'm');
});

test('buildDefaultRouter in offline mode excludes the online client', async () => {
  const router = await buildDefaultRouter({
    mode: 'offline',
    providerClient: { name: 'the provider-stub', generate: async () => ({ reasoning: 'm' }) },
    ollamaClient: { name: 'ollama-stub', offline: true, generate: async () => ({ reasoning: 'o' }) },
  });
  const result = await router.generate('hi');
  assert.equal(result._routed_via, 'ollama-stub');
});

test('buildDefaultRouter in online mode excludes the offline client', async () => {
  const router = await buildDefaultRouter({
    mode: 'online',
    providerClient: { name: 'the provider-stub', generate: async () => ({ reasoning: 'm' }) },
    ollamaClient: { name: 'ollama-stub', offline: true, generate: async () => ({ reasoning: 'o' }) },
  });
  const result = await router.generate('hi');
  assert.equal(result._routed_via, 'the provider-stub');
});

test('buildDefaultRouter falls back from the provider to ollama in hybrid mode', async () => {
  const router = await buildDefaultRouter({
    mode: 'hybrid',
    providerClient: { name: 'the provider', generate: async () => { throw new Error('502 from the provider'); } },
    ollamaClient: { name: 'ollama', offline: true, generate: async () => ({ reasoning: 'from ollama' }) },
  });
  const result = await router.generate('hi');
  assert.equal(result._routed_via, 'ollama');
  assert.equal(result.reasoning, 'from ollama');
});

test('buildDefaultRouter without env var or opts: the provider stub fails, ollama stub works', async () => {
  // No env, no opts → default the provider stub throws "no API key",
  // default ollama stub hits a port that's not listening
  // → both fail → router throws
  // Use a custom ollama client to avoid the real port issue
  const router = await buildDefaultRouter({
    mode: 'hybrid',
    ollamaClient: { name: 'ollama', offline: true, generate: async () => ({ reasoning: 'fallback' }) },
  });
  // Save and clear env var to ensure the provider stub is used
  const saved = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  try {
    const result = await router.generate('hi');
    // The the provider stub throws, ollama stub succeeds
    assert.equal(result._routed_via, 'ollama');
    assert.equal(result.reasoning, 'fallback');
  } finally {
    if (saved !== undefined) process.env.LLM_API_KEY = saved;
  }
});

// === buildDefaultOllamaClient against a real local HTTP server ===

test('buildDefaultOllamaClient hits /api/generate and returns response field', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // Verify Ollama's expected request shape
      const parsed = JSON.parse(body);
      assert.ok(parsed.model, 'Ollama request should have a model field');
      assert.ok(parsed.prompt, 'Ollama request should have a prompt field');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'hello from ollama' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = buildDefaultOllamaClient(`http://127.0.0.1:${port}`);
    const result = await client.generate('test prompt', { model: 'qwen2.5:7b' });
    assert.equal(result.reasoning, 'hello from ollama');
    assert.equal(result.cost_usd, 0);  // local inference
  } finally {
    server.close();
  }
});

// === t_aa407e5e (2026-07-12): AWARE-flavored qwen3.5 + think-mode preamble ===
//
// The architect (t_aa407e5e) proved two production facts that this file now
// encodes as tests:
//   1. The default model in buildDefaultOllamaClient is `aware-qwen35-9b:latest`,
//      not the generic `qwen2.5:7b` baseline. Same Ollama daemon hosts the
//      AWARE-LoRA-merged Q4_K_M build under that name.
//   2. qwen3.5 emits a `Thinking Process:` preamble by default on Ollama 0.31.x.
//      `num_think` and Modelfile `PARAMETER think` don't apply; only the
//      per-request `think: false` body field does. The downstream coordinator
//      pair-generator expects a clean `reasoning` field, so the default must
//      include `think: false`.

test('buildDefaultOllamaClient defaults model to aware-qwen35-9b:latest (AWARE-LoRA merged)', async () => {
  // No opts.model → production default should resolve to the AWARE-flavored model.
  let captured;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'ok' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = buildDefaultOllamaClient(`http://127.0.0.1:${port}`);
    await client.generate('ping');
    assert.equal(captured.model, 'aware-qwen35-9b:latest',
      'default model must be the AWARE-flavored qwen3.5-9b, not qwen2.5:7b');
  } finally {
    server.close();
  }
});

test('buildDefaultOllamaClient sends think:false by default to suppress qwen3.5 preamble', async () => {
  // Without think:false, qwen3.5 on Ollama 0.31.x returns a 74-char
  // "Thinking Process:" preamble instead of the answer. The coordinator's
  // pair-generator feeds `reasoning` directly into the downstream prompt,
  // so the preamble would leak. Verify the body always carries think:false
  // unless the caller explicitly opts in via opts.think.
  let captured;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'ok' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = buildDefaultOllamaClient(`http://127.0.0.1:${port}`);
    await client.generate('ping');
    assert.equal(captured.think, false,
      'think must default to false so qwen3.5 does not emit Thinking Process: preamble');
  } finally {
    server.close();
  }
});

test('buildDefaultOllamaClient forwards opts.think=true to enable thinking-mode (opt-in only)', async () => {
  // Escape hatch: callers who want the preamble (e.g. for PRM scoring) can
  // explicitly enable thinking via opts.think. Verified so we don't accidentally
  // hardcode think:false and break PRM integration later.
  let captured;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'ok' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = buildDefaultOllamaClient(`http://127.0.0.1:${port}`);
    await client.generate('ping', { think: true });
    assert.equal(captured.think, true,
      'opts.think=true must round-trip to the Ollama body so PRM-style callers can opt in');
  } finally {
    server.close();
  }
});

test('buildDefaultOllamaClient still allows opts.model override for legacy callers', async () => {
  // The legacy `model: 'qwen2.5:7b'` path must still work — some smoke
  // tests and old fixtures pin that model name explicitly.
  let captured;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'ok' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = buildDefaultOllamaClient(`http://127.0.0.1:${port}`);
    await client.generate('ping', { model: 'qwen2.5:7b' });
    assert.equal(captured.model, 'qwen2.5:7b',
      'opts.model must override the default to preserve legacy callers');
  } finally {
    server.close();
  }
});

test('buildDefaultOllamaClient throws on non-2xx with error body included', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal ollama failure');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = buildDefaultOllamaClient(`http://127.0.0.1:${port}`);
    await assert.rejects(
      client.generate('test'),
      /Ollama API 500.*internal ollama failure/
    );
  } finally {
    server.close();
  }
});
