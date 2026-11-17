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
