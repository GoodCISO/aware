// Tests that the RLM verification-method guard fires at BOOT time.
//
// AWARE card t_0ff3a7b9, AC3: "A config that names an unimplemented method
// is rejected at load, not at first use."
//
// The loader (src/config/rlm.cjs) is what enforces the guard, but a loader
// nobody calls at startup is an inert guard — the same class of defect as
// the original one (a config nobody read). So this file asserts the WIRING:
// the coordinator's boot path validates the RLM configuration, and a config
// naming an unimplemented method stops the boot instead of failing later
// on an RLM leaf.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const RLM_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'rlm.yaml');
const RLM_SCHEMA_PATH = path.join(REPO_ROOT, 'config', 'rlm.schema.json');
const HTTP_SERVER_PATH = path.join(REPO_ROOT, 'src', 'coordinator', 'http-server.js');

test('the coordinator boot path validates the RLM configuration', () => {
  // The wiring assertion: if this ever stops holding, the guard becomes
  // inert again and the defect returns in a new shape.
  const source = fs.readFileSync(HTTP_SERVER_PATH, 'utf8');
  assert.match(
    source,
    /import rlmConfig from '\.\.\/config\/rlm\.cjs'/,
    'the coordinator no longer imports the RLM config loader'
  );
  assert.match(
    source,
    /rlmConfig\.validate\(\)/,
    'the coordinator boot path no longer validates the RLM configuration'
  );
});

test('an invalid RLM config fails validation (what the boot path calls)', () => {
  const rlmConfig = require(path.join(REPO_ROOT, 'src', 'config', 'rlm.cjs'));
  const { loadRlmConfig } = rlmConfig;

  // Build a config on disk that names a method with no implementation,
  // exactly as a mis-edited config/rlm.yaml would.
  const yaml = require('js-yaml');
  const raw = yaml.load(fs.readFileSync(RLM_CONFIG_PATH, 'utf8'));
  raw.rlm.forwardedOptions.verification.defaultMethod = 'llm-judge-v2';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aware-rlm-guard-'));
  const badPath = path.join(tmpDir, 'rlm.yaml');
  fs.writeFileSync(badPath, yaml.dump(raw));

  try {
    assert.throws(
      () => loadRlmConfig({ configPath: badPath, schemaPath: RLM_SCHEMA_PATH }),
      (err) => {
        assert.match(err.message, /defaultMethod is 'llm-judge-v2', which has no implementation/);
        assert.match(err.message, /Implemented verification methods:/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an absent RLM config is not a boot failure', () => {
  // A deployment that does not ship config/rlm.yaml has simply not enabled
  // the RLM. That must not stop the coordinator from booting — otherwise
  // wiring the loader in would be a regression for every deployment that
  // does not use the RLM.
  const rlmConfig = require(path.join(REPO_ROOT, 'src', 'config', 'rlm.cjs'));
  const { loadRlmConfig } = rlmConfig;

  assert.throws(
    () =>
      loadRlmConfig({
        configPath: path.join(REPO_ROOT, 'config', 'does-not-exist.yaml'),
        schemaPath: RLM_SCHEMA_PATH,
      }),
    (err) => {
      assert.equal(err.code, 'RLM_CONFIG_MISSING');
      return true;
    }
  );
});

test('the coordinator Dockerfile ships the RLM loader and config', () => {
  const dockerfile = fs.readFileSync(
    path.join(REPO_ROOT, 'Dockerfile.coordinator'),
    'utf8'
  );
  assert.match(dockerfile, /COPY src\/config\/rlm\.cjs/, 'the loader is not copied into the build stage');
  assert.match(dockerfile, /COPY config\/rlm\.yaml/, 'config/rlm.yaml is not copied into the build stage');
  assert.match(
    dockerfile,
    /COPY config\/rlm\.schema\.json/,
    'config/rlm.schema.json is not copied into the build stage'
  );
});
