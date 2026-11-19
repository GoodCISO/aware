// test/unit/config/judge-independence.test.js
//
// The judge must be a DIFFERENT model family from the candidate it grades,
// and the configuration must REFUSE a same-family judge rather than
// accepting it and degrading silently (kanban t_89720a07, audit t_8f049433
// §3.2 / §5.1).
//
// The rule being enforced is
// `measurement-experimentation-ops/references/04-ai-product-evaluation.md`
// (:157-160): "If judge and candidate share a model family, the judge is
// grading its own house style... Run it again with an independent judge
// before it gates anything."

const test = require('node:test');
const assert = require('node:assert/strict');

function clearJudgeEnv() {
  for (const k of [
    'AWARE_JUDGE_MODEL', 'AWARE_JUDGE_API_KEY', 'AWARE_JUDGE_API_HOST',
    'AWARE_JUDGE_OLLAMA_MODEL', 'AWARE_PROVIDER_MODEL',
    'AWARE_MODE', 'LLM_API_KEY', 'LLM_API_HOST',
    'COORDINATOR_PORT', 'GATEWAY_PORT',
  ]) {
    delete process.env[k];
  }
}

test.beforeEach(() => clearJudgeEnv());
test.afterEach(() => clearJudgeEnv());

test('config: the judge model defaults to unset — no judge client by default', (t) => {
  const config = require('../../../src/config/index.cjs');
  assert.equal(config.model.judgeModel, '');
  assert.equal(config.model.judgeOllamaModel, '');
});

test('config: validate() REFUSES a judge model identical to the candidate model', () => {
  process.env.AWARE_PROVIDER_MODEL = 'MiniMax-M3.1-Flash';
  process.env.AWARE_JUDGE_MODEL = 'MiniMax-M3.1-Flash';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /AWARE_JUDGE_MODEL \(MiniMax-M3\.1-Flash\) must be a different model family from AWARE_PROVIDER_MODEL/,
  );
});

test('config: the same-family refusal is case- and separator-insensitive', () => {
  process.env.AWARE_PROVIDER_MODEL = 'MiniMax-M3.1-Flash';
  process.env.AWARE_JUDGE_MODEL = 'minimax m3 1 flash';
  const config = require('../../../src/config/index.cjs');
  assert.throws(() => config.validate(), /must be a different model family from AWARE_PROVIDER_MODEL/);
});

test('config: validate() REFUSES a CHEAPER SIBLING of the candidate model', () => {
  // t_2a91cc4b: the refusal compares MODEL FAMILIES, not model ids. A
  // sibling from the same family was accepted by the id-equality test and
  // would have been allowed to gate the DPO set.
  process.env.AWARE_PROVIDER_MODEL = 'MiniMax-M3.1-Flash';
  process.env.AWARE_JUDGE_MODEL = 'MiniMax-M3';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /AWARE_JUDGE_MODEL \(MiniMax-M3\) must be a different model family from AWARE_PROVIDER_MODEL/,
  );
});

test('config: validate() ACCEPTS a judge model from a different family', () => {
  process.env.AWARE_PROVIDER_MODEL = 'MiniMax-M3.1-Flash';
  process.env.AWARE_JUDGE_MODEL = 'gpt-5-judge';
  const config = require('../../../src/config/index.cjs');
  assert.doesNotThrow(() => config.validate());
});

// -- PROVIDER-PREFIXED ids (t_2ca310b8) -------------------------------------

test('config: validate() REFUSES a provider-prefixed judge of the same family', () => {
  // The family map did not resolve a provider-prefixed id on its MODEL
  // SEGMENT, so `meta-llama/llama-3.3-70b` and `llama-3.3-70b` resolved to
  // DIFFERENT families and the prefixed judge was ACCEPTED — declared
  // independent of its own unprefixed twin, and allowed to gate.
  process.env.AWARE_PROVIDER_MODEL = 'meta-llama/llama-3.3-70b';
  process.env.AWARE_JUDGE_MODEL = 'llama-3.3-70b';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /AWARE_JUDGE_MODEL \(llama-3\.3-70b\) must be a different model family from AWARE_PROVIDER_MODEL \(meta-llama\/llama-3\.3-70b\)/,
  );
});

test('config: validate() REFUSES a provider-prefixed judge of the same family, in the other order', () => {
  // The refusal must not depend on which side carries the namespace.
  process.env.AWARE_PROVIDER_MODEL = 'llama-3.3-70b';
  process.env.AWARE_JUDGE_MODEL = 'meta-llama/llama-3.3-70b';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /must be a different model family from AWARE_PROVIDER_MODEL/,
  );
});

