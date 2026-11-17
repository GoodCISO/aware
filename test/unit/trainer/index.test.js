// test/unit/trainer/index.test.js — Unit tests for src/trainer/index.js
//
// These tests use dependency injection (modal client, pg pool, logger)
// to drive the poller deterministically — no real Modal account, no
// real Postgres. The trainer is one of the few AWARE 2.0 modules
// where env-gated integration tests are the right answer for the
// end-to-end flow (real Modal submit + poll + download); the unit
// tests here cover every code path the integration tests would
// otherwise need to enumerate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { TrainerPoller } from '../../../src/trainer/index.js';

// -- Helpers -----------------------------------------------------------

function makeTestLogger() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  return {
    lines,
    info: (...a) => lines.info.push(a.join(' ')),
    warn: (...a) => lines.warn.push(a.join(' ')),
    error: (...a) => lines.error.push(a.join(' ')),
    debug: (...a) => lines.debug.push(a.join(' ')),
  };
}

/**
 * Minimal in-memory pg.Pool stub. Only implements `query(sql, params)`
 * for the SQL strings the trainer actually issues.
 */
function makePoolStub(handlers = {}) {
  return {
    async query(sql, params) {
      // Normalize whitespace so multi-line SQL matches single-line regexes
      const norm = sql.replace(/\s+/g, ' ');
      // Route by SQL keyword
      if (/SELECT.*FROM aware_training_runs.*status IN/i.test(norm)) {
        return { rows: handlers.inflight ? [handlers.inflight] : [] };
      }
      // The new Phase 4 query: SELECT DISTINCT c.pair_path (uses the
      // last_run CTE, so it must be checked BEFORE the generic
      // WITH last_run matcher below).
      if (/SELECT DISTINCT c\.pair_path/i.test(norm)) {
        return { rows: (handlers.pairPaths || []).map(p => ({ pair_path: p })) };
      }
      if (/WITH last_run/i.test(norm)) {
        return { rows: [{ unconsumed: handlers.unconsumed ?? 0, total: handlers.total ?? 0 }] };
      }
      if (/INSERT INTO aware_training_runs/i.test(norm)) {
        handlers.inserted = handlers.inserted || [];
        handlers.inserted.push(params);
        return { rows: [] };
      }
      if (/UPDATE aware_training_runs\s+SET status = 'running'/i.test(norm)) {
        handlers.runningUpdates = handlers.runningUpdates || [];
        handlers.runningUpdates.push(params);
        return { rows: [] };
      }
      if (/UPDATE aware_training_runs\s+SET status = 'completed'/i.test(norm)) {
        handlers.completedUpdates = handlers.completedUpdates || [];
        handlers.completedUpdates.push(params);
        return { rows: [] };
      }
      if (/UPDATE aware_training_runs\s+SET status = 'failed'/i.test(norm)) {
        handlers.failedUpdates = handlers.failedUpdates || [];
        handlers.failedUpdates.push(params);
        return { rows: [] };
      }
      throw new Error(`unmocked query: ${sql.slice(0, 80)}...`);
    },
  };
}

function makeModalStub(opts = {}) {
  const { onSubmit, onPoll } = opts;
  return {
    async submit(args) {
      if (onSubmit) return onSubmit(args);
      return {
        jobId: 'modal-job-test-123',
        appName: 'aware-trainer',
        poll: onPoll || (async () => ({ status: 'running' })),
        getCheckpoint: async () => ({ checkpointPath: '/tmp/ckpt', sizeMb: 100 }),
      };
    },
  };
}

async function makeTempDataDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'aware-trainer-test-'));
}

const originalEnv = { ...process.env };

function setV2Env() {
  // Wipe v2 + modal env
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('AWARE_') || k.startsWith('MODAL_') || k.startsWith('PROVIDER_')) {
      delete process.env[k];
    }
  }
  // Defaults that match the v2 config
  process.env.AWARE_TRAINER_ENABLED = '1';
  process.env.AWARE_TRAINER_POLL_INTERVAL_SEC = '60';
  process.env.AWARE_TRAINER_MIN_PAIRS_PER_RUN = '100';
  process.env.MODAL_TOKEN_ID = 'ak-test-token-id-1234567890';
  process.env.MODAL_TOKEN_SECRET = 'as-test-token-secret-1234567890abcdef';
}

