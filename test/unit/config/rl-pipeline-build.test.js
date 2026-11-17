// Tests for the deployed-judge-path build integrity check
// (AWARE card t_091892e3).
//
// The defect this closes: the coordinator's rl-pipeline was cloned from an
// external git server at a pinned tag while the repo carried its own
// vendored copy, and NOTHING compared the two. The deployed image ran a
// 123-line verify.js with no `llm-judge` and a prm.js that concatenated
// the rubric into the user message, while config/rlm.yaml named
// `llm-judge` as the default verification method — the declared default
// never ran once (329,627 of 329,639 live pairs carry
// verification.method == 'none').
//
// These tests cover the runtime half of the fix: the check that the tree
// the coordinator is about to EXECUTE is byte-for-byte the tree that was
// reviewed.
//
// NON-VACUITY: the drift case below uses a fixture whose manifest names a
// file that is then MODIFIED, so the check has exactly one thing it could
// catch and it catches it. A test that only checked "the happy path
// returns ok" would pass with a check that never compares anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const {
  MANIFEST_NAME,
  computeSourceManifest,
  manifestPathFor,
  parseManifest,
  readSourceManifest,
  resolveLiveRlPipelineDirs,
  verifyDeployedJudgePath,
} = require(path.join(REPO_ROOT, 'src', 'config', 'rl-pipeline-build.cjs'));

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Build a fake deployed rl-pipeline tree: src/index.js + src/verify.js,
 * with a manifest describing exactly those files.
 */
function makeTree({ withManifest = true, files = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aware-judge-path-'));
  const src = path.join(root, 'rl-pipeline', 'src');
  fs.mkdirSync(src, { recursive: true });
  const contents = files || {
    'index.js': 'export const x = 1;\n',
    'verify.js': 'export const VERIFICATION_METHOD_NAMES = ["none"];\n',
  };
  for (const [name, body] of Object.entries(contents)) {
    fs.writeFileSync(path.join(src, name), body);
  }
  if (withManifest) {
    const manifest = computeSourceManifest(src);
    const lines = Object.entries(manifest)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([rel, digest]) => `${digest}  ${rel}`);
    fs.writeFileSync(manifestPathFor(src), lines.join('\n') + '\n');
  }
  return { root, src };
}

function cleanup(tree) {
  fs.rmSync(tree.root, { recursive: true, force: true });
}

