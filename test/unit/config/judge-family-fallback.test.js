// test/unit/config/judge-family-fallback.test.js — the CommonJS MIRROR's
// own algorithm, and the resolver that decides whether the mirror or the
// canonical producer module is the implementation in use (kanban
// t_8b44fe9d).
//
// WHY THIS FILE EXISTS
// --------------------
// `src/config/judge-family.cjs` is a MIRROR of the producer's canonical
// model-family map (`backend/heavy-think/src/judge-family.js`). The mirror
// prefers the live canonical module when it can find one, and falls back to
// its own rule tables when it cannot.
//
// Two defects made the fallback invisible to the suite:
//
//  1. THE RESOLVER COULD NOT REACH THE CANONICAL MODULE IN THE DEPLOYED
//     IMAGE. It looked only for `<repo>/backend/heavy-think/src/
//     judge-family.js`, but the coordinator image ships that file at
//     `/app/rl-pipeline/src/judge-family.js` and has no `/app/backend` at
//     all. Measured in the running container before this fix:
//       $ docker exec aware-2-coordinator node -e \
//           "console.log(require('/app/src/config/judge-family.cjs').resolveFamilyModule())"
//       null
//     So in PRODUCTION the config-time guard ran the MIRROR while the
//     runtime guard ran the canonical module: two independent
//     implementations of the same rule.
//
//  2. THE DRIFT TEST NEVER EXERCISED THE MIRROR'S OWN ALGORITHM. It
//     compared `mirror.sameModelFamily(a,b)` against
//     `producer.sameModelFamily(a,b)` — but in a tree where the canonical
//     copy is present, the mirror DELEGATES to it, so the comparison was
//     live-vs-live and could only detect a drift in the rule TABLES (which
//     is checked separately). The mirror's own algorithm — its lineage
//     fallback, its prefix threshold — was never executed.
//
// MEASURED, ON `main` BEFORE THIS FIX (worktree-isolated, vendored copy
// present):
//   mutation to src/config/judge-family.cjs            | result
//   -------------------------------------------------- | -----------------
//   `leadingLineage` -> returns ''                      | 150 pass, 2 fail
//   `sameModelFamily` prefix threshold `>= 3` -> `>= 6` | 152 pass, 0 FAIL
//   `sameModelFamily` -> `return false`                 | 152 pass, 0 FAIL
// The last two rows are the finding: mutations that change the fallback's
// behaviour were INVISIBLE to the suite.
//
// WHAT THIS FILE ASSERTS
// ----------------------
//  - the resolver finds the canonical module in the DEPLOYED layout
//    (`<app>/rl-pipeline/src/judge-family.js`), not only in the repo layout;
//  - `resolveFamilyModule()` is `null` in a fallback layout (no canonical
//    module in ANY known layout) and non-null in the vendored layout;
//  - the mirror's OWN algorithm agrees with the producer over the id
//    matrix — so a table OR an algorithm drift is caught on both sides;
//  - a `require()` failure is NOT silent: the reason is recorded, warned
//    about, and surfaced through `config.warnings()`;
//  - NON-VACUITY: the drift check is proved load-bearing by mutating a COPY
//    of the mirror and showing the check fails against it.
//
// The mutation harness below reads the mirror's SOURCE and edits a COPY of
// it in a temp directory. It never edits the repo's mirror.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIRROR_PATH = path.join(REPO_ROOT, 'src', 'config', 'judge-family.cjs');
const PRODUCER_PATH = path.join(
  REPO_ROOT, 'backend', 'heavy-think', 'src', 'judge-family.js'
);

const mirror = require(MIRROR_PATH);

// The mirror's OWN rule-driven implementation. `mirror.resolveModelFamily`
// delegates to the live canonical module whenever it is present, so these
// are the ONLY entry points that exercise the mirrored ALGORITHM itself.
const mirrorResolve = (model) =>
  mirror.resolveModelFamilyFromRules(model, mirror.MIRRORED_MODEL_FAMILY_RULES);