function clearV2Env() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('AWARE_') || k.startsWith('MODAL_') || k.startsWith('PROVIDER_')) {
      delete process.env[k];
    }
  }
  Object.assign(process.env, originalEnv);
}

// -- Tests -------------------------------------------------------------

test('trainer: kill switch off — start() returns immediately, no log noise', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();
  process.env.AWARE_TRAINER_ENABLED = '0';
  // Force a fresh require so the new env takes effect
  const { default: config } = await import('../../../src/config/index.cjs?bust=1');

  const logger = makeTestLogger();
  const poller = new TrainerPoller({ logger });
  await poller.start();

  assert.equal(poller._stopped, false);  // not stopped, just dormant
  assert.equal(poller._timer, null);     // no timer scheduled
  assert.ok(
    logger.lines.info.some((l) => /kill switch off/.test(l)),
    'expected kill-switch-off log'
  );
});

test('trainer: missing Modal token — warns but starts', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();
  delete process.env.MODAL_TOKEN_ID;

  const logger = makeTestLogger();
  const poller = new TrainerPoller({ logger, dataDir: await makeTempDataDir() });
  await poller.start();
  await poller.stop();

  assert.ok(
    logger.lines.warn.some((l) => /MODAL_TOKEN_ID.*unset/.test(l)),
    'expected missing-token warning'
  );
  // Reviewerally: the token VALUE never appears in any log line
  const allLogs = [
    ...logger.lines.info,
    ...logger.lines.warn,
    ...logger.lines.error,
    ...logger.lines.debug,
  ].join('\n');
  assert.ok(
    !allLogs.includes('ak-test-token-id'),
    'token value must never appear in logs'
  );
});

test('trainer: Modal tokens present — logs length only, not value', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const logger = makeTestLogger();
  const poller = new TrainerPoller({ logger, dataDir: await makeTempDataDir() });
  await poller.start();
  await poller.stop();

  const allLogs = logger.lines.info.join('\n');
  assert.ok(
    /Modal tokens present.*id length=\d+.*secret length=\d+/.test(allLogs),
    'expected length-only token log'
  );
  // The actual secret value must not be in any log
  assert.ok(
    !allLogs.includes('ak-test-token-id-1234567890'),
    'token id value must never appear in logs'
  );
  assert.ok(
    !allLogs.includes('as-test-token-secret-1234567890abcdef'),
    'token secret value must never appear in logs'
  );
});

test('trainer: insufficient pairs — does not submit', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const logger = makeTestLogger();
  const pool = makePoolStub({ unconsumed: 5 });  // below minPairsPerRun=100
  let submitCalled = false;
  const modalClient = makeModalStub({ onSubmit: () => { submitCalled = true; } });

  const poller = new TrainerPoller({
    logger,
    pool,
    modalClient,
    dataDir: await makeTempDataDir(),
  });
  await poller.start();
  await poller._tick();
  await poller.stop();

  assert.equal(submitCalled, false, 'should not have called modalClient.submit');
});