test('config: validate() REFUSES a provider-prefixed judge of the same family (second spelling)', () => {
  process.env.AWARE_PROVIDER_MODEL = 'x-ai/grok-4';
  process.env.AWARE_JUDGE_MODEL = 'grok-4';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /must be a different model family from AWARE_PROVIDER_MODEL/,
  );
});

test('config: validate() ACCEPTS a provider-prefixed judge from a DIFFERENT family', () => {
  // The fix must not over-refuse: a genuinely different family is still
  // independent, however it is spelled.
  process.env.AWARE_PROVIDER_MODEL = 'meta-llama/llama-3.3-70b';
  process.env.AWARE_JUDGE_MODEL = 'claude-opus-4';
  const config = require('../../../src/config/index.cjs');
  assert.doesNotThrow(() => config.validate());
});

test('config: validate() ACCEPTS `google/gemma-2-9b` as a judge of `gemini-3-pro`', () => {
  // The `^google` rule used to map every Google model to the GEMINI family,
  // so a Gemma judge was REFUSED against a Gemini candidate. Gemma is a
  // DIFFERENT family, so this must now be ACCEPTED — and the verdict must
  // not depend on argument order.
  //
  // NOTE ON THE CARD'S AC-4: `t_2ca310b8` asked for this case to be
  // REFUSED while `AWARE_PROVIDER_MODEL=gemma-2-9b,
  // AWARE_JUDGE_MODEL=gemini-3-pro` was ACCEPTED. Those two are mutually
  // inconsistent: the same-family comparison is symmetric, so the same pair
  // cannot be refused in one order and accepted in the other. AC-4 as
  // written encodes the PRE-FIX asymmetry the card names as the defect
  // ("the same gemma/gemini pair is accepted in one order and refused in the
  // other... Both verdicts are wrong"), and it contradicts the card's own
  // AC-3 (`sameModelFamily('gemma-2-9b','gemini-3-pro')` is `false`, i.e.
  // DIFFERENT families, i.e. independent, i.e. accepted). This card
  // implements the SYMMETRIC reading, which is the one AC-3 and the
  // reviewer's "both verdicts are wrong" statement require.
  process.env.AWARE_PROVIDER_MODEL = 'gemini-3-pro';
  process.env.AWARE_JUDGE_MODEL = 'google/gemma-2-9b';
  const config = require('../../../src/config/index.cjs');
  assert.doesNotThrow(() => config.validate(),
    'gemma and gemini are different families');
});

test('config: validate() ACCEPTS `gemini-3-pro` as a judge of `gemma-2-9b`', () => {
  // The other order — the pair's verdict must be symmetric.
  process.env.AWARE_PROVIDER_MODEL = 'gemma-2-9b';
  process.env.AWARE_JUDGE_MODEL = 'gemini-3-pro';
  const config = require('../../../src/config/index.cjs');
  assert.doesNotThrow(() => config.validate());
});

test('config: validate() REFUSES a Gemma judge of a Gemma candidate, in BOTH spellings', () => {
  // The same-family refusal still applies across spellings: `google/gemma-2-9b`
  // is the gemma family, so it is NOT independent of `gemma-2-9b`.
  for (const [candidate, judge] of [
    ['gemma-2-9b', 'google/gemma-2-9b'],
    ['google/gemma-2-9b', 'gemma-2-9b'],
  ]) {
    process.env.AWARE_PROVIDER_MODEL = candidate;
    process.env.AWARE_JUDGE_MODEL = judge;
    const config = require('../../../src/config/index.cjs');
    assert.throws(
      () => config.validate(),
      /must be a different model family from AWARE_PROVIDER_MODEL/,
      `${judge} must be refused against ${candidate}`
    );
  }
});

test('config: validate() REFUSES an Ollama judge pointing at the AWARE-trained LoRA artefact', () => {
  process.env.AWARE_JUDGE_OLLAMA_MODEL = 'aware-qwen35-9b:latest';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /AWARE_JUDGE_OLLAMA_MODEL \(aware-qwen35-9b:latest\) must not be the AWARE-trained LoRA artefact/,
  );
});

test('config: validate() REFUSES the LoRA artefact as a PROVIDER judge, naming the real reason', () => {
  // t_2a91cc4b: the corpus-trained artefact is never independent of ANY
  // candidate, so the family comparison refuses it too — but with the wrong
  // reason ("same family as the candidate"). The specific refusal must not
  // be shadowed by the general one: the operator is told the artefact is the
  // model the preference pairs TRAIN.
  process.env.AWARE_PROVIDER_MODEL = 'MiniMax-M3.1-Flash';
  process.env.AWARE_JUDGE_MODEL = 'aware-qwen35-9b';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /AWARE_JUDGE_MODEL \(aware-qwen35-9b\) must not be the AWARE-trained LoRA artefact/,
  );
});