test('an unmodified tree matches its manifest', () => {
  const tree = makeTree();
  try {
    const result = verifyDeployedJudgePath({
      env: { AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js') },
    });
    assert.equal(result.ok, true, `unexpected problems: ${result.problems.join('; ')}`);
    assert.equal(result.source, 'manifest');
    assert.equal(result.checked, 2);
    assert.deepEqual(result.problems, []);
  } finally {
    cleanup(tree);
  }
});

test('a MODIFIED file is detected — the failure branch', () => {
  // Non-vacuous: the manifest was generated from these exact bytes, and
  // then one file was changed. The check must fail and must name the file.
  const tree = makeTree();
  try {
    fs.writeFileSync(
      path.join(tree.src, 'verify.js'),
      'export const VERIFICATION_METHOD_NAMES = ["none", "llm-judge"];\n'
    );
    const result = verifyDeployedJudgePath({
      env: { AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js') },
    });
    assert.equal(result.ok, false, 'a modified file was not detected');
    assert.equal(result.source, 'manifest');
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /verify\.js does not match the shipped manifest/);
    assert.match(result.problems[0], /expected sha256/);
  } finally {
    cleanup(tree);
  }
});

test('an EXTRA file in the live tree is drift', () => {
  const tree = makeTree();
  try {
    fs.writeFileSync(path.join(tree.src, 'smuggled.js'), 'export const x = 2;\n');
    const result = verifyDeployedJudgePath({
      env: { AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js') },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('; '), /smuggled\.js is present in the live tree but not in the shipped manifest/);
  } finally {
    cleanup(tree);
  }
});

test('a MISSING file is drift', () => {
  const tree = makeTree();
  try {
    fs.unlinkSync(path.join(tree.src, 'verify.js'));
    const result = verifyDeployedJudgePath({
      env: { AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js') },
    });
    assert.equal(result.ok, false);
    assert.match(result.problems.join('; '), /verify\.js is in the manifest but missing from the live tree/);
  } finally {
    cleanup(tree);
  }
});

test('a DEPLOYED tree with no manifest FAILS — the check must not be inert', () => {
  // D3 (Sentinel review of t_091892e3): the deployed tree is the build's
  // own output and the Dockerfile ALWAYS writes the manifest. A deployed
  // tree with no manifest was replaced or patched after the build —
  // exactly the drift this check exists to catch. Reporting ok:true for it
  // makes the check a no-op that claims success, which is the state the
  // live image was in.
  const tree = makeTree({ withManifest: false });
  try {
    const result = verifyDeployedJudgePath({
      env: { AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js') },
    });
    assert.equal(result.ok, false, 'an unmanifested DEPLOYED tree must not report ok');
    assert.equal(result.source, 'unmanifested');
    assert.match(result.problems.join('; '), /carries no SOURCE-SHA256SUMS/);
    assert.match(result.problems.join('; '), /replaced or patched after the build/);
  } finally {
    cleanup(tree);
  }
});

test('no live tree at all is reported as none', () => {
  const result = verifyDeployedJudgePath({
    env: { AWARE_RL_PIPELINE_PATH: '/nonexistent/rl-pipeline/src/index.js' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'none');
});

test('the live tree is resolved from AWARE_RL_PIPELINE_PATH, not from the repo', () => {
  // The check must inspect the DEPLOYED copy. Resolving the repo's
  // vendored copy instead is exactly the bug: the guard passed on the
  // mirror while the deployed build lacked the method.
  const tree = makeTree();
  try {
    const dirs = resolveLiveRlPipelineDirs({
      AWARE_RL_PIPELINE_PATH: path.join(tree.src, 'index.js'),
    });
    assert.equal(dirs[0].path, tree.src);
    assert.equal(dirs[0].source, 'deployed');
  } finally {
    cleanup(tree);
  }
});

test('the manifest parser rejects malformed lines instead of silently dropping them', () => {
  const parsed = parseManifest(
    ['not-a-manifest-line', 'deadbeef  short.js', `${'a'.repeat(64)}  good.js`].join('\n')
  );
  assert.deepEqual(Object.keys(parsed), ['good.js']);
  assert.equal(parsed['good.js'], 'a'.repeat(64));
});

test('readSourceManifest returns null for a directory with no manifest', () => {
  const tree = makeTree({ withManifest: false });
  try {
    assert.equal(readSourceManifest(tree.src), null);
  } finally {
    cleanup(tree);
  }
});

test('the repo vendored copy is computable — the manifest generator has input', () => {
  // The Dockerfile generates the manifest from backend/heavy-think/src.
  // If that directory were empty or absent, the image would ship an empty
  // manifest and the check would be vacuous.
  const vendored = path.join(REPO_ROOT, 'backend', 'heavy-think', 'src');
  const manifest = computeSourceManifest(vendored);
  assert.ok(Object.keys(manifest).length > 0, 'the vendored copy has no source files');
  assert.ok('verify.js' in manifest, 'verify.js is missing from the vendored copy');
  assert.ok('index.js' in manifest, 'index.js is missing from the vendored copy');
  assert.ok('prm.js' in manifest, 'prm.js is missing from the vendored copy');
  // Every digest must be a real sha256 of the file on disk.
  for (const [rel, digest] of Object.entries(manifest)) {
    assert.match(digest, /^[0-9a-f]{64}$/, `${rel} has a malformed digest`);
    assert.equal(sha256(fs.readFileSync(path.join(vendored, rel))), digest, `${rel} digest mismatch`);
  }
});

test('the coordinator Dockerfile ships the vendored copy and writes the manifest', () => {
  // The wiring assertion: without these lines the image would build no
  // rl-pipeline at all (or the wrong one), and the check would have
  // nothing to compare.
  const dockerfile = fs.readFileSync(
    path.join(REPO_ROOT, 'Dockerfile.coordinator'),
    'utf8'
  );
  assert.match(
    dockerfile,
    /COPY backend\/heavy-think\/src \.\/rl-pipeline\/src/,
    'the Dockerfile does not ship the repo vendored rl-pipeline copy'
  );
  assert.match(
    dockerfile,
    /SOURCE-SHA256SUMS/,
    'the Dockerfile does not write the source manifest'
  );
  assert.doesNotMatch(
    dockerfile,
    /git clone .*AWARE_RL_PIPELINE_REPO/,
    'the Dockerfile still clones rl-pipeline from an external git server — that pin is the drift'
  );
});

test('the coordinator Dockerfile ships EVERY src/config module the coordinator imports', () => {
  // D1 (found by the Sentinel review of t_091892e3): the Dockerfile copies
  // src/config FILE BY FILE, so a module that is imported but not COPYed
  // is simply ABSENT from /app/src/config — and the coordinator then fails
  // to START with ERR_MODULE_NOT_FOUND. The check module
  // (src/config/rl-pipeline-build.cjs) was imported by http-server.js and
  // not shipped, so the image this card builds would not have booted.
  //
  // This test is derived from the imports, not from a hand-written list:
  // it scans src/coordinator/*.js for `../config/<name>` imports and
  // asserts the Dockerfile COPYs each one. Adding a new config module and
  // forgetting the Dockerfile fails here rather than in production.
  const dockerfile = fs.readFileSync(
    path.join(REPO_ROOT, 'Dockerfile.coordinator'),
    'utf8'
  );

  const coordinatorDir = path.join(REPO_ROOT, 'src', 'coordinator');
  const coordinatorFiles = fs
    .readdirSync(coordinatorDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(coordinatorDir, e.name));

  const imported = new Set();
  for (const file of coordinatorFiles) {
    const body = fs.readFileSync(file, 'utf8');
    const re = /from\s+['"]\.\.\/config\/([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      imported.add(m[1]);
    }
  }

  assert.ok(
    imported.size > 0,
    'no ../config imports found in src/coordinator — the scan is broken, so this test proves nothing'
  );
  assert.ok(
    imported.has('rl-pipeline-build.cjs'),
    'the deployed-judge-path check module is not imported by the coordinator — the scan found nothing to check'
  );

  for (const mod of imported) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, 'src', 'config', mod)),
      `src/config/${mod} is imported by the coordinator but does not exist in the repo`
    );
    assert.match(
      dockerfile,
      new RegExp(`COPY src/config/${mod.replace(/\./g, '\\.')} `),
      `the Dockerfile does not ship src/config/${mod} — the coordinator would fail to start with ERR_MODULE_NOT_FOUND`
    );
  }
});