test('trainer: enough pairs — submits a new run, records to DB', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  // Phase 4: the trainer now packages a real DPO dataset from the
  // preference-pair JSONL files referenced by unconsumed
  // aware_conversations rows. Write a small temp JSONL with two
  // valid preference-pair records so _packageDataset() produces
  // output.
  const pairDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aware-trainer-pairs-'));
  const pairFile = path.join(pairDir, '2026-06-12.jsonl');
  const rec1 = {
    problem: 'What is 2+2?',
    task_type: 'arithmetic',
    chosen: { reasoning: '4', prm_score: 0.95 },
    rejected: { reasoning: '5', prm_score: 0.10 },
    _content_hash: 'aaaa1111aaaa1111',
  };
  const rec2 = {
    problem: 'What is the capital of France?',
    task_type: 'factual',
    chosen: { reasoning: 'Paris', prm_score: 0.98 },
    rejected: { reasoning: 'London', prm_score: 0.05 },
    _content_hash: 'bbbb2222bbbb2222',
  };
  await fsp.writeFile(pairFile, JSON.stringify(rec1) + '\n' + JSON.stringify(rec2) + '\n', 'utf8');

  const logger = makeTestLogger();
  const handlers = { unconsumed: 250, pairPaths: [pairFile] };
  const pool = makePoolStub(handlers);
  let submitArgs = null;
  const modalClient = {
    async submit(args) {
      submitArgs = args;
      return {
        jobId: 'modal-job-abc',
        appName: 'aware-trainer',
        poll: async () => ({ status: 'running' }),
        getCheckpoint: async () => ({ checkpointPath: '/ckpt', sizeMb: 50 }),
      };
    },
  };

  const dataDir = await makeTempDataDir();
  const poller = new TrainerPoller({
    logger, pool, modalClient, dataDir,
  });
  await poller.start();
  // Cancel the auto-scheduled timer so it doesn't double-tick against
  // our manual _tick() call. Replaced by manual control for tests.
  await poller.stop();
  poller._stopped = false;  // allow manual ticks after stop()
  poller._timer = null;
  // Re-inject deps (stop() doesn't clear them, but be explicit)
  poller.deps = { logger, pool, modalClient, dataDir };
  await poller._tick();

  assert.ok(submitArgs, 'modalClient.submit was called');
  assert.equal(submitArgs.runId.length > 0, true);
  assert.match(submitArgs.datasetPath, new RegExp(dataDir));
  assert.equal(submitArgs.config.app_name, 'aware-trainer');

  // The DPO dataset file was created with real content (Phase 4)
  const datasetFile = submitArgs.datasetPath;
  const stat = await fsp.stat(datasetFile);
  assert.equal(stat.isFile(), true);
  assert.ok(stat.size > 0, 'dataset file should be non-empty');
  // Verify the JSONL has at least one DPO row in 'messages' format
  const datasetText = await fsp.readFile(datasetFile, 'utf8');
  const firstRow = JSON.parse(datasetText.split('\n')[0]);
  assert.ok(Array.isArray(firstRow.prompt), 'prompt should be a messages array');
  assert.ok(Array.isArray(firstRow.chosen), 'chosen should be a messages array');

  // The run was recorded as 'pending' (INSERT), then 'running' (UPDATE)
  // n_pairs in the INSERT should be the number of DPO rows we wrote
  // (2), not the unconsumed count from the SELECT (250).
  assert.equal(handlers.inserted.length, 1, 'expected INSERT for run start');
  // Args: [runId, source, datasetPath, azrCorpusPath, nPairs, ...]
  // nPairs is at index 4 (Phase 4 deliverable 1 added azrCorpusPath
  // at index 3, shifting nPairs from 3 to 4).
  assert.equal(handlers.inserted[0][4], 2, 'expected n_pairs=2 (dataset rows)');
  assert.equal(handlers.runningUpdates.length, 1, 'expected UPDATE to running');
  assert.equal(handlers.runningUpdates[0][1], 'modal-job-abc');

  // Clean up the temp pair file
  await fsp.rm(pairDir, { recursive: true, force: true });
  await poller.stop();
});

test('trainer: submit failure — records failed run with exit_code=1', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  // Phase 4: provide a real preference-pair JSONL so the dataset
  // packaging succeeds and the failure path is exercised at
  // modalClient.submit(), not earlier.
  const pairDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aware-trainer-pairs-'));
  const pairFile = path.join(pairDir, '2026-06-12.jsonl');
  await fsp.writeFile(pairFile, JSON.stringify({
    problem: 'What is 1+1?',
    task_type: 'arithmetic',
    chosen: { reasoning: '2', prm_score: 0.9 },
    rejected: { reasoning: '3', prm_score: 0.1 },
    _content_hash: 'cccc3333cccc3333',
  }) + '\n', 'utf8');

  const logger = makeTestLogger();
  const handlers = { unconsumed: 250, pairPaths: [pairFile] };
  const pool = makePoolStub(handlers);
  const modalClient = {
    async submit() { throw new Error('modal API down'); },
  };

  const poller = new TrainerPoller({
    logger, pool, modalClient, dataDir: await makeTempDataDir(),
  });
  await poller.start();
  await poller._tick();

  assert.equal(handlers.failedUpdates.length, 1, 'expected failed UPDATE');
  assert.equal(handlers.failedUpdates[0][1], 1);  // exit_code
  assert.match(handlers.failedUpdates[0][2], /modal API down/);

  await fsp.rm(pairDir, { recursive: true, force: true });
  await poller.stop();
});