// The id matrix the drift check is drawn from. It spans every declared
// family, the corpus-trained artefact, provider-prefixed ids, lineage-only
// ids, and the unnameable ids.
//
// The LINEAGE ids are the ones that exercise the prefix threshold. A
// lineage that is a PREFIX of a declared family — `gem-2` (lineage `gem`)
// against `gemini-3-pro` (family `gemini`), `min-1` against `minimax`,
// `clau-1` against `claude`, and so on — is the only shape where
// `sameModelFamily`'s `shorter.length >= 3` rule can change the verdict.
// Without them the threshold is unobservable, which is exactly why
// mutating it (`>= 3` -> `>= 6`) passed the whole suite before this fix.
const ID_MATRIX = [
  'MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M3.1', 'minimax-M3.1-Flash',
  'minimax m3 1 flash', 'aware-qwen35-9b', 'aware-qwen35-9b:latest',
  'aware-qwen35-9b-q4_k_m', 'qwen3-8b', 'qwen2.5:7b', 'claude-opus-4',
  'anthropic/claude-opus-4', 'gpt-5-judge', 'gpt-4o', 'o3-mini',
  'gemini-3-pro', 'google/gemini-3-pro', 'google/gemma-2-9b', 'gemma-2-9b',
  'deepseek-v3', 'mock-model-1', 'fake', 'meta-llama/llama-3.3-70b',
  'llama-3.3-70b', 'x-ai/grok-4', '01-ai/yi-34b', 'meta-llama/', '', undefined,
  null, 42,
  // LINEAGE ids whose lineage is a PREFIX of a declared family — these are
  // the ids that make the prefix threshold observable.
  'gem-2', 'min-1', 'llam-3', 'deeps-1', 'clau-1', 'kim-1', 'gro-1',
  'nou-1', 'mis-1', 'mix-1', 'cod-1', 'gpt-5', 'qwe-1', 'glm-1', 'gemma-3',
  'phi-3', 'herm-1', 'ant-1', 'o3', 'chat-1',
];

// ─── helpers: build a synthetic deployment tree ──────────────────────────

/**
 * Materialise a tree shaped like a coordinator deployment.
 *
 * The layout mirrors the image: the mirror sits at `<root>/app/src/config/
 * judge-family.cjs` and the canonical module (when present) at
 * `<root>/app/rl-pipeline/src/judge-family.js`. `<root>/rl-pipeline/` is
 * left EMPTY so the resolver's `dev-layout` candidate cannot resolve to
 * anything — the fallback assertion must be about the absence of the
 * canonical module, not about a stray sibling checkout.
 *
 * @param {Object} opts
 * @param {boolean} opts.withCanonical ship the canonical module
 * @param {string} [opts.canonicalBody] the canonical module's body
 * @returns {{root: string, appDir: string, mirrorPath: string, canonicalPath: string}}
 */
function buildTree(opts = {}) {
  // `fs.realpathSync` because macOS's /tmp is a symlink to /private/tmp:
  // the resolver resolves its candidate paths, so a symlinked temp dir
  // would make the assertions compare two spellings of the same path.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aware-jf-')));
  const appDir = path.join(root, 'app');
  const configDir = path.join(appDir, 'src', 'config');
  const rlDir = path.join(appDir, 'rl-pipeline', 'src');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(rlDir, { recursive: true });

  // The image's /app/package.json declares ESM for the coordinator source.
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ type: 'module', name: 'aware-coordinator', private: true })
  );
  // The rl-pipeline package carries its own manifest (type: module).
  fs.writeFileSync(
    path.join(appDir, 'rl-pipeline', 'package.json'),
    JSON.stringify({ name: 'heavy-think', type: 'module' })
  );

  const mirrorDest = path.join(configDir, 'judge-family.cjs');
  fs.copyFileSync(MIRROR_PATH, mirrorDest);

  const canonicalPath = path.join(rlDir, 'judge-family.js');
  if (opts.withCanonical) {
    const body =
      opts.canonicalBody !== undefined
        ? opts.canonicalBody
        : fs.readFileSync(PRODUCER_PATH, 'utf8');
    fs.writeFileSync(canonicalPath, body);
  }

  return { root, appDir, mirrorPath: mirrorDest, canonicalPath };
}

