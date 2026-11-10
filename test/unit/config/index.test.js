// Tests for src/config/index.js — the centralized v2 configuration module.
//
// These tests run against a clean env to make assertions independent of
// whatever the host shell happens to have set. We snapshot process.env,
// mutate it as needed, and restore on teardown.

const test = require('node:test');
const assert = require('node:assert/strict');

// Each test starts with a known env. We clear every AWARE_* / coord /
// gateway / model / rl-pipeline / ollama var so the test isn't influenced
// by the developer's shell.
function clearV2Env() {
  for (const k of Object.keys(process.env)) {
    if (
      k === 'COORDINATOR_PORT' || k === 'COORDINATOR_HOST' ||
      k === 'COORDINATOR_URL' ||
      k === 'GATEWAY_PORT' || k === 'GATEWAY_HOST' ||
      k === 'AWARE_REQUEST_TIMEOUT_MS' || k === 'AWARE_REQUEST_COST_CAP_USD' ||
      k === 'AWARE_KILL_SWITCH' || k === 'AWARE_GATEWAY_KILL_SWITCH' ||
      k === 'AWARE_RL_PIPELINE_PATH' ||
      k === 'AWARE_MODE' || k === 'OLLAMA_URL' ||
      k === 'LLM_API_KEY' || k === 'PROVIDER_API_HOST' ||
      k === 'AWARE_PRM_CACHE_ENABLED' || k === 'AWARE_PRM_CACHE_TTL_DAYS' ||
      k === 'AWARE_PRM_CACHE_TABLE' ||
      k === 'AWARE_BUDGET_ENABLED' || k === 'AWARE_BUDGET_WINDOW_DAYS' ||
      k === 'AWARE_BUDGET_SOFT_LIMIT_USD' || k === 'AWARE_BUDGET_HARD_LIMIT_USD' ||
      k === 'MODAL_TOKEN_ID' || k === 'MODAL_TOKEN_SECRET'
    ) {
      delete process.env[k];
    }
  }
}

test.beforeEach(() => {
  clearV2Env();
});

test('config: defaults are sane', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.equal(config.coordinator.port, 8080);
  assert.equal(config.coordinator.host, '127.0.0.1');
  assert.equal(config.coordinator.requestTimeoutMs, 120_000);
  assert.equal(config.coordinator.requestCostCapUsd, 1.0);
  assert.equal(config.coordinator.killSwitch, false);

  assert.equal(config.gateway.port, 18080);
  assert.equal(config.gateway.host, '0.0.0.0');
  assert.equal(config.gateway.proxyTimeoutMs, 120_000);
  assert.equal(config.gateway.coordinatorUrl, 'http://coordinator:8080');
  assert.equal(config.gateway.killSwitch, false);

  assert.equal(config.model.mode, 'hybrid');
  assert.equal(config.model.providerApiKey, undefined);
  assert.equal(config.model.ollamaUrl, 'http://127.0.0.1:11434');
});

test('config: env overrides take effect', (t) => {
  process.env.COORDINATOR_PORT = '9100';
  process.env.COORDINATOR_HOST = '0.0.0.0';
  process.env.AWARE_REQUEST_TIMEOUT_MS = '5000';
  process.env.AWARE_REQUEST_COST_CAP_USD = '0.25';
  process.env.AWARE_KILL_SWITCH = '1';
  process.env.GATEWAY_PORT = '19090';
  process.env.GATEWAY_HOST = '127.0.0.1';
  process.env.GATEWAY_PROXY_TIMEOUT_MS = '30000';
  process.env.COORDINATOR_URL = 'http://upstream:9999';
  process.env.AWARE_GATEWAY_KILL_SWITCH = '1';
  process.env.AWARE_MODE = 'online';
  process.env.LLM_API_KEY='***';
  process.env.OLLAMA_URL = 'http://ollama:11434';

  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.equal(config.coordinator.port, 9100);
  assert.equal(config.coordinator.host, '0.0.0.0');
  assert.equal(config.coordinator.requestTimeoutMs, 5000);
  assert.equal(config.coordinator.requestCostCapUsd, 0.25);
  assert.equal(config.coordinator.killSwitch, true);
  assert.equal(config.gateway.port, 19090);
  assert.equal(config.gateway.host, '127.0.0.1');
  assert.equal(config.gateway.proxyTimeoutMs, 30000);
  assert.equal(config.gateway.coordinatorUrl, 'http://upstream:9999');
  assert.equal(config.gateway.killSwitch, true);
  assert.equal(config.model.mode, 'online');
  assert.equal(config.model.providerApiKey, '***');
  assert.equal(config.model.ollamaUrl, 'http://ollama:11434');
});