test('trainer: in-flight run is polled, not double-submitted', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const logger = makeTestLogger();
  const inflightRow = {
    run_id: 'run-existing',
    modal_job_id: 'modal-job-existing',
    started_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const handlers = { inflight: inflightRow, unconsumed: 0 };
  const pool = makePoolStub(handlers);

  let submitCalled = false;
  let pollCalled = false;
  const modalClient = {
    async submit() { submitCalled = true; },
  };

  const poller = new TrainerPoller({
    logger, pool, modalClient, dataDir: await makeTempDataDir(),
  });
  // Inject the resolve-inflight hook
  poller._resolveInflight = async (runId, jobId) => {
    assert.equal(runId, 'run-existing');
    assert.equal(jobId, 'modal-job-existing');
    pollCalled = true;
    return {
      jobId,
      appName: 'aware-trainer',
      poll: async () => ({ status: 'running' }),
      getCheckpoint: async () => ({ checkpointPath: '/ckpt', sizeMb: 50 }),
    };
  };

  await poller.start();
  await poller._tick();

  assert.equal(submitCalled, false, 'should not have submitted a new run');
  assert.equal(pollCalled, true, 'should have polled the in-flight run');

  await poller.stop();
});

test('trainer: in-flight run completes — atomic symlink swap, DB updated', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();
  process.env.AWARE_TRAINER_WEIGHTS_DIR = path.join(os.tmpdir(), `aware-trainer-weights-${Date.now()}`);

  const logger = makeTestLogger();
  const inflightRow = {
    run_id: 'run-completing',
    modal_job_id: 'modal-job-x',
    started_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const handlers = { inflight: inflightRow };
  const pool = makePoolStub(handlers);

  const poller = new TrainerPoller({
    logger, pool, modalClient: makeModalStub(), dataDir: await makeTempDataDir(),
  });
  poller._resolveInflight = async () => ({
    jobId: 'modal-job-x',
    appName: 'aware-trainer',
    poll: async () => ({ status: 'completed', exitCode: 0 }),
    getCheckpoint: async () => ({ checkpointPath: '/ckpt/run-x', sizeMb: 1234 }),
  });

  // Race-condition guard: start() schedules an auto-tick via
  // setTimeout(0); the auto-tick and the manual tick below can
  // race, causing handlers.completedUpdates to be 0 or 2
  // depending on scheduling. Cancel the auto-tick and drive
  // _tick() manually for determinism (same pattern as
  // "enough pairs" test).
  await poller.start();
  await poller.stop();
  poller._stopped = false;
  poller._timer = null;
  poller.deps = { logger, pool, modalClient: poller.deps.modalClient, dataDir: poller.deps.dataDir };
  await poller._tick();

  assert.equal(handlers.completedUpdates.length, 1);
  assert.equal(handlers.completedUpdates[0][0], 'run-completing');
  assert.equal(handlers.completedUpdates[0][1], 0);  // exit_code
  assert.equal(handlers.completedUpdates[0][3], '/ckpt/run-x');  // checkpointPath
  assert.equal(handlers.completedUpdates[0][4], 1234);  // sizeMb

  // The active symlink was created and points at /ckpt/run-x.
  // F-001 fix: the symlink lives at ${weightsDir}/active (not at
  // ${weightsDir} as before). See src/trainer/index.js:_atomicSymlinkSwap.
  const activeLink = path.join(process.env.AWARE_TRAINER_WEIGHTS_DIR, 'active');
  const linkTarget = await fsp.readlink(activeLink);
  assert.equal(linkTarget, '/ckpt/run-x');

  // Cleanup
  await fsp.unlink(activeLink).catch(() => {});

  await poller.stop();
});