test('config: the LoRA-artefact refusal also covers the untagged model name', () => {
  process.env.AWARE_JUDGE_OLLAMA_MODEL = 'aware-qwen35-9b';
  const config = require('../../../src/config/index.cjs');
  assert.throws(() => config.validate(), /must not be the AWARE-trained LoRA artefact/);
});

test('config: validate() ACCEPTS a non-AWARE Ollama judge model', () => {
  process.env.AWARE_JUDGE_OLLAMA_MODEL = 'qwen2.5:7b';
  const config = require('../../../src/config/index.cjs');
  assert.doesNotThrow(() => config.validate());
});

// -- the OLLAMA judge path is subject to BOTH refusals (t_866475db) -------

test('config: validate() REFUSES an Ollama judge in the candidate\'s own model family', () => {
  // THE case this card exists for. The Ollama judge and the provider judge
  // are the same kind of judge — a model that grades the candidate's
  // traces — and they are named by two different env vars. Before
  // t_866475db the family refusal applied to `AWARE_JUDGE_MODEL` ONLY, so
  // this configuration was ACCEPTED at boot and the operator was told it
  // was valid. The producer's runtime guard then demoted the pair to a
  // diagnostic, so the misconfiguration surfaced in the DATA rather than
  // at boot.
  //
  // Non-vacuous: against the pre-fix implementation this was ACCEPTED.
  process.env.AWARE_PROVIDER_MODEL = 'qwen3-8b';
  process.env.AWARE_JUDGE_OLLAMA_MODEL = 'qwen3-32b';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /AWARE_JUDGE_OLLAMA_MODEL \(qwen3-32b\) must be a different model family from AWARE_PROVIDER_MODEL \(qwen3-8b\)/,
  );
});

test('config: the Ollama same-family refusal names the OLLAMA variable, not the provider one', () => {
  // The two judge paths must stay distinguishable in the message: the
  // operator has to know WHICH setting to change.
  process.env.AWARE_PROVIDER_MODEL = 'qwen3-8b';
  process.env.AWARE_JUDGE_OLLAMA_MODEL = 'qwen3-32b';
  const config = require('../../../src/config/index.cjs');
  assert.throws(() => config.validate(), /AWARE_JUDGE_OLLAMA_MODEL/);
  assert.throws(() => config.validate(), /must be a different model family from AWARE_PROVIDER_MODEL/);
});

test('config: validate() REFUSES a CHEAPER SIBLING on the Ollama judge path too', () => {
  // The family comparison is on the FAMILY, not the id, on EVERY judge
  // path — not just the provider one.
  process.env.AWARE_PROVIDER_MODEL = 'MiniMax-M3.1-Flash';
  process.env.AWARE_JUDGE_OLLAMA_MODEL = 'minimax-M3';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /AWARE_JUDGE_OLLAMA_MODEL \(minimax-M3\) must be a different model family from AWARE_PROVIDER_MODEL \(MiniMax-M3\.1-Flash\)/,
  );
});

test('config: validate() ACCEPTS an Ollama judge from a DIFFERENT family', () => {
  // The fix must not be a blanket ban: the sibling precedent at
  // `judge-independence.test.js:99-106` (a non-AWARE Ollama judge model
  // accepted) must stay green, and a genuinely different family must
  // still be accepted.
  process.env.AWARE_PROVIDER_MODEL = 'MiniMax-M3.1-Flash';
  process.env.AWARE_JUDGE_OLLAMA_MODEL = 'qwen2.5:7b';
  const config = require('../../../src/config/index.cjs');
  assert.doesNotThrow(() => config.validate());
});

test('config: the corpus-trained refusal keeps the OLLAMA path\'s specific reason', () => {
  // The ordering must not regress: the corpus-trained artefact is refused
  // with ITS OWN reason, not shadowed by the family refusal. The
  // artefact's family group is `qwen`, so against a `qwen3-8b` candidate
  // the family rule would ALSO refuse it — with the wrong reason.
  process.env.AWARE_PROVIDER_MODEL = 'qwen3-8b';
  process.env.AWARE_JUDGE_OLLAMA_MODEL = 'aware-qwen35-9b:latest';
  const config = require('../../../src/config/index.cjs');
  assert.throws(
    () => config.validate(),
    /AWARE_JUDGE_OLLAMA_MODEL \(aware-qwen35-9b:latest\) must not be the AWARE-trained LoRA artefact/,
  );
});

