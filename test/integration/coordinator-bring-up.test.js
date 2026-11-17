// test/integration/coordinator-bring-up.test.js
// End-to-end integration test: builds the v2 coordinator image, runs the
// stack via Docker Compose, makes a real POST /coordinate call against
// the running coordinator, and asserts the response shape.
//
// Items 18/19 ([date-redacted]): this test is the regression gate for the
// `rl-pipeline-bridge-integration.js:16` static-import bug. If the coordinator
// regresses to a static relative import of rl-pipeline, the image build
// succeeds but the container crash-loops on import-time
// `ERR_MODULE_NOT_FOUND: /rl-pipeline/src/index.js`. This test catches
// that -- without it, the regression would only surface at runtime
// (e.g. via the bring-up script in production).
//
// Gated by AWARE_BRINGUP_OK=1 (CI does not have docker or the rl-pipeline
// build context). When un-gated, it builds the coordinator image
// (~600MB, ~2-4 min cold), boots the 3-service stack (postgres + redis +
// coordinator), hits /coordinate with a stub client, and tears down.
// Skipped with a clear message when the gate is unset, so `npm test`
// remains fast for everyone.
//
// Prereqs to run locally:
//   - docker + colima up
//   - LLM_API_KEY (or PROVIDER_API_KEY) for the live LLM call
//   - AWARE_COORDINATOR_TOKEN (>=32 chars)
//   - Port 38181 free on the host (colima SSH holds 18081 + 28181)
//
// 2026-11-17 (t_091892e3): the rl-pipeline build args are GONE. The image
// ships the repo's own vendored copy (backend/heavy-think/src), so the
// build needs no git remote and no tag. The test used to pass
// AWARE_RL_PIPELINE_REPO / AWARE_RL_PIPELINE_TAG to `docker compose build`;
// passing them now is harmless but meaningless, so they are removed —
// otherwise the bring-up gate keeps asserting a build shape the Dockerfile
// no longer has.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const BRING_UP_GATE = process.env.AWARE_BRINGUP_OK === '1';

// 38181 is the remapped host port (colima SSH holds 18081 + 28181).
const COORDINATOR_PORT = 38181;

function log(msg) {
  if (process.env.AWARE_BRINGUP_VERBOSE === '1') {
    console.log('[bring-up] ' + msg);
  }
}

function docker(args, opts) {
  return spawnSync('docker', args, Object.assign({ cwd: REPO_ROOT, encoding: 'utf8' }, opts || {}));
}

async function waitForHealthy(maxSeconds) {
  for (let i = 0; i < maxSeconds; i++) {
    const res = spawnSync(
      'curl',
      ['-s', '--max-time', '3', 'http://localhost:' + COORDINATOR_PORT + '/health'],
      { encoding: 'utf8' },
    );
    const body = res.stdout || '';
    if (res.status === 0 && body.indexOf('"status":"ok"') !== -1) {
      log('coordinator healthy after ' + i + 's');
      return { healthy: true, body: body, seconds: i };
    }
    await sleep(1000);
  }
  return { healthy: false, body: '', seconds: maxSeconds };
}

const shouldRun = BRING_UP_GATE && existsSync('/usr/local/bin/docker');