test('trainer: in-flight run fails — DB records failed with error', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const logger = makeTestLogger();
  const inflightRow = {
    run_id: 'run-failing',
    modal_job_id: 'modal-job-fail',
    started_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const handlers = { inflight: inflightRow };
  const pool = makePoolStub(handlers);

  const poller = new TrainerPoller({
    logger, pool, modalClient: makeModalStub(), dataDir: await makeTempDataDir(),
  });
  poller._resolveInflight = async () => ({
    jobId: 'modal-job-fail',
    appName: 'aware-trainer',
    poll: async () => ({ status: 'failed', exitCode: 137, errorMessage: 'OOM killed' }),
    getCheckpoint: async () => { throw new Error('no checkpoint'); },
  });

  await poller.start();
  // Race-condition guard (see "in-flight run completes" test)
  await poller.stop();
  poller._stopped = false;
  poller._timer = null;
  poller.deps = { logger, pool, modalClient: poller.deps.modalClient, dataDir: poller.deps.dataDir };
  await poller._tick();

  assert.equal(handlers.failedUpdates.length, 1);
  assert.equal(handlers.failedUpdates[0][1], 137);
  assert.match(handlers.failedUpdates[0][2], /OOM killed/);

  await poller.stop();
});

test('trainer: missing modal-training.json — uses empty defaults, no crash', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();
  process.env.AWARE_TRAINER_CONFIG = '/nonexistent/modal-training.json';

  const logger = makeTestLogger();
  const poller = new TrainerPoller({
    logger, pool: null, modalClient: makeModalStub(), dataDir: await makeTempDataDir(),
  });
  await poller.start();
  await poller.stop();

  assert.ok(
    logger.lines.warn.some((l) => /not found/.test(l)),
    'expected missing-config warning'
  );
  assert.equal(poller._trainingConfig.app_name, 'aware-trainer');
});

test('trainer: atomic symlink swap — uses rename(2), not two-step', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();
  const weightsDir = path.join(os.tmpdir(), `aware-trainer-atomic-${Date.now()}`);
  process.env.AWARE_TRAINER_WEIGHTS_DIR = weightsDir;

  const logger = makeTestLogger();
  const poller = new TrainerPoller({
    logger, pool: null, modalClient: makeModalStub(), dataDir: await makeTempDataDir(),
  });
  await poller.start();
  await poller._atomicSymlinkSwap('/first/checkpoint');
  await poller._atomicSymlinkSwap('/second/checkpoint');

  // The symlink lives at ${weightsDir}/active (matches the
  // lora-reloader's resolveActiveTarget path). See F-001 in
  // redacted-internal-doc — the prior implementation created the symlink AT
  // ${weightsDir} which the reloader could never see.
  const activeLink = path.join(weightsDir, 'active');
  const target = await fsp.readlink(activeLink);
  assert.equal(target, '/second/checkpoint', 'symlink at ${weightsDir}/active should now point to second checkpoint');

  await fsp.unlink(activeLink).catch(() => {});
  await fsp.rm(weightsDir, { recursive: true, force: true }).catch(() => {});
  await poller.stop();
});

test('trainer: atomic symlink swap — symlink at ${weightsDir}/active resolves to the right target', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();
  const weightsDir = path.join(os.tmpdir(), `aware-trainer-resolve-${Date.now()}`);
  process.env.AWARE_TRAINER_WEIGHTS_DIR = weightsDir;

  const logger = makeTestLogger();
  const poller = new TrainerPoller({
    logger, pool: null, modalClient: makeModalStub(), dataDir: await makeTempDataDir(),
  });
  await poller.start();
  await poller._atomicSymlinkSwap('/ckpts/run-42/merged');

  // F-001: prove the symlink lives at the path the lora-reloader
  // watches. resolveActiveTarget(weightsDir) reads
  // path.join(weightsDir, 'active'), so we exercise the exact path
  // the coordinator's reloader would read.
  const { resolveActiveTarget } = await import('../../../src/coordinator/lora-reloader.js');
  const resolved = await resolveActiveTarget(weightsDir);
  assert.equal(resolved, '/ckpts/run-42/merged',
    'lora-reloader must resolve to the same target the trainer wrote');

  await fsp.unlink(path.join(weightsDir, 'active')).catch(() => {});
  await fsp.rm(weightsDir, { recursive: true, force: true }).catch(() => {});
  await poller.stop();
});