test('config: BOTH judge paths refuse a same-family judge with their own variable name', () => {
  // The refusal is a property of the JUDGE PATH, not of one env var: each
  // path must name itself in the message.
  for (const [envVar, judgeValue] of [
    ['AWARE_JUDGE_MODEL', 'qwen3-32b'],
    ['AWARE_JUDGE_OLLAMA_MODEL', 'qwen3-32b'],
  ]) {
    process.env.AWARE_PROVIDER_MODEL = 'qwen3-8b';
    process.env.AWARE_JUDGE_MODEL = '';
    process.env.AWARE_JUDGE_OLLAMA_MODEL = '';
    process.env[envVar] = judgeValue;
    const config = require('../../../src/config/index.cjs');
    assert.throws(
      () => config.validate(),
      new RegExp(`${envVar} \\(qwen3-32b\\) must be a different model family`),
      `${envVar} must refuse a same-family judge and name itself`,
    );
  }
});

// -- the STRUCTURAL property: one registry, one helper -------------------

test('config: every judge path is listed in the judge-path registry', () => {
  // The card's fourth acceptance criterion: the two judge paths share ONE
  // implementation of the two refusals, so a THIRD judge path cannot
  // arrive un-refused.
  //
  // The registry is the mechanism: `config.validate()` walks it, so adding
  // a judge model means adding a registry entry, and the walk then applies
  // both refusals to it. This assertion is what makes the registry
  // non-vacuous — it fails if a judge path is added to the config without
  // being added to the registry.
  const config = require('../../../src/config/index.cjs');
  const registry = config.JUDGE_MODEL_PATHS;
  assert.ok(Array.isArray(registry), 'the judge-path registry is not exported');
  const envVars = registry.map((p) => p.envVar);
  assert.ok(
    envVars.includes('AWARE_JUDGE_MODEL'),
    'the provider judge path is missing from the registry',
  );
  assert.ok(
    envVars.includes('AWARE_JUDGE_OLLAMA_MODEL'),
    'the Ollama judge path is missing from the registry',
  );
});

test('config: the registry covers EVERY judge model the config exposes', () => {
  // The registry and the config object cannot drift: every judge model
  // the config exposes must be checked by validate(). This is the
  // sweep for a THIRD judge path — the thing the card's fourth
  // acceptance criterion is about.
  const config = require('../../../src/config/index.cjs');
  const snapshot = config.snapshot();
  const exposed = Object.keys(snapshot.model).filter((k) => /judge/i.test(k) && /model/i.test(k));
  assert.ok(
    exposed.length > 0,
    'the scan found no judge model keys — the scan is broken, so this test proves nothing',
  );
  const registered = new Set(config.JUDGE_MODEL_PATHS.map((p) => p.key));
  for (const key of exposed) {
    assert.ok(
      registered.has(key),
      `config.model.${key} is a judge model that no judge path registers — it would be UN-REFUSED`,
    );
  }
});

test('config: the registry drives validate() — a registry entry IS enforced', () => {
  // The registry is not decoration: an entry in it must actually be
  // enforced by validate(). This proves the walk is live, so the
  // structural guarantee above is not a promise about dead code.
  const config = require('../../../src/config/index.cjs');
  const entry = config.JUDGE_MODEL_PATHS.find((p) => p.envVar === 'AWARE_JUDGE_OLLAMA_MODEL');
  assert.ok(entry, 'the Ollama judge path is not in the registry');

  process.env.AWARE_PROVIDER_MODEL = 'qwen3-8b';
  process.env.AWARE_JUDGE_OLLAMA_MODEL = 'qwen3-32b';
  assert.throws(() => config.validate(), /AWARE_JUDGE_OLLAMA_MODEL/);
});

test('config: validate() passes when no judge is configured at all', () => {
  const config = require('../../../src/config/index.cjs');
  assert.doesNotThrow(() => config.validate());
});

test('config: snapshot() surfaces the judge identity and redacts the judge key', () => {
  process.env.AWARE_JUDGE_MODEL = 'gpt-5-judge';
  process.env.AWARE_JUDGE_API_KEY = 'PLACEHOLDER';
  const config = require('../../../src/config/index.cjs');
  const snap = config.snapshot();
  assert.equal(snap.model.judgeModel, 'gpt-5-judge');
  assert.equal(snap.model.judgeApiKeySet, true);
  assert.equal(snap.model.judgeApiKeyLength, 'PLACEHOLDER'.length);
  assert.ok(
    !JSON.stringify(snap).includes('PLACEHOLDER'),
    'snapshot must not contain the judge key value',
  );
});