test('config: lazy reads see env mutations between accesses', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.equal(config.gateway.port, 18080);
  process.env.GATEWAY_PORT = '19999';
  assert.equal(config.gateway.port, 19999);
  process.env.GATEWAY_PORT = '0';
  assert.equal(config.gateway.port, 0);
});

test('config: kill-switch is bool, not just string "1"', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  process.env.AWARE_KILL_SWITCH = '1';
  assert.equal(config.coordinator.killSwitch, true);
  process.env.AWARE_KILL_SWITCH = 'true';
  assert.equal(config.coordinator.killSwitch, true);
  process.env.AWARE_KILL_SWITCH = 'yes';
  assert.equal(config.coordinator.killSwitch, true);
  process.env.AWARE_KILL_SWITCH = '0';
  assert.equal(config.coordinator.killSwitch, false);
  process.env.AWARE_KILL_SWITCH = 'no';
  assert.equal(config.coordinator.killSwitch, false);
  delete process.env.AWARE_KILL_SWITCH;
  assert.equal(config.coordinator.killSwitch, false);
});

test('config: validate() throws on mode=online without key', (t) => {
  process.env.AWARE_MODE = 'online';
  // no LLM_API_KEY
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.throws(() => config.validate(), /AWARE_MODE=online requires LLM_API_KEY/);
});

test('config: validate() throws on GATEWAY_PORT == COORDINATOR_PORT', (t) => {
  process.env.COORDINATOR_PORT = '8080';
  process.env.GATEWAY_PORT = '8080';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.throws(
    () => config.validate(),
    /GATEWAY_PORT .* must differ from COORDINATOR_PORT/
  );
});

test('config: validate() throws on non-numeric numeric env', (t) => {
  process.env.AWARE_REQUEST_TIMEOUT_MS = 'not-a-number';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.throws(() => config.validate(), /AWARE_REQUEST_TIMEOUT_MS=.*not a finite number/);
});

test('config: validate() throws on out-of-range numeric env', (t) => {
  process.env.GATEWAY_PORT = '99999';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.throws(() => config.validate(), /GATEWAY_PORT=99999 is out of range/);
});

test('config: validate() throws on unknown mode', (t) => {
  process.env.AWARE_MODE = 'warp-drive';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.throws(
    () => config.validate(),
    /AWARE_MODE="warp-drive" is not one of \[online, hybrid, offline\]/
  );
});

test('config: validate() passes with mode=hybrid (no key required)', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.doesNotThrow(() => config.validate());
});

test('config: validate() passes with mode=online + key', (t) => {
  process.env.AWARE_MODE = 'online';
  process.env.LLM_API_KEY = 'present';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.doesNotThrow(() => config.validate());
});

test('config: warnings() lists missing key for online-ish modes', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  // Default mode=hybrid, no key → should warn
  const w = config.warnings();
  assert.ok(w.some(s => s.includes('LLM_API_KEY is not set')));
});

test('config: warnings() is empty when configured', (t) => {
  process.env.AWARE_MODE = 'online';
  process.env.LLM_API_KEY = 'present';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.deepEqual(config.warnings(), []);
});

test('config: snapshot() redacts secrets', (t) => {
  process.env.LLM_API_KEY = 'PLACEHOLDER';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  const snap = config.snapshot();
  const json = JSON.stringify(snap);
  // The actual key value must never appear in the snapshot
  assert.ok(!json.includes('PLACEHOLDER'),
    'snapshot must not contain secret value');
  // But we should know the length so debug logs are useful
  assert.match(snap.model.providerApiKey, /length=11/);
});