// ─── the resolver reaches the canonical module in the DEPLOYED layout ────

test('judge-family: the resolver finds the canonical module in the DEPLOYED layout', (t) => {
  // THE case this card exists for. The coordinator image ships the
  // canonical module at /app/rl-pipeline/src/judge-family.js and has no
  // /app/backend at all, so the old resolver (which looked only at
  // <repo>/backend/heavy-think/src) found nothing and the config-time
  // guard silently ran the MIRROR while the runtime guard ran the
  // canonical module.
  const tree = buildTree({ withCanonical: true });
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  const deployed = require(tree.mirrorPath);
  const resolution = deployed.familyModuleResolution({ fresh: true });

  assert.equal(
    resolution.reasonCode,
    'resolved',
    `the deployed layout must resolve the canonical module (${resolution.reason})`
  );
  assert.equal(resolution.source, 'live');
  assert.equal(resolution.module !== null, true);
  assert.equal(
    resolution.path,
    tree.canonicalPath,
    'the resolver must pick the DEPLOYED copy, not some other tree'
  );
  assert.equal(resolution.candidate.source, 'deployed-layout');

  // And the live module is the one that answers.
  assert.equal(
    deployed.resolveModelFamily('MiniMax-M3.1-Flash').family,
    'minimax'
  );
});

test('judge-family: AWARE_RL_PIPELINE_PATH points the resolver at the DEPLOYED tree', (t) => {
  // The coordinator image sets AWARE_RL_PIPELINE_PATH=/app/rl-pipeline/src/
  // index.js. The resolver must follow it to the sibling judge-family.js,
  // exactly as the coordinator's other live-tree resolvers do
  // (src/config/rlm.cjs, src/config/rl-pipeline-build.cjs).
  const tree = buildTree({ withCanonical: true });
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  const deployed = require(tree.mirrorPath);
  const env = {
    AWARE_RL_PIPELINE_PATH: path.join(tree.appDir, 'rl-pipeline', 'src', 'index.js'),
  };
  const resolution = deployed.familyModuleResolution({ env, fresh: true });

  assert.equal(resolution.reasonCode, 'resolved');
  assert.equal(resolution.candidate.source, 'deployed');
  assert.equal(resolution.path, tree.canonicalPath);
});

test('judge-family: the resolver still finds the REPO layout copy', (t) => {
  // The repo layout (a source checkout, and the test-suite's tree) must
  // keep working: the vendored copy is the canonical module there.
  const tree = buildTree({ withCanonical: false });
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  // Put the canonical module where the REPO layout expects it.
  const vendored = path.join(tree.appDir, 'backend', 'heavy-think', 'src');
  fs.mkdirSync(vendored, { recursive: true });
  fs.copyFileSync(PRODUCER_PATH, path.join(vendored, 'judge-family.js'));

  const deployed = require(tree.mirrorPath);
  const resolution = deployed.familyModuleResolution({ fresh: true });

  assert.equal(resolution.reasonCode, 'resolved');
  assert.equal(resolution.candidate.source, 'vendored');
  assert.equal(resolution.path, path.join(vendored, 'judge-family.js'));
});

// ─── the fallback layout is provably taken ───────────────────────────────

test('judge-family: resolveFamilyModule() is NULL in the fallback layout', (t) => {
  // The negative case: with no canonical module in ANY known layout, the
  // mirror must be the implementation, and the resolver must say so.
  const tree = buildTree({ withCanonical: false });
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  const deployed = require(tree.mirrorPath);
  const resolution = deployed.familyModuleResolution({ fresh: true });

  assert.equal(deployed.resolveFamilyModule({ fresh: true }), null);
  assert.equal(resolution.module, null);
  assert.equal(resolution.source, 'mirror');
  assert.equal(resolution.reasonCode, 'absent');
  assert.match(resolution.reason, /no canonical model-family module was found/);
});