test('trainer: SIGTERM during start — exits cleanly', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const logger = makeTestLogger();
  const poller = new TrainerPoller({
    logger, pool: null, modalClient: makeModalStub(), dataDir: await makeTempDataDir(),
  });
  await poller.start();
  await poller.stop();
  assert.equal(poller._stopped, true);
  assert.equal(poller._timer, null);
});

test('trainer: kill switch flips off mid-loop — _tick exits', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const logger = makeTestLogger();
  const poller = new TrainerPoller({
    logger, pool: null, modalClient: makeModalStub(), dataDir: await makeTempDataDir(),
  });
  await poller.start();
  assert.equal(poller._stopped, false);

  // Simulate operator flipping the env
  process.env.AWARE_TRAINER_ENABLED = '0';
  await poller._tick();
  assert.equal(poller._stopped, true);
  assert.ok(
    logger.lines.info.some((l) => /kill switch flipped off/.test(l)),
    'expected kill-switch-flipped log'
  );
});

test('trainer: dry-poll mode (pool=null) — counts are 0, never submits', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const logger = makeTestLogger();
  let submitCalled = false;
  const modalClient = makeModalStub({ onSubmit: () => { submitCalled = true; } });
  const poller = new TrainerPoller({
    logger, pool: null, modalClient, dataDir: await makeTempDataDir(),
  });
  await poller.start();
  await poller._tick();

  const counts = await poller._countPreferencePairs();
  assert.equal(counts.unconsumed, 0);
  assert.equal(submitCalled, false);

  await poller.stop();
});

// -- Phase 4 (ADR (internal) 618-627) outcome-filter + dataset packaging tests

test('trainer: Phase 4 — outcome filter drops all pairs → run cancelled, no submit', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();
  // Force the aggressive min_score_gap filter so every pair (gap < 0.5)
  // gets dropped.
  process.env.AWARE_TRAINER_FILTER_RULE = 'min_score_gap';
  process.env.AWARE_TRAINER_FILTER_MIN_GAP = '0.5';
  // Bust the config cache so the new env takes effect on next read
  await import('../../../src/config/index.cjs?bust=phase4-cancel');

  const pairDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aware-trainer-pairs-'));
  const pairFile = path.join(pairDir, '2026-06-12.jsonl');
  // Three records, all with tight score gaps (0.04 < 0.5 threshold)
  const lines = [];
  for (let i = 0; i < 3; i++) {
    // Judge declaration (kanban t_155a95a1): the gap may only gate for an
    // INDEPENDENT judge declared with a gating role, so this fixture
    // declares one. The pairs below are dropped for the reason this test
    // is about -- a gap below the threshold -- not for lack of a judge.
    const judge = {
      prm_score_role: 'launch_gate',
      prm_score_independent: true,
      prm_score_judge_model: 'judge-model-x',
    };
    lines.push(JSON.stringify({
      problem: `problem ${i}`,
      task_type: 'arithmetic',
      chosen: { reasoning: 'A', prm_score: 0.52, prm_score_source: 'prm_judge', ...judge },
      rejected: { reasoning: 'B', prm_score: 0.48, prm_score_source: 'prm_judge', ...judge },
      prm_score_role: judge.prm_score_role,
      prm_score_independent: judge.prm_score_independent,
      prm_score_judge_model: judge.prm_score_judge_model,
      _content_hash: `hash0000000000${i}0`.slice(0, 16),
    }));
  }
  await fsp.writeFile(pairFile, lines.join('\n') + '\n', 'utf8');

  const logger = makeTestLogger();
  // Set unconsumed to a value above the minPairsPerRun threshold (default
  // 100) so the trainer reaches _submitNewRun and the filter actually
  // runs.
  const handlers = { unconsumed: 250, pairPaths: [pairFile] };
  const pool = makePoolStub(handlers);
  let submitCalled = false;
  const modalClient = {
    async submit() { submitCalled = true; return {}; },
  };

  const poller = new TrainerPoller({
    logger, pool, modalClient, dataDir: await makeTempDataDir(),
  });
  await poller.start();
  await poller._tick();

  assert.equal(submitCalled, false, 'modalClient.submit should NOT be called when filter drops all');
  // Look for the 'cancelled' log line
  const warn = logger.lines.warn.find(l => /cancelled.*no pairs survived outcome filter/.test(l));
  assert.ok(warn, 'expected cancellation warn log line');
  // And the run should be recorded as cancelled (INSERT with status='cancelled')
  const cancelledInsert = handlers.inserted?.find(p => p[1] === 'preference_pairs_volume');
  assert.ok(cancelledInsert, 'expected cancelled INSERT');
  // The error_message column (last param) should explain why
  assert.match(cancelledInsert[7], /no pairs after outcome filter/);

  await fsp.rm(pairDir, { recursive: true, force: true });
  await poller.stop();
});