test('config: snapshot() shape is stable', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  const snap = config.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), [
    'budget', 'coordinator', 'db', 'gateway', 'model', 'prmCache', 'rlPipeline', 'trainer', 'warnings',
  ]);
  assert.deepEqual(Object.keys(snap.coordinator).sort(), [
    'authTokenLength', 'authTokenSet', 'host', 'killSwitch', 'loraReloaderEnabled', 'loraReloaderModelName',
    'loraReloaderPollIntervalMs', 'loraReloaderTimeoutMs', 'pairsDir',
    'port', 'requestCostCapUsd', 'requestTimeoutMs',
  ]);
  assert.deepEqual(Object.keys(snap.gateway).sort(), [
    'coordinatorUrl', 'host', 'killSwitch', 'port', 'proxyTimeoutMs',
  ]);
  assert.deepEqual(Object.keys(snap.model).sort(), [
    // providerModel added 2026-11-10 (scribe): the provider model name
    // was previously hard-coded inside the pinned rl-pipeline dependency,
    // so it could not be changed without republishing that library.
    // AWARE_PROVIDER_MODEL makes it an operator setting.
    'mode', 'ollamaTimeoutMs', 'ollamaUrl', 'providerApiKey', 'providerHost',
    'providerModel',
  ]);
  // The Ollama generation timeout must default to a value that clears a
  // real Qwen3.5-9B solution generation (measured 4.1-4.8s), and must
  // remain overridable and range-checked.
  assert.strictEqual(snap.model.ollamaTimeoutMs, 60_000);
  assert.deepEqual(Object.keys(snap.rlPipeline), ['path']);
  assert.deepEqual(Object.keys(snap.db).sort(), [
    'connectionTimeoutMs', 'database', 'enabled', 'host', 'password', 'port', 'user',
  ]);
  assert.deepEqual(Object.keys(snap.prmCache).sort(), [
    'enabled', 'table', 'ttlDays',
  ]);
  assert.deepEqual(Object.keys(snap.budget).sort(), [
    'enabled', 'hardLimitUsd', 'softLimitUsd', 'windowDays',
  ]);
  assert.deepEqual(Object.keys(snap.trainer).sort(), [
    'azrCorpusPath', 'baseModel', 'configPath', 'enabled', 'filterAllowedTaskTypes',
    'filterMinGap', 'filterRule', 'gpuType', 'jobTimeoutSec',
    'minPairsPerRun', 'modalTokenId', 'modalTokenSecret', 'pollIntervalSec', 'weightsDir',
  ]);
});

test('config: rl-pipeline path defaults to dev-layout sibling', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  // The default resolves to [REDACTED-PATH]
  // (or wherever rl-pipeline lives on the dev host).
  assert.match(config.rlPipeline.path, /rl-pipeline[\\\/]src[\\\/]index\.js$/);
});

test('config: rl-pipeline path honors env override', (t) => {
  process.env.AWARE_RL_PIPELINE_PATH = '/custom/path/rl-pipeline/src/index.js';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  assert.equal(config.rlPipeline.path, '/custom/path/rl-pipeline/src/index.js');
});

test('config: 0 is a valid port (OS picks)', (t) => {
  process.env.GATEWAY_PORT = '0';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });

  // num() allows 0 because min=1 would reject it; port 0 is the OS-pick
  // convention. Validation should not throw.
  assert.equal(config.gateway.port, 0);
  assert.doesNotThrow(() => config.validate());
});

// --- Phase 2.2: prmCache namespace --------------------------------------

test('config: prmCache.enabled defaults to true', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.prmCache.enabled, true);
});

test('config: prmCache.ttlDays defaults to 30', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.prmCache.ttlDays, 30);
});

test('config: prmCache.table defaults to aware_prm_cache', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.prmCache.table, 'aware_prm_cache');
});

test('config: prmCache.enabled honors env override (false)', (t) => {
  process.env.AWARE_PRM_CACHE_ENABLED = 'false';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.prmCache.enabled, false);
});

