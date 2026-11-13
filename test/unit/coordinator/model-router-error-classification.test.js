// test/unit/coordinator/model-router-error-classification.test.js
//
// Regression cover for t_4af66f5f: the model router dropped the structured
// error identity (`err.code` / `err.statusCode`) of a failed backend when it
// aggregated the per-backend failures into a single Error. The provider
// client (rl-pipeline's clients/minimax.js) sets
//   err.code = 'upstream_rate_limited'; err.statusCode = 429;
// on an upstream HTTP 429, but the aggregate carried neither, so
// `classifyError()` (rl-pipeline-bridge-integration.js) fell through to its
// message regex and recorded every provider 429 as 'upstream_error'.
//
// The 'upstream_rate_limited' branch of the classifier was therefore
// unreachable in production: 0 rows in aware_conversations carried that
// error_kind across the table's whole history.
//
// These tests exercise the REAL classifier — not a re-implementation — so a
// fix that only moves the code around without reaching classifyError() still
// fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { makeModelRouter } from '../../../src/coordinator/model-router.js';
import { classifyError, awareRlPipeline, __resetRlPipelineForTest } from '../../../src/coordinator/rl-pipeline-bridge-integration.js';

// A backend that fails the way rl-pipeline's minimax client fails on an
// upstream HTTP 429: a plain Error with `code` and `statusCode` attached.
function rateLimitedBackend(message = 'minimax API 429 rate limited: quota exhausted') {
  return {
    name: 'provider',
    async generate() {
      const err = new Error(message);
      err.code = 'upstream_rate_limited';
      err.statusCode = 429;
      throw err;
    },
  };
}

// A backend that fails for a NON-rate-limit reason: a plain Error with no
// `code` and no `statusCode` — exactly what minimax.js throws for 5xx and
// other 4xx ("5xx and other 4xx return a plain Error (no `code`)").
function plainFailureBackend(message = 'minimax API 500 Internal Server Error: upstream exploded') {
  return {
    name: 'provider',
    async generate() {
      throw new Error(message);
    },
  };
}

// A backend that fails with a structured code that is NOT a rate limit.
// The provider client does not currently emit this shape, but the router
// must not assume that "structured" means "rate limited" — it must carry
// the code through faithfully and let the classifier decide.
function structuredNonRateLimitBackend(message = 'minimax API 503 Service Unavailable: backend down') {
  return {
    name: 'provider',
    async generate() {
      const err = new Error(message);
      err.code = 'upstream_unavailable';
      err.statusCode = 503;
      throw err;
    },
  };
}

async function captureAggregate(clients, mode = 'online') {
  const router = makeModelRouter({ clients, mode });
  try {
    await router.generate('hello');
  } catch (err) {
    return err;
  }
  throw new Error('expected the router to throw when every backend fails');
}

test('router aggregate preserves the structured 429 code of a rate-limited backend', async () => {
  const err = await captureAggregate([rateLimitedBackend()]);

  assert.equal(err.code, 'upstream_rate_limited',
    'the aggregate must carry the backend\'s structured code');
  assert.equal(err.statusCode, 429,
    'the aggregate must carry the backend\'s HTTP status');
});

test('a rate-limited backend classifies as upstream_rate_limited (AC1)', async () => {
  const err = await captureAggregate([rateLimitedBackend()]);

  // This is the assertion the card's AC1 asks for: the classified error
  // kind, produced by the real classifyError().
  assert.equal(classifyError(err), 'upstream_rate_limited');
});

test('NEGATIVE CONTROL: a non-rate-limit backend failure still classifies as upstream_error (AC4)', async () => {
  const err = await captureAggregate([plainFailureBackend()]);

  // The control must fail WITHOUT the fix. Before the fix, the aggregate's
  // message still contained the upstream text, so this assertion held
  // vacuously — the control proves the fix did not widen the classifier
  // into labelling every upstream failure as a rate limit.
  assert.equal(err.code, undefined,
    'a non-rate-limit failure must not gain a code');
  assert.equal(err.statusCode, undefined,
    'a non-rate-limit failure must not gain a statusCode');
  assert.equal(classifyError(err), 'upstream_error',
    'a non-rate-limit backend failure must remain an upstream_error');
});