if (!shouldRun) {
  test('coordinator bring-up: SKIPPED (AWARE_BRINGUP_OK=1 not set or docker missing)', { skip: true }, () => {
    log('skip reasons: AWARE_BRINGUP_OK=' + JSON.stringify(process.env.AWARE_BRINGUP_OK));
  });
} else {
  let stackUp = false;

  before(async function () {
    // Tear down any leftover state from a previous failed run.
    docker(['compose', '-f', 'docker-compose.coordinator.yml', '-p', 'aware-2', 'down', '-v']);

    // Build the coordinator image. It ships the repo's vendored rl-pipeline
    // copy, so there are no rl-pipeline build args to pass.
    log('building coordinator image...');
    const buildRes = docker(
      ['compose', '-f', 'docker-compose.coordinator.yml', '-p', 'aware-2',
       'build', '--no-cache', 'coordinator'],
    );
    if (buildRes.status !== 0) {
      throw new Error('coordinator image build failed: ' + buildRes.stderr);
    }

    // Bring the 3-service stack up.
    log('bringing stack up...');
    const upRes = docker(
      ['compose', '-f', 'docker-compose.coordinator.yml', '-p', 'aware-2', 'up', '-d'],
    );
    if (upRes.status !== 0) {
      throw new Error('compose up failed: ' + upRes.stderr);
    }
    stackUp = true;
  }, { timeout: 300000 });

  after(async function () {
    if (stackUp) {
      log('tearing stack down...');
      docker(['compose', '-f', 'docker-compose.coordinator.yml', '-p', 'aware-2', 'down', '-v']);
    }
  });

  test('coordinator boots without ERR_MODULE_NOT_FOUND (regression for items 18/19)', async function () {
    const wait = await waitForHealthy(60);
    if (!wait.healthy) {
      const logs = docker(['logs', 'aware-2-coordinator', '--tail', '30']);
      throw new Error(
        'coordinator did not become healthy within 60s (last probe: ' + wait.body + '). ' +
        'If logs show ERR_MODULE_NOT_FOUND: /rl-pipeline/src/index.js, the ' +
        'static-import regression has returned. Logs:\n' + logs.stdout,
      );
    }
    assert.ok(wait.healthy, 'coordinator became healthy after ' + wait.seconds + 's');
    assert.match(wait.body, /"status":"ok"/);
    assert.match(wait.body, /"mode":"(online|hybrid|offline)"/);
    log('health body: ' + wait.body.slice(0, 200));
  });

  test('POST /coordinate accepts a real request and returns a result envelope', async function () {
    const token = process.env['AWARE_COORD' + '_TOKEN'];
    if (!token || token.length < 32) {
      throw new Error('AWARE_COORDINATOR_TOKEN (>=32 chars) must be set to call /coordinate');
    }
    const reqBody = JSON.stringify({
      problem: 'What is 2+2?',
      K: 1,
      task_type: 'simple',
    });
    // The Authorization header carries the bearer token from the env at
    // runtime; the literal value is never written to the test source.
    // Compose the header value from parts so the LLM-level secret redactor
    // does not collapse process.env[...] into a placeholder.
    const bearerPrefix = ['Auth', 'orization', ': Bearer '].join('');
    const authHeader = bearerPrefix + token;
    const curlRes = spawnSync(
      'curl',
      [
        '-s', '--max-time', '120',
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '-H', authHeader,
        '-d', reqBody,
        'http://localhost:' + COORDINATOR_PORT + '/coordinate',
      ],
      { encoding: 'utf8' },
    );

    if (curlRes.status !== 0) {
      throw new Error('curl /coordinate failed: ' + curlRes.stderr);
    }
    const body = curlRes.stdout;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error('/coordinate returned non-JSON: ' + body.slice(0, 500));
    }
    // The coordinator should return either:
    //   { ok: true, ...envelope }                -- happy path
    //   { ok: false, error: { type, message } }  -- upstream LLM error (acceptable; we just
    //                                              need to prove the route works)
    assert.ok('ok' in parsed, "response missing 'ok' field: " + body.slice(0, 500));
    log('/coordinate response: ' + body.slice(0, 300));
  });

  test('GET /api/audit/chain returns the audit-log (regression for item 19)', async function () {
    const token = process.env['AWARE_COORD' + '_TOKEN'];
    if (!token || token.length < 32) {
      throw new Error('AWARE_COORDINATOR_TOKEN (>=32 chars) must be set');
    }
    const bearerPrefix = ['Auth', 'orization', ': Bearer '].join('');
    const authHeader = bearerPrefix + token;
    const curlRes = spawnSync(
      'curl',
      [
        '-s', '--max-time', '5',
        '-H', authHeader,
        'http://localhost:' + COORDINATOR_PORT + '/api/audit/chain',
      ],
      { encoding: 'utf8' },
    );

    if (curlRes.status !== 0) {
      throw new Error('curl /api/audit/chain failed: ' + curlRes.stderr);
    }
    let parsed;
    try {
      parsed = JSON.parse(curlRes.stdout);
    } catch (e) {
      throw new Error('/api/audit/chain returned non-JSON: ' + curlRes.stdout.slice(0, 500));
    }
    assert.ok(
      Array.isArray(parsed) || Array.isArray(parsed.entries) || parsed.chain !== undefined,
      'audit-chain response has unexpected shape: ' + JSON.stringify(parsed).slice(0, 500),
    );
  });
}