test('judge-family: resolveFamilyModule() is NON-NULL in the vendored layout', () => {
  // The positive case: the repo's own tree resolves the canonical module.
  const live = mirror.resolveFamilyModule();
  assert.notEqual(live, null, 'the repo layout must resolve the canonical module');
  assert.equal(typeof live.resolveModelFamily, 'function');

  const resolution = mirror.familyModuleResolution({ fresh: true });
  assert.equal(resolution.reasonCode, 'resolved');
  assert.equal(resolution.source, 'live');
});

test('judge-family: the FALLBACK layout answers with the mirror own algorithm', (t) => {
  // In the fallback layout the mirror's OWN rules must answer — and they
  // must answer the SAME as the canonical module. This is the assertion
  // that was missing: the fallback path was exercised only as a one-off
  // measurement, never encoded.
  const tree = buildTree({ withCanonical: false });
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  const deployed = require(tree.mirrorPath);
  assert.equal(deployed.resolveFamilyModule({ fresh: true }), null);

  // The fallback answers.
  assert.equal(deployed.modelFamily('MiniMax-M3.1-Flash'), 'minimax');
  assert.equal(deployed.sameModelFamily('MiniMax-M3.1-Flash', 'MiniMax-M3'), true);
  assert.equal(deployed.isIndependentJudge('MiniMax-M3.1-Flash', 'MiniMax-M3'), false);
  assert.equal(deployed.isIndependentJudge('MiniMax-M3.1-Flash', 'claude-opus-4'), true);

  // And it agrees with the canonical module over the whole id matrix.
  if (!fs.existsSync(PRODUCER_PATH)) return;
  const producer = require(PRODUCER_PATH);
  for (const id of ID_MATRIX) {
    assert.equal(
      deployed.modelFamily(id),
      producer.modelFamily(id),
      `the fallback layout resolved ${JSON.stringify(id)} differently from the canonical module`
    );
  }
});

// ─── a require() failure is not silent ───────────────────────────────────

