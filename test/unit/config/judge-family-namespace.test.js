// test/unit/config/judge-family-namespace.test.js — the AWARE-side MIRROR
// must resolve PROVIDER-PREFIXED model ids the same way the producer does
// (kanban t_2ca310b8).
//
// WHY THIS FILE EXISTS
// --------------------
// The config-time guard (this repo) and the runtime guard (the producer's
// `backend/heavy-think/src/judge-family.js`) must agree, or the config
// accepts a judge the producer then treats as same-family. Two defects
// broke that agreement for PROVIDER-PREFIXED ids:
//
//   1. The family map did not resolve a provider-prefixed id on its MODEL
//      SEGMENT. `meta-llama/llama-3.3-70b` normalised to
//      `metallamallama`, so it and its unprefixed twin `llama-3.3-70b`
//      resolved to DIFFERENT families and the judge was declared
//      INDEPENDENT of its own twin — the over-claiming direction, and a
//      direct re-opening of the hole t_2a91cc4b closed.
//   2. The `^google` rule mapped every Google model to family `gemini`,
//      sweeping Gemma into Gemini. That made the gemma/gemini pair's
//      verdict depend on ARGUMENT ORDER.
//
// This file asserts the MIRROR's OWN rule-driven implementation — the one
// that actually runs in the deployed image, where `resolveFamilyModule()`
// returns null because the resolver looks for `/app/backend/...` while the
// image ships the module at `/app/rl-pipeline/src/`. Asserting only through
// `mirror.resolveModelFamily` would delegate to the live vendored module
// and never reach the mirrored ALGORITHM at all.
//
// NON-VACUITY
// -----------
// Every assertion below fails against the pre-fix mirror (`ffab7c2d`).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const mirror = require(path.join(REPO_ROOT, 'src', 'config', 'judge-family.cjs'));

// The mirror's OWN rule-driven resolver — the implementation that runs in
// the deployed image, where the live vendored module is NOT found.
const mirrorResolve = (model) =>
  mirror.resolveModelFamilyFromRules(model, mirror.MIRRORED_MODEL_FAMILY_RULES);

// The id matrix the namespace cases are drawn from.
const NAMESPACE_IDS = [
  'meta-llama/llama-3.3-70b', 'llama-3.3-70b',
  'x-ai/grok-4', 'grok-4',
  'microsoft/phi-3', 'phi-3',
  'azure/gpt-4o-mini', 'gpt-4o',
  '01-ai/yi-34b', 'yi-34b',
  'google/gemma-2-9b', 'gemma-2-9b',
  'google/gemini-3-pro', 'gemini-3-pro',
  'minimax-M3.1-Flash', 'MiniMax-M3',
  'qwen3-8b', 'aware-qwen35-9b', 'qwen2.5:7b',
];

// -- the mirror's OWN algorithm, not the live module ------------------------

test('judge-family: the MIRROR resolves a provider-prefixed id on its MODEL SEGMENT', () => {
  // Asserted through `resolveModelFamilyFromRules` so the mirrored
  // ALGORITHM is the thing under test, not the live vendored module the
  // mirror would otherwise delegate to.
  assert.equal(mirrorResolve('meta-llama/llama-3.3-70b').family, 'llama');
  assert.equal(mirrorResolve('x-ai/grok-4').family, 'grok');
  assert.equal(mirrorResolve('microsoft/phi-3').family, 'phi');
  assert.equal(mirrorResolve('azure/gpt-4o-mini').family, 'gpt');
  assert.equal(mirrorResolve('google/gemma-2-9b').family, 'gemma');
  assert.equal(mirrorResolve('01-ai/yi-34b').family, 'yi');
});

test('judge-family: the MIRROR treats a prefixed id and its unprefixed twin as the SAME family', () => {
  for (const [a, b] of [
    ['meta-llama/llama-3.3-70b', 'llama-3.3-70b'],
    ['x-ai/grok-4', 'grok-4'],
    ['microsoft/phi-3', 'phi-3'],
    ['azure/gpt-4o-mini', 'gpt-4o'],
    ['google/gemma-2-9b', 'gemma-2-9b'],
    ['01-ai/yi-34b', 'yi-34b'],
  ]) {
    assert.equal(
      mirrorResolve(a).group,
      mirrorResolve(b).group,
      `${a} and ${b} must resolve to the same family`
    );
  }
});

