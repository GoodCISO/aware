// test/unit/config/judge-family.test.js — the model-FAMILY comparison behind
// the judge independence rule (kanban t_2a91cc4b).
//
// WHY THIS FILE EXISTS
// --------------------
// t_155a95a1 computed `prm_score_independent` by comparing the judge's
// model ID with the candidate's model ID FOR EQUALITY. That is too narrow:
// it catches the identical id and nothing else, so a CHEAPER SIBLING from
// the same family — `MiniMax-M3` judging `MiniMax-M3.1-Flash` — was declared
// independent and was allowed to GATE the DPO set.
//
// t_89720a07 added the SECOND copy of that comparison, in
// `src/config/index.cjs` (the config-time guard), with no drift check
// against the producer's module. So there were two id-equality guards and
// both were too narrow.
//
// The rule being enforced:
//   "If judge and candidate share a model family, the judge is grading its
//    own house style." (04-ai-product-evaluation.md:157-160)
//   "Same family -> the verdict is a DIAGNOSTIC, never a launch gate."
//   (04:187-190)
// and audit t_8f049433 §5.1 ("What must NOT count as independence") names
// "a cheaper sibling" explicitly.
//
// Every assertion below is NON-VACUOUS: the sibling case is the artefact the
// sweep WOULD remove, so the suite fails against the id-equality
// implementation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');

const PRODUCER_FAMILY_MODULE = path.join(
  REPO_ROOT, 'backend', 'heavy-think', 'src', 'judge-family.js'
);
const PRODUCER_ROLE_MODULE = path.join(
  REPO_ROOT, 'backend', 'heavy-think', 'src', 'judge-role.js'
);

const mirror = require(path.join(REPO_ROOT, 'src', 'config', 'judge-family.cjs'));

const CANDIDATE = 'MiniMax-M3.1-Flash';

// -- the mirror resolves the same families as the producer ------------------

test('judge-family: the mirror resolves the family of a model id', () => {
  assert.equal(mirror.modelFamily('MiniMax-M3.1-Flash'), 'minimax');
  assert.equal(mirror.modelFamily('minimax-M3'), 'minimax');
  assert.equal(mirror.modelFamily('claude-opus-4'), 'claude');
  assert.equal(mirror.modelFamily('gpt-5-judge'), 'gpt');
  assert.equal(mirror.modelFamily('qwen3-8b'), 'qwen');
});

test('judge-family: the mirror treats a CHEAPER SIBLING as the same family', () => {
  // THE case this card exists for. Against the id-equality implementation
  // this returned false and the sibling was allowed to gate.
  assert.equal(mirror.sameModelFamily(CANDIDATE, 'MiniMax-M3'), true);
  assert.equal(mirror.sameModelFamily(CANDIDATE, 'MiniMax-M3.1'), true);
  assert.equal(mirror.sameModelFamily(CANDIDATE, 'minimax-M3.1-Flash'), true);
});

test('judge-family: the mirror agrees with the producer on every case', () => {
  // The drift check: the config-time guard and the runtime guard must not
  // disagree, or the config accepts a judge the producer then treats as
  // same-family.
  //
  // NOTE: this compares the PUBLIC SURFACE against the producer. It is
  // kept as the coarse check it always was. The LOAD-BEARING check — the
  // one that exercises the MIRROR'S OWN algorithm rather than the module it
  // delegates to — lives in `judge-family-fallback.test.js`
  // (t_8b44fe9d): with the vendored copy present, this test alone could
  // not detect a mutation of the mirror's own rule logic, because the
  // mirror delegates to the producer.
  if (!fs.existsSync(PRODUCER_FAMILY_MODULE)) {
    // The published npm package ships src/config/ but NOT backend/.
    assert.ok(true, 'the vendored producer copy is not present in this tree');
    return;
  }
  const producer = require(PRODUCER_FAMILY_MODULE);

  const ids = [
    'MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M3.1', 'minimax-M3.1-Flash',
    'minimax m3 1 flash', 'aware-qwen35-9b', 'aware-qwen35-9b:latest',
    'aware-qwen35-9b-q4_k_m', 'qwen3-8b', 'claude-opus-4', 'gpt-5-judge',
    'gemini-3-pro', 'deepseek-v3', 'mock-model-1', 'fake', '', undefined, null,
  ];

  for (const a of ids) {
    for (const b of ids) {
      assert.equal(
        mirror.sameModelFamily(a, b),
        producer.sameModelFamily(a, b),
        `sameModelFamily(${JSON.stringify(a)}, ${JSON.stringify(b)}) has drifted`
      );
      assert.equal(
        mirror.isIndependentJudge(a, b),
        producer.isIndependentJudge(a, b),
        `isIndependentJudge(${JSON.stringify(a)}, ${JSON.stringify(b)}) has drifted`
      );
      assert.equal(
        mirror.isCorpusTrainedArtefact(a),
        producer.isCorpusTrainedArtefact(a),
        `isCorpusTrainedArtefact(${JSON.stringify(a)}) has drifted`
      );
    }
  }
});