test('config: prmCache.ttlDays honors env override', (t) => {
  process.env.AWARE_PRM_CACHE_TTL_DAYS = '7';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.prmCache.ttlDays, 7);
});

// --- Phase 2.3: budget namespace ---------------------------------------

test('config: budget.enabled defaults to true', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.budget.enabled, true);
});

test('config: budget.windowDays defaults to 30', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.budget.windowDays, 30);
});

test('config: budget.softLimitUsd defaults to 80', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.budget.softLimitUsd, 80);
});

test('config: budget.hardLimitUsd defaults to 100', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.budget.hardLimitUsd, 100);
});

test('config: budget.enabled honors env override (false)', (t) => {
  process.env.AWARE_BUDGET_ENABLED = 'false';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.budget.enabled, false);
});

test('config: budget.windowDays honors env override', (t) => {
  process.env.AWARE_BUDGET_WINDOW_DAYS = '7';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.budget.windowDays, 7);
});

test('config: budget.softLimitUsd honors env override', (t) => {
  process.env.AWARE_BUDGET_SOFT_LIMIT_USD = '50';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.budget.softLimitUsd, 50);
});

test('config: budget.hardLimitUsd honors env override', (t) => {
  process.env.AWARE_BUDGET_HARD_LIMIT_USD = '250.50';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.budget.hardLimitUsd, 250.50);
});

// -- Trainer (Phase 3) ---------------------------------------------------

test('config: trainer.enabled defaults to false (kill switch off)', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.enabled, false);
});

test('config: trainer.pollIntervalSec defaults to 300', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.pollIntervalSec, 300);
});

test('config: trainer.minPairsPerRun defaults to 100', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.minPairsPerRun, 100);
});

test('config: trainer.baseModel defaults to trained-model', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.baseModel, 'Qwen/trained-model');
});

test('config: trainer.gpuType defaults to A100-80GB', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.gpuType, 'A100-80GB');
});

test('config: trainer.jobTimeoutSec defaults to 18000 (5h)', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.jobTimeoutSec, 18000);
});

test('config: trainer.configPath defaults to config/modal-training.json', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.configPath, 'config/modal-training.json');
});

test('config: trainer.enabled honors env override (true)', (t) => {
  process.env.AWARE_TRAINER_ENABLED = '1';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.enabled, true);
});

test('config: trainer.pollIntervalSec honors env override', (t) => {
  process.env.AWARE_TRAINER_POLL_INTERVAL_SEC = '60';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.pollIntervalSec, 60);
});

test('config: trainer.modalTokenId unset by default', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.modalTokenId, undefined);
});

test('config: trainer.modalTokenSecret unset by default', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.equal(config.trainer.modalTokenSecret, undefined);
});

test('config: trainer.modalTokenId redacted in snapshot', (t) => {
  process.env.MODAL_TOKEN_ID = 'ak-THIS-IS-A-SECRET-NEVER-LOG';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  const snap = config.snapshot();
  const json = JSON.stringify(snap);
  // The actual token value must never appear in the snapshot
  assert.ok(!json.includes('ak-THIS-IS-A-SECRET-NEVER-LOG'),
    'snapshot must not contain MODAL_TOKEN_ID value');
  // But the length is preserved for debug logs
  assert.match(snap.trainer.modalTokenId, /length=29/);
});

test('config: trainer.modalTokenSecret redacted in snapshot', (t) => {
  process.env.MODAL_TOKEN_SECRET = 'as-THIS-IS-A-SECRET-NEVER-LOG-XYZ';
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  const snap = config.snapshot();
  const json = JSON.stringify(snap);
  assert.ok(!json.includes('as-THIS-IS-A-SECRET-NEVER-LOG-XYZ'),
    'snapshot must not contain MODAL_TOKEN_SECRET value');
  assert.match(snap.trainer.modalTokenSecret, /length=33/);
});

test('config: validate() force-evaluates trainer getters without throwing', (t) => {
  const config = require('../../../src/config/index.cjs');
  t.after(() => { clearV2Env(); });
  assert.doesNotThrow(() => config.validate());
});
