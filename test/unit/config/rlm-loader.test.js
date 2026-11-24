// Tests for src/config/rlm.cjs — the RLM configuration loader and the
// verification-method guard (AWARE card t_0ff3a7b9).
//
// The defect this closes: config/rlm.yaml named `llm-judge` as the default
// verification method while no implementation existed, and nothing loaded
// config/rlm.yaml at runtime. These tests cover the loader itself and the
// guard that rejects a configured method with no implementation AT LOAD TIME.
//
// Unlike test/unit/config/rlm.test.js, this file does NOT need Python's
// jsonschema — the loader validates in-process with ajv.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'rlm.yaml');
const SCHEMA_PATH = path.join(REPO_ROOT, 'config', 'rlm.schema.json');

const rlmConfig = require(path.join(REPO_ROOT, 'src', 'config', 'rlm.cjs'));
const {
  loadRlmConfig,
  getImplementedVerificationMethods,
  IMPLEMENTED_VERIFICATION_METHODS,
  MIRRORED_IMPLEMENTED_VERIFICATION_METHODS,
} = rlmConfig;

function canonicalConfig() {
  const yaml = require('js-yaml');
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function baseConfig(overrides = {}) {
  const cfg = canonicalConfig();
  const verification = cfg.rlm.forwardedOptions.verification;
  Object.assign(verification, overrides);
  return cfg;
}

test('the canonical config loads, validates and passes the method guard', () => {
  const loaded = loadRlmConfig({ configPath: CONFIG_PATH, schemaPath: SCHEMA_PATH });
  assert.equal(loaded.config.rlm.enabled, true);
  assert.equal(loaded.config.rlm.forwardedOptions.verification.defaultMethod, 'llm-judge');
  assert.deepEqual(
    loaded.config.rlm.forwardedOptions.verification.allowedMethods,
    ['exec', 'llm-judge']
  );
});

test('the canonical config names only methods that have an implementation', () => {
  const cfg = canonicalConfig();
  const implemented = getImplementedVerificationMethods();
  const verification = cfg.rlm.forwardedOptions.verification;
  for (const method of verification.allowedMethods) {
    assert.ok(
      implemented.includes(method),
      `allowedMethods names '${method}', which has no implementation`
    );
  }
  assert.ok(
    implemented.includes(verification.defaultMethod),
    `defaultMethod names '${verification.defaultMethod}', which has no implementation`
  );
});

test('a defaultMethod with no implementation is rejected AT LOAD TIME', () => {
  const cfg = baseConfig({ defaultMethod: 'llm-judge-v2' });
  assert.throws(
    () => loadRlmConfig({ config: cfg, validateSchema: false }),
    (err) => {
      assert.match(err.message, /defaultMethod is 'llm-judge-v2', which has no implementation/);
      assert.match(err.message, /Implemented verification methods:/);
      assert.match(err.message, /llm-judge/);
      return true;
    }
  );
});

test('an allowedMethods entry with no implementation is rejected AT LOAD TIME', () => {
  const cfg = baseConfig({ allowedMethods: ['exec', 'not-implemented'] });
  assert.throws(
    () => loadRlmConfig({ config: cfg, validateSchema: false }),
    (err) => {
      assert.match(err.message, /allowedMethods contains 'not-implemented', which has no implementation/);
      return true;
    }
  );
});

test('the guard failure happens at load, not at first use', () => {
  // The whole point: a bad method must not survive until the first
  // verification call, where it surfaces as an opaque failure.
  const cfg = baseConfig({ defaultMethod: 'nope' });
  let threw = false;
  try {
    loadRlmConfig({ config: cfg, validateSchema: false });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
});

test('the schema also rejects an unknown method', () => {
  // The guard (implemented) and the schema (policy-legal) are different
  // checks. The guard runs FIRST, so to prove the schema still rejects on
  // its own we need a method that IS implemented but is NOT policy-legal:
  // 'test_suite' is in the verify.js registry but not in the schema's
  // enum. With the guard disabled the schema is the only thing standing
  // between the config and a bad value.
  const cfg = baseConfig({ defaultMethod: 'test_suite' });
  assert.throws(
    () => loadRlmConfig({ config: cfg, validateSchema: true, schemaPath: SCHEMA_PATH, guard: false }),
    /validation failed/
  );
});

test('the guard message wins over the schema message when both would fire', () => {
  // An unimplemented method is BOTH outside the schema enum AND missing an
  // implementation. The guard's message is the actionable one — it names the
  // offending method and the set that works — so it must be the one the
  // operator sees, not a bare "should be equal to one of the allowed values".
  const cfg = baseConfig({ defaultMethod: 'not-implemented' });
  assert.throws(
    () => loadRlmConfig({ config: cfg, validateSchema: true, schemaPath: SCHEMA_PATH }),
    (err) => {
      assert.match(err.message, /which has no implementation/);
      assert.doesNotMatch(err.message, /validation failed/);
      return true;
    }
  );
});

test('a defaultMethod outside allowedMethods is rejected', () => {
  const cfg = baseConfig({ allowedMethods: ['exec'], defaultMethod: 'llm-judge' });
  assert.throws(
    () => loadRlmConfig({ config: cfg, validateSchema: false }),
    /is not in allowedMethods/
  );
});

test('the guard can be bypassed only explicitly, and only for tests', () => {
  const cfg = baseConfig({ defaultMethod: 'nope' });
  const loaded = loadRlmConfig({ config: cfg, validateSchema: false, guard: false });
  assert.equal(loaded.config.rlm.forwardedOptions.verification.defaultMethod, 'nope');
});

test('env overrides are applied and re-validated', () => {
  const loaded = loadRlmConfig({
    configPath: CONFIG_PATH,
    schemaPath: SCHEMA_PATH,
    env: {
      AWARE_RLM_FORWARDED_OPTIONS_VERIFICATION_ALLOWED_METHODS: 'exec,llm-judge',
      AWARE_RLM_FORWARDED_OPTIONS_VERIFICATION_DEFAULT_METHOD: 'llm-judge',
      AWARE_RLM_BUDGET_USD: '5.00',
      AWARE_RLM_KILL_SWITCH: '1',
    },
  });
  assert.deepEqual(
    loaded.config.rlm.forwardedOptions.verification.allowedMethods,
    ['exec', 'llm-judge']
  );
  assert.equal(loaded.config.rlm.budgetUsd, 5);
  assert.equal(loaded.config.rlm.killSwitch, true);
});

test('an env override naming an unimplemented method is rejected at load', () => {
  assert.throws(
    () =>
      loadRlmConfig({
        configPath: CONFIG_PATH,
        schemaPath: SCHEMA_PATH,
        env: { AWARE_RLM_FORWARDED_OPTIONS_VERIFICATION_DEFAULT_METHOD: 'not-implemented' },
      }),
    /which has no implementation/
  );
});

test('a malformed budget override is rejected', () => {
  assert.throws(
    () =>
      loadRlmConfig({
        configPath: CONFIG_PATH,
        schemaPath: SCHEMA_PATH,
        env: { AWARE_RLM_BUDGET_USD: 'not-a-number' },
      }),
    /is not a non-negative number/
  );
});

test('a missing config file fails with an actionable message', () => {
  assert.throws(
    () =>
      loadRlmConfig({
        configPath: path.join(REPO_ROOT, 'config', 'does-not-exist.yaml'),
        schemaPath: SCHEMA_PATH,
      }),
    /could not read the RLM configuration/
  );
});

test('the mirrored implemented-method list matches the live heavy-think registry', () => {
  // Drift guard: the mirror in src/config/rlm.cjs must equal the registry
  // exported by the vendored verify.js. A change to the implementation that
  // is not mirrored fails here.
  const livePath = path.join(REPO_ROOT, 'backend', 'heavy-think', 'src', 'verify.js');
  if (!fs.existsSync(livePath)) {
    // The published npm package does not ship backend/; the mirror is then
    // the only source and there is nothing to compare against.
    return;
  }
  const live = require(livePath).VERIFICATION_METHOD_NAMES;
  assert.deepEqual(
    [...MIRRORED_IMPLEMENTED_VERIFICATION_METHODS].sort(),
    [...live].sort(),
    'the mirrored implemented-method list has drifted from the verify.js registry'
  );
  assert.deepEqual(
    [...IMPLEMENTED_VERIFICATION_METHODS].sort(),
    [...live].sort(),
    'the resolved implemented-method list must come from the live registry'
  );
});

test('the namespace exposes the documented fields', () => {
  assert.equal(typeof rlmConfig.validate, 'function');
  assert.equal(typeof rlmConfig.warnings, 'function');
  assert.equal(typeof rlmConfig.snapshot, 'function');
  assert.ok(Array.isArray(rlmConfig.warnings()));
  const snapshot = rlmConfig.snapshot();
  assert.equal(snapshot.rlm.forwardedOptions.verification.defaultMethod, 'llm-judge');
  assert.ok(Array.isArray(snapshot.implementedVerificationMethods));
});