test('judge-family: the MIRROR does not sweep Gemma into the Gemini family', () => {
  assert.equal(mirrorResolve('google/gemma-2-9b').family, 'gemma');
  assert.equal(mirrorResolve('gemma-2-9b').family, 'gemma');
  assert.equal(mirrorResolve('google/gemini-3-pro').family, 'gemini');
  assert.equal(mirrorResolve('gemini-3-pro').family, 'gemini');
  // And the verdict must not depend on ARGUMENT ORDER.
  assert.notEqual(
    mirrorResolve('gemma-2-9b').group,
    mirrorResolve('gemini-3-pro').group
  );
  assert.notEqual(
    mirrorResolve('google/gemma-2-9b').group,
    mirrorResolve('gemini-3-pro').group
  );
});

test('judge-family: the MIRRORED rule table carries no bare `^google` sweep', () => {
  const googleRules = mirror.MIRRORED_MODEL_FAMILY_RULES.filter((r) =>
    r.pattern.startsWith('^google')
  );
  assert.ok(googleRules.length > 0, 'the google rule must still exist');
  for (const rule of googleRules) {
    assert.ok(
      !/^\^google$/.test(rule.pattern),
      `the bare ^google rule (${rule.id}) sweeps every google model into ${rule.family}`
    );
  }
});

test('judge-family: the MIRROR agrees with the PRODUCER over the namespace matrix', () => {
  // The drift check, but on the mirror's OWN algorithm: the config-time
  // guard and the runtime guard must not disagree, or the config accepts a
  // judge the producer then treats as same-family.
  const producerPath = path.join(
    REPO_ROOT, 'backend', 'heavy-think', 'src', 'judge-family.js'
  );
  if (!require('node:fs').existsSync(producerPath)) {
    // The published npm package ships src/config/ but NOT backend/.
    assert.ok(true, 'the vendored producer copy is not present in this tree');
    return;
  }
  const producer = require(producerPath);

  for (const a of NAMESPACE_IDS) {
    for (const b of NAMESPACE_IDS) {
      assert.equal(
        mirrorResolve(a).group,
        producer.resolveModelFamily(a).group,
        `family of ${JSON.stringify(a)} has drifted between the mirror and the producer`
      );
      assert.equal(
        mirrorResolve(b).group,
        producer.resolveModelFamily(b).group,
        `family of ${JSON.stringify(b)} has drifted between the mirror and the producer`
      );
    }
  }
});

// -- the same cases through the mirror's PUBLIC surface ---------------------

test('judge-family: the mirror PUBLIC surface resolves the namespace cases too', () => {
  // `mirror.resolveModelFamily` may delegate to the live vendored module,
  // so this asserts the end-to-end behaviour a config-time guard sees.
  assert.equal(mirror.modelFamily('meta-llama/llama-3.3-70b'), 'llama');
  assert.equal(mirror.modelFamily('google/gemma-2-9b'), 'gemma');
  assert.equal(mirror.sameModelFamily('meta-llama/llama-3.3-70b', 'llama-3.3-70b'), true);
  assert.equal(mirror.sameModelFamily('google/gemma-2-9b', 'gemma-2-9b'), true);
  assert.equal(mirror.sameModelFamily('gemma-2-9b', 'gemini-3-pro'), false);
  assert.equal(mirror.sameModelFamily('gemini-3-pro', 'gemma-2-9b'), false);
  assert.equal(mirror.isIndependentJudge('meta-llama/llama-3.3-70b', 'llama-3.3-70b'), false);
  assert.equal(mirror.isIndependentJudge('gemma-2-9b', 'gemini-3-pro'), true);
});

// -- the conservative direction is preserved -------------------------------

test('judge-family: the MIRROR keeps the conservative direction', () => {
  // An unnameable id is still unnameable, and a genuinely different family
  // is still independent.
  for (const m of ['', undefined, null, 42, '---', 'meta-llama/']) {
    assert.equal(mirrorResolve(m).family, '', `${JSON.stringify(m)} must name no family`);
  }
  assert.notEqual(
    mirrorResolve('meta-llama/llama-3.3-70b').group,
    mirrorResolve('claude-opus-4').group
  );
  assert.notEqual(
    mirrorResolve('x-ai/grok-4').group,
    mirrorResolve('gemini-3-pro').group
  );
});
