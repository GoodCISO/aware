// Tests for the LIVE resolution of the implemented verification methods
// (AWARE card t_091892e3).
//
// The defect this closes: src/config/rlm.cjs resolved the method registry
// from the repo's vendored copy FIRST and fell back to a hard-coded MIRROR
// when that copy was absent. In the container the repo copy does not exist,
// so the guard silently checked the mirror — a list claiming `llm-judge` is
// implemented while the deployed verify.js had no `llm-judge` at all. The
// guard passed on exactly the build that broke.
//
// NON-VACUITY: the failure-branch test below builds a fixture verify.js
// that genuinely has NO VERIFICATION_METHOD_NAMES export and asserts the
// loader THROWS rather than falling back to the mirror. A test that only
// asserted the happy path would pass against the old fallback behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const rlmConfig = require(path.join(REPO_ROOT, 'src', 'config', 'rlm.cjs'));
const {
  liveVerifyJsCandidates,
  resolveImplementedVerificationMethods,
  getImplementedVerificationMethods,
} = rlmConfig;

const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'rlm.yaml');
const SCHEMA_PATH = path.join(REPO_ROOT, 'config', 'rlm.schema.json');

/**
 * Build a fake deployed rl-pipeline tree whose verify.js either exports a
 * registry or deliberately does not.
 */
function makeTree(verifySource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aware-registry-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'index.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(src, 'verify.js'), verifySource);
  return { root, src };
}

test('the DEPLOYED tree is the first candidate, ahead of the repo copy', () => {
  // Ordering is the whole fix: if the repo copy wins, the guard checks a
  // tree that is not the one the coordinator runs.
  const candidates = liveVerifyJsCandidates({
    AWARE_RL_PIPELINE_PATH: '/app/rl-pipeline/src/index.js',
  });
  assert.equal(candidates[0].source, 'deployed');
  assert.equal(candidates[0].path, '/app/rl-pipeline/src/verify.js');
  assert.ok(
    candidates.some((c) => c.source === 'vendored'),
    'the vendored copy must still be a candidate (the dev/test layout)'
  );
});

test('the registry is read from the DEPLOYED copy, not the repo mirror', () => {
  const tree = makeTree(
    'export const VERIFICATION_METHOD_NAMES = ["none", "llm-judge", "deployed-only"];\n'
  );
  try {
    const names = resolveImplementedVerificationMethods({
      AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js'),
    });
    assert.deepEqual([...names].sort(), ['deployed-only', 'llm-judge', 'none']);
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('a deployed verify.js with NO registry THROWS instead of falling back to the mirror', () => {
  // This is the failure branch that the deployed image actually hit: a
  // verify.js from before VERIFICATION_METHOD_NAMES existed. The old code
  // fell back to MIRRORED_IMPLEMENTED_VERIFICATION_METHODS, which lists
  // 'llm-judge' — so the guard passed while the deployed build could not
  // service it. Now it must be a hard failure.
  const tree = makeTree('export async function verify() { return { passed: true }; }\n');
  try {
    assert.throws(
      () =>
        resolveImplementedVerificationMethods({
          AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js'),
        }),
      (err) => {
        assert.match(err.message, /could not be introspected/);
        assert.match(err.message, /does not export VERIFICATION_METHOD_NAMES/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('the loader guard REJECTS a config whose default the deployed tree cannot service', () => {
  // End-to-end through loadRlmConfig: the deployed tree implements only
  // ['none'], the config names 'llm-judge' as the default — the boot must
  // fail with the actionable message, naming the offending method and the
  // implemented set.
  const tree = makeTree('export const VERIFICATION_METHOD_NAMES = ["none"];\n');
  try {
    assert.throws(
      () =>
        rlmConfig.loadRlmConfig({
          configPath: CONFIG_PATH,
          schemaPath: SCHEMA_PATH,
          env: { AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js') },
        }),
      (err) => {
        assert.match(err.message, /defaultMethod is 'llm-judge', which has no implementation/);
        assert.match(err.message, /Implemented verification methods: none/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('the loader guard ACCEPTS a config the deployed tree can service', () => {
  // The positive branch of the same guard, against a deployed tree that
  // implements the configured methods.
  const tree = makeTree(
    'export const VERIFICATION_METHOD_NAMES = ["exec", "llm-judge", "none"];\n'
  );
  try {
    const loaded = rlmConfig.loadRlmConfig({
      configPath: CONFIG_PATH,
      schemaPath: SCHEMA_PATH,
      env: { AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js') },
    });
    assert.equal(loaded.config.rlm.forwardedOptions.verification.defaultMethod, 'llm-judge');
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('getImplementedVerificationMethods accepts an explicit env', () => {
  const tree = makeTree('export const VERIFICATION_METHOD_NAMES = ["only-this"];\n');
  try {
    const names = getImplementedVerificationMethods({
      env: { AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js') },
    });
    assert.deepEqual([...names], ['only-this']);
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('the repo vendored copy still resolves and includes llm-judge', () => {
  // The dev/test layout has no sibling checkout on this machine, so the
  // vendored copy is what resolves — and it must agree with the config.
  const names = getImplementedVerificationMethods();
  assert.ok(names.includes('llm-judge'), 'the vendored registry must implement llm-judge');
  assert.ok(names.includes('none'));
});