test('judge-family: a canonical module that cannot be loaded is SURFACED, not silent', (t) => {
  // A canonical module that EXISTS but cannot be loaded (a syntax error, or
  // an ES module on a runtime below Node 22.12) used to be swallowed by a
  // bare `catch {}` — the guard then ran the mirror with no indication
  // that the canonical implementation was unavailable.
  const tree = buildTree({
    withCanonical: true,
    canonicalBody: 'this is not valid javascript ((',
  });
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  const deployed = require(tree.mirrorPath);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let resolution;
  try {
    resolution = deployed.familyModuleResolution({ fresh: true });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(resolution.module, null);
  assert.equal(resolution.source, 'mirror');
  assert.equal(resolution.reasonCode, 'load-failed');
  assert.match(resolution.reason, /could not be loaded/);
  assert.match(resolution.reason, /MIRRORED family map/);
  assert.match(resolution.reason, /judge-family\.js/);

  // The reason is warned about — NOT silent.
  assert.ok(
    warnings.some((w) => /judge-family/.test(w) && /could not be loaded/.test(w)),
    `the load failure must be warned about (warnings: ${JSON.stringify(warnings)})`
  );
});

test('judge-family: config.warnings() reports a judge-family load failure', (t) => {
  // The config layer must surface the reason, so an operator reading the
  // boot warnings can see that the judge guard is running the mirror.
  const tree = buildTree({
    withCanonical: true,
    canonicalBody: 'this is not valid javascript ((',
  });
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  const brokenPath = path.join(tree.root, 'broken', 'judge-family.js');
  fs.mkdirSync(path.dirname(brokenPath), { recursive: true });
  fs.copyFileSync(tree.canonicalPath, brokenPath);

  const originalWarn = console.warn;
  console.warn = () => {};
  const previousEnv = process.env.AWARE_RL_PIPELINE_PATH;
  try {
    process.env.AWARE_RL_PIPELINE_PATH = path.join(tree.root, 'broken', 'index.js');
    mirror.resetFamilyModuleCache();
    const config = require(path.join(REPO_ROOT, 'src', 'config', 'index.cjs'));
    const warnings = config.warnings();
    assert.ok(
      warnings.some((w) => /judge-family/.test(w) && /could not be loaded/.test(w)),
      `config.warnings() must report the judge-family load failure (warnings: ${JSON.stringify(warnings)})`
    );
  } finally {
    console.warn = originalWarn;
    if (previousEnv === undefined) delete process.env.AWARE_RL_PIPELINE_PATH;
    else process.env.AWARE_RL_PIPELINE_PATH = previousEnv;
    mirror.resetFamilyModuleCache();
  }
});

// ─── the mirror's OWN algorithm agrees with the canonical module ─────────

test('judge-family: the MIRROR own algorithm agrees with the canonical module over the id matrix', () => {
  // THE drift check, made load-bearing. Before t_8b44fe9d the drift test
  // compared `mirror.sameModelFamily` against `producer.sameModelFamily` —
  // but the mirror delegates to the producer whenever the canonical copy is
  // present, so the comparison was live-vs-live and the mirror's own
  // algorithm was never executed.
  if (!fs.existsSync(PRODUCER_PATH)) {
    // The published npm package ships src/config/ but NOT backend/.
    assert.ok(true, 'the canonical producer copy is not present in this tree');
    return;
  }
  const producer = require(PRODUCER_PATH);

  for (const id of ID_MATRIX) {
    assert.deepEqual(
      mirrorResolve(id),
      producer.resolveModelFamily(id),
      `the mirror's own resolver drifted from the canonical module on ${JSON.stringify(id)}`
    );
  }

  for (const a of ID_MATRIX) {
    for (const b of ID_MATRIX) {
      assert.equal(
        mirror.sameModelFamilyFromRules(a, b),
        producer.sameModelFamily(a, b),
        `the mirror's own same-family rule drifted on (${JSON.stringify(a)}, ${JSON.stringify(b)})`
      );
      assert.equal(
        mirror.isIndependentJudgeFromRules(a, b),
        producer.isIndependentJudge(a, b),
        `the mirror's own independence rule drifted on (${JSON.stringify(a)}, ${JSON.stringify(b)})`
      );
    }
  }
});

test('judge-family: the mirror PUBLIC surface agrees with the canonical module over the id matrix', () => {
  // `mirror.sameModelFamily` and `mirror.isIndependentJudge` resolve through
  // the canonical module when it is present, but apply the MIRROR's own
  // comparison rule on top of it (the prefix threshold). So the public
  // surface is a MIX of the two implementations, and it must agree with the
  // canonical module outright.
  //
  // This is the check that catches a mutation of the mirror's own prefix
  // threshold through the PUBLIC surface: the mirror's threshold and the
  // canonical module's threshold are separate code, so a change to one
  // shows up as a disagreement here.
  if (!fs.existsSync(PRODUCER_PATH)) return;
  const producer = require(PRODUCER_PATH);

  for (const a of ID_MATRIX) {
    for (const b of ID_MATRIX) {
      assert.equal(
        mirror.sameModelFamily(a, b),
        producer.sameModelFamily(a, b),
        `the mirror's public surface drifted from the canonical module on (${JSON.stringify(a)}, ${JSON.stringify(b)})`
      );
      assert.equal(
        mirror.isIndependentJudge(a, b),
        producer.isIndependentJudge(a, b),
        `the mirror's public independence rule drifted from the canonical module on (${JSON.stringify(a)}, ${JSON.stringify(b)})`
      );
    }
  }
});

test('judge-family: the mirror own RESOLUTION agrees with the public surface resolution', () => {
  // The rule-driven variants must agree with the public surface whenever
  // the canonical module IS present — otherwise the two implementations
  // would drift apart silently, which is exactly the condition t_2a91cc4b
  // set out to remove.
  //
  // NOTE: this compares the two RESOLUTION paths (mirrored rules vs the
  // canonical module's rules). It deliberately does NOT claim to catch a
  // mutation of the mirror's own comparison RULE — both paths share the
  // same threshold function, so they would move together. The check above
  // is the one that catches that.
  if (!fs.existsSync(PRODUCER_PATH)) return;

  for (const a of ID_MATRIX) {
    for (const b of ID_MATRIX) {
      assert.equal(
        mirror.sameModelFamilyFromRules(a, b),
        mirror.sameModelFamily(a, b),
        `the mirror's own rule and the live-resolving public surface disagree on (${JSON.stringify(a)}, ${JSON.stringify(b)})`
      );
      assert.equal(
        mirror.isIndependentJudgeFromRules(a, b),
        mirror.isIndependentJudge(a, b),
        `the mirror's own independence rule and the live-resolving public surface disagree on (${JSON.stringify(a)}, ${JSON.stringify(b)})`
      );
    }
  }
});

// ─── NON-VACUITY: the drift check is load-bearing ────────────────────────

test('judge-family: NON-VACUITY — a mutated mirror FAILS the drift check', (t) => {
  // The proof that the checks above are not vacuous: take a COPY of the
  // mirror, break its prefix threshold, and show the drift check rejects
  // it. Before t_8b44fe9d this mutation passed the WHOLE suite.
  if (!fs.existsSync(PRODUCER_PATH)) return;
  const producer = require(PRODUCER_PATH);

  const tree = buildTree({ withCanonical: false });
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  const source = fs.readFileSync(MIRROR_PATH, 'utf8');
  const mutated = source.replace(
    'return shorter.length >= 3 && longer.startsWith(shorter);',
    'return shorter.length >= 6 && longer.startsWith(shorter);'
  );
  assert.notEqual(mutated, source, 'the mutation must actually change the mirror');

  const mutatedPath = path.join(tree.appDir, 'src', 'config', 'judge-family.cjs');
  fs.writeFileSync(mutatedPath, mutated);
  const mutatedMirror = require(mutatedPath);

  // The mutated mirror's OWN algorithm now disagrees with the canonical
  // module — so the drift check above WOULD reject it.
  let disagreed = false;
  for (const a of ID_MATRIX) {
    for (const b of ID_MATRIX) {
      if (
        mutatedMirror.sameModelFamilyFromRules(a, b) !== producer.sameModelFamily(a, b)
      ) {
        disagreed = true;
        break;
      }
    }
    if (disagreed) break;
  }
  assert.ok(
    disagreed,
    'a mutated mirror must be caught by the drift check — otherwise the check is vacuous'
  );

  // NEGATIVE CONTROL: the unmutated mirror does NOT disagree.
  assert.equal(
    mirror.sameModelFamilyFromRules('MiniMax-M3.1-Flash', 'minimax-M3'),
    producer.sameModelFamily('MiniMax-M3.1-Flash', 'minimax-M3'),
    'the unmutated mirror must agree with the canonical module'
  );
});

test('judge-family: NON-VACUITY — a dead lineage fallback FAILS the drift check', (t) => {
  // The second mutation from the card's measurement: `leadingLineage` ->
  // '' kills the lineage fallback. The drift check must reject it.
  if (!fs.existsSync(PRODUCER_PATH)) return;
  const producer = require(PRODUCER_PATH);

  const tree = buildTree({ withCanonical: false });
  t.after(() => fs.rmSync(tree.root, { recursive: true, force: true }));

  const source = fs.readFileSync(MIRROR_PATH, 'utf8');
  const mutated = source.replace(
    '  const match = /^[a-z]+/.exec(normalisedId);\n  return match ? match[0] : \'\';',
    '  const match = /^[a-z]+/.exec(normalisedId);\n  return \'\';'
  );
  assert.notEqual(mutated, source, 'the mutation must actually change the mirror');

  const mutatedPath = path.join(tree.appDir, 'src', 'config', 'judge-family.cjs');
  fs.writeFileSync(mutatedPath, mutated);
  const mutatedMirror = require(mutatedPath);

  let disagreed = false;
  for (const id of ID_MATRIX) {
    if (mutatedMirror.resolveModelFamilyFromRules(id, mutatedMirror.MIRRORED_MODEL_FAMILY_RULES).family
      !== producer.resolveModelFamily(id).family) {
      disagreed = true;
      break;
    }
  }
  assert.ok(
    disagreed,
    'a dead lineage fallback must be caught by the drift check — otherwise the check is vacuous'
  );
});