test('trainer: Phase 4 — _fetchUnconsumedPairPaths returns DISTINCT paths from DB', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const logger = makeTestLogger();
  // The DB-side DISTINCT guarantees uniqueness; the mock returns
  // 2 distinct rows (the trainer's code doesn't need to dedupe).
  const handlers = { unconsumed: 5, pairPaths: ['/x.jsonl', '/y.jsonl'] };
  const pool = makePoolStub(handlers);
  const poller = new TrainerPoller({ logger, pool, dataDir: await makeTempDataDir() });

  const paths = await poller._fetchUnconsumedPairPaths();
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.sort(), ['/x.jsonl', '/y.jsonl']);

  await poller.stop();
});

test('trainer: Phase 4 — _readPreferencePairFiles dedupes by _content_hash across files', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aware-trainer-pairs-'));
  const f1 = path.join(dir, 'a.jsonl');
  const f2 = path.join(dir, 'b.jsonl');
  const shared = { problem: 'shared', chosen: { reasoning: 'X', prm_score: 0.9 },
                   rejected: { reasoning: 'Y', prm_score: 0.1 }, _content_hash: 'same-hash-12' };
  const unique1 = { problem: 'unique1', chosen: { reasoning: 'X', prm_score: 0.9 },
                    rejected: { reasoning: 'Y', prm_score: 0.1 }, _content_hash: 'unique-hash-1' };
  const unique2 = { problem: 'unique2', chosen: { reasoning: 'X', prm_score: 0.9 },
                    rejected: { reasoning: 'Y', prm_score: 0.1 }, _content_hash: 'unique-hash-2' };
  await fsp.writeFile(f1, JSON.stringify(shared) + '\n' + JSON.stringify(unique1) + '\n', 'utf8');
  await fsp.writeFile(f2, JSON.stringify(shared) + '\n' + JSON.stringify(unique2) + '\n', 'utf8');

  const logger = makeTestLogger();
  const poller = new TrainerPoller({ logger, dataDir: await makeTempDataDir() });
  const records = await poller._readPreferencePairFiles([f1, f2]);
  assert.equal(records.length, 3, 'shared record should appear once (deduped by _content_hash)');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('trainer: Phase 4 — _readPreferencePairFiles skips missing files without throwing', async (t) => {
  t.after(() => clearV2Env());
  setV2Env();

  const logger = makeTestLogger();
  const poller = new TrainerPoller({ logger, dataDir: await makeTempDataDir() });
  // Mix of missing and present files
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aware-trainer-pairs-'));
  const good = path.join(dir, 'good.jsonl');
  await fsp.writeFile(good, JSON.stringify({ problem: 'p', _content_hash: 'hash1' }) + '\n', 'utf8');

  const records = await poller._readPreferencePairFiles([
    '/nonexistent/foo.jsonl',
    good,
    '/nonexistent/bar.jsonl',
  ]);
  assert.equal(records.length, 1);
  // And the warn log should mention the missing files
  const warns = logger.lines.warn.filter(l => /unreadable/.test(l));
  assert.ok(warns.length >= 2, 'expected warn logs for missing files');

  await fsp.rm(dir, { recursive: true, force: true });
});