test('judge-family: the mirror PREFERS the live vendored producer module', () => {
  // When the vendored copy is present the mirror must use it, so the
  // config-time guard cannot drift from the runtime guard.
  //
  // The resolver now looks in the DEPLOYED layout too
  // (`<app>/rl-pipeline/src/judge-family.js`), so the "vendored copy is
  // present" branch is no longer the only way to resolve a live module
  // (t_8b44fe9d). The fallback layout — no canonical module in ANY known
  // layout — is asserted in `judge-family-fallback.test.js`.
  const live = mirror.resolveFamilyModule();
  if (!fs.existsSync(PRODUCER_FAMILY_MODULE)) {
    assert.equal(live, null, 'no live module without the vendored copy');
    return;
  }
  assert.ok(live, 'the mirror must resolve the live vendored producer module');
  assert.equal(typeof live.resolveModelFamily, 'function');

  // The resolution records WHICH tree answered and WHY.
  const resolution = mirror.familyModuleResolution({ fresh: true });
  assert.equal(resolution.source, 'live');
  assert.equal(resolution.reasonCode, 'resolved');
  assert.equal(resolution.path, PRODUCER_FAMILY_MODULE);
});

test('judge-family: the mirrored rule table matches the producer rule table', () => {
  if (!fs.existsSync(PRODUCER_FAMILY_MODULE)) return;
  const producer = require(PRODUCER_FAMILY_MODULE);
  assert.deepEqual(
    mirror.MIRRORED_MODEL_FAMILY_RULES.map((r) => [r.id, r.family, r.pattern, !!r.corpusTrained]),
    producer.MODEL_FAMILY_RULES.map((r) => [r.id, r.family, r.pattern, !!r.corpusTrained]),
    'the mirrored family map has drifted from the producer map'
  );
  assert.deepEqual(
    { ...mirror.MIRRORED_MODEL_FAMILY_GROUPS },
    { ...producer.MODEL_FAMILY_GROUPS },
    'the mirrored family groups have drifted from the producer groups'
  );
});

// -- the producer's own rule, exercised through the vendored copy ----------

test('judge-family: the vendored producer treats a sibling judge as NOT independent', async () => {
  if (!fs.existsSync(PRODUCER_ROLE_MODULE)) return;
  const producer = await import(PRODUCER_ROLE_MODULE);
  const d = producer.describeJudge({
    candidateModel: CANDIDATE,
    judgeModel: 'MiniMax-M3',
    role: 'launch_gate',
  });
  assert.equal(d.prm_score_independent, false, 'a sibling judge must not be independent');
  assert.equal(d.prm_score_role, 'diagnostic', 'a sibling judge must be a diagnostic');
});

test('judge-family: the vendored producer refuses the corpus-trained artefact', async () => {
  if (!fs.existsSync(PRODUCER_ROLE_MODULE)) return;
  const producer = await import(PRODUCER_ROLE_MODULE);
  const d = producer.describeJudge({
    candidateModel: CANDIDATE,
    judgeModel: 'aware-qwen35-9b',
    role: 'launch_gate',
  });
  assert.equal(d.prm_score_independent, false);
  assert.equal(d.prm_score_role, 'diagnostic');
});

test('judge-family: the vendored producer still honours a different family', async () => {
  if (!fs.existsSync(PRODUCER_ROLE_MODULE)) return;
  const producer = await import(PRODUCER_ROLE_MODULE);
  const d = producer.describeJudge({
    candidateModel: CANDIDATE,
    judgeModel: 'claude-opus-4',
    role: 'launch_gate',
  });
  assert.equal(d.prm_score_independent, true);
  assert.equal(d.prm_score_role, 'launch_gate');
});

// -- the vendored copy is byte-identical to upstream ------------------------

test('judge-family: the vendored producer copy matches upstream byte for byte', (t) => {
  // AWARE vendors heavy-think under backend/heavy-think/ and keeps the copy
  // identical to upstream's src/. The upstream copy lives in a sibling git
  // repo; the file is resolved from a REF (not the upstream working tree),
  // because the upstream default checkout is routinely on an unrelated
  // branch and would make this check vacuously skip.
  const upstreamRepo = path.join(process.env.HOME || '/root', 'src', 'heavy-think');
  if (!fs.existsSync(path.join(upstreamRepo, '.git'))) {
    t.skip('the upstream heavy-think checkout is not present on this machine');
    return;
  }
  // `main` is tried FIRST: it is the ref upstream DEPLOYS, so it is the one
  // the vendored copy must match. The feature branches are fallbacks for a
  // tree whose `main` does not yet carry the file.
  //
  // This ordering matters: preferring a feature branch made this check
  // compare the vendored copy against a STALE ref, so a vendored copy that
  // had drifted from upstream `main` still passed (t_2ca310b8).
  const refs = ['main', 'fix/judge-family-namespace-t_2ca310b8', 'fix/judge-family-t_2a91cc4b', 'HEAD'];
  let upstream = null;
  let usedRef = null;
  for (const ref of refs) {
    try {
      upstream = execFileSync(
        'git',
        ['-C', upstreamRepo, 'show', `${ref}:src/judge-family.js`],
        { encoding: 'utf8' }
      );
      usedRef = ref;
      break;
    } catch {
      // try the next ref
    }
  }
  if (upstream === null) {
    t.skip('no upstream ref carries src/judge-family.js yet');
    return;
  }
  assert.equal(
    upstream,
    fs.readFileSync(PRODUCER_FAMILY_MODULE, 'utf8'),
    `the vendored judge-family.js has drifted from upstream ${usedRef}`
  );
});