test('NEGATIVE CONTROL: a structured non-rate-limit code is carried through but still classifies as upstream_error (AC4)', async () => {
  // This is the control that can actually fail. It exercises the exact
  // mistake a too-eager fix makes: treating "the backend reported a
  // structured code" as "the backend was rate limited". A fix that
  // hard-codes 'upstream_rate_limited' onto any structured failure (or
  // that labels every backend failure as a rate limit) fails HERE.
  const err = await captureAggregate([structuredNonRateLimitBackend()]);

  assert.equal(err.code, 'upstream_unavailable',
    'the structured code must be carried through faithfully');
  assert.equal(err.statusCode, 503);
  assert.equal(classifyError(err), 'upstream_error',
    'a non-rate-limit structured failure must remain an upstream_error');
});

test('a rate-limited backend wins over a concurrent plain failure', async () => {
  // Two backends: the first fails with a plain 500-shaped error, the second
  // reports a rate limit. The aggregate must be a rate limit — if any
  // backend reported one, the request as a whole was rate-limited.
  const err = await captureAggregate([plainFailureBackend(), rateLimitedBackend()], 'hybrid');

  assert.equal(err.code, 'upstream_rate_limited');
  assert.equal(classifyError(err), 'upstream_rate_limited');
});

test('the per-backend error list also carries the structured code', async () => {
  const err = await captureAggregate([rateLimitedBackend()]);

  assert.equal(err.routerErrors.length, 1);
  assert.equal(err.routerErrors[0].client, 'provider');
  assert.equal(err.routerErrors[0].code, 'upstream_rate_limited');
  assert.equal(err.routerErrors[0].statusCode, 429);
});

test('the aggregate message is unchanged for clients that set no code', async () => {
  // The pre-existing error-envelope contract (see the 'routerErrors array
  // with per-client details' test in model-router.test.js) is that the
  // per-backend entry is { client, error }. Adding code/statusCode must not
  // change the shape of the message the caller sees for a plain failure.
  const err = await captureAggregate([plainFailureBackend()]);

  assert.match(err.message, /ModelRouter\(online\): all 1 backends failed/);
  assert.match(err.message, /minimax API 500 Internal Server Error/);
});

// === Full production path ===
//
// The tests above prove the router aggregate carries the code and that the
// classifier reads it. This one proves the whole chain the coordinator
// actually runs in production: router → rl-pipeline (parallelReasoning →
// client.generate) → awareRlPipeline's catch → classifyError → the
// `error.type` field of the response envelope that http-server.js writes to
// the `aware_conversations.error_kind` audit column.
//
// rl-pipeline is a sibling repo. It is present at <repo>/../rl-pipeline/ on
// a dev host and at /app/rl-pipeline/ inside the coordinator image. The
// vendored copy under backend/heavy-think/src/ is the same library and is
// used as the fallback so the test is meaningful wherever it runs.

function findRlPipelineEntry() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.AWARE_RL_PIPELINE_PATH,
    resolve(here, '..', '..', '..', '..', 'rl-pipeline', 'src', 'index.js'),
    resolve(here, '..', '..', '..', '..', '..', 'rl-pipeline', 'src', 'index.js'),
    resolve(here, '..', '..', '..', '..', 'backend', 'heavy-think', 'src', 'index.js'),
  ].filter(Boolean);
  return candidates.find(p => existsSync(p)) || null;
}

test('FULL PATH: a provider 429 through the router reaches the audit trail as upstream_rate_limited', async (t) => {
  const rlPipelineEntry = findRlPipelineEntry();
  if (!rlPipelineEntry) {
    t.skip('rl-pipeline sibling library not available on this host');
    return;
  }
  const prevPath = process.env.AWARE_RL_PIPELINE_PATH;
  process.env.AWARE_RL_PIPELINE_PATH = rlPipelineEntry;
  __resetRlPipelineForTest();
  try {
    // The router, as buildDefaultRouter() wires it: the provider client is
    // the FIRST client, and in 'online' mode it is the only one.
    const router = makeModelRouter({
      clients: [rateLimitedBackend()],
      mode: 'online',
    });

    // awareRlPipeline calls rl-pipeline, which calls router.generate() for
    // each of its K reasoning attempts. The router throws its aggregate;
    // rl-pipeline does not catch it; awareRlPipeline's catch classifies it.
    const envelope = await awareRlPipeline({
      problem: 'solve x',
      K: 1,
      task_type: 'standard',
      client: router,
      writePairs: false,
    });

    assert.equal(envelope.ok, false,
      'the envelope must report the failure');
    assert.equal(envelope.error.type, 'upstream_rate_limited',
      'the audit trail must record a provider 429 as upstream_rate_limited');
  } finally {
    if (prevPath === undefined) delete process.env.AWARE_RL_PIPELINE_PATH;
    else process.env.AWARE_RL_PIPELINE_PATH = prevPath;
    __resetRlPipelineForTest();
  }
});
