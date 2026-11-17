// src/config/judge-family.cjs — the AWARE-side MIRROR of the model-family map
// (kanban t_2a91cc4b).
//
// WHY THIS IS A MIRROR
// --------------------
// The CANONICAL source of the family map is the producer's package:
// `backend/heavy-think/src/judge-family.js` (upstream: `src/judge-family.js`
// in the heavy-think repo). `backend/heavy-think/src/judge-role.js` imports
// it and computes `prm_score_independent` from it.
//
// The published npm package ships `src/config/` but NOT `backend/`, so the
// vendored copy is ABSENT in a published install and `src/config/index.cjs`
// cannot import the ES module. This file is the fallback implementation.
//
// This is the same pattern as `src/config/rlm.cjs`: prefer the LIVE vendored
// module when it is present, fall back to the mirrored constant when it is
// not (see `resolveFamilyModule`). The mirror is drift-checked by
// `test/unit/config/judge-family.test.js`, which asserts the two are
// identical whenever the vendored copy is present.
//
// The two guards MUST agree: the config-time guard (here, at boot) and the
// runtime guard (the producer, at pair-write time). If they disagree, the
// config accepts a judge the producer then treats as same-family — the exact
// contradiction t_155a95a1 closed and t_2a91cc4b re-opened.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Normalise a model id for the family comparison.
 *
 * Case-insensitive and separator-insensitive: the same family can be spelled
 * differently across providers (`MiniMax-M3.1-Flash` vs `minimax-M3.1-flash`).
 *
 * @param {*} model
 * @returns {string} the normalised id, or '' when there is no model id
 */
function normaliseModelId(model) {
  if (typeof model !== 'string') return '';
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The MIRROR of the producer's declared model-family map.
 *
 * Each entry maps a normalised-id PATTERN to the family every id matching it
 * belongs to. `corpusTrained` marks the artefact AWARE's preference pairs
 * TRAIN: the AWARE-LoRA-merged Qwen3.5-9B build. A judge that is this
 * artefact is never independent of anything — it is scoring with a model
 * trained on the corpus it selects.
 *
 * ORDER MATTERS: the first matching rule wins, and the corpus-trained rule
 * is listed first so it is never shadowed by the plain `qwen` rule.
 *
 * @type {ReadonlyArray<{id: string, family: string, corpusTrained?: boolean, pattern: string}>}
 */
const MIRRORED_MODEL_FAMILY_RULES = Object.freeze([
  Object.freeze({
    id: 'aware-qwen3.5',
    family: 'aware-lora',
    corpusTrained: true,
    pattern: '^awareqwen35',
  }),
  Object.freeze({ id: 'minimax', family: 'minimax', pattern: '^minimax' }),
  Object.freeze({ id: 'qwen', family: 'qwen', pattern: '^qwen' }),
  Object.freeze({ id: 'llama', family: 'llama', pattern: '^llama' }),
  Object.freeze({ id: 'mistral', family: 'mistral', pattern: '^mistral' }),
  Object.freeze({ id: 'mixtral', family: 'mistral', pattern: '^mixtral' }),
  Object.freeze({ id: 'codestral', family: 'mistral', pattern: '^codestral' }),
  Object.freeze({ id: 'claude', family: 'claude', pattern: '^claude' }),
  Object.freeze({ id: 'anthropic', family: 'claude', pattern: '^anthropic' }),
  Object.freeze({ id: 'gpt', family: 'gpt', pattern: '^gpt' }),
  Object.freeze({ id: 'chatgpt', family: 'gpt', pattern: '^chatgpt' }),
  Object.freeze({ id: 'openai', family: 'gpt', pattern: '^openai' }),
  // Normalisation strips separators, so `o3-mini` arrives here as `o3mini`;
  // the rule therefore matches the digit and anything after it.
  Object.freeze({ id: 'o-series', family: 'gpt', pattern: '^o[1345]' }),
  Object.freeze({ id: 'gemini', family: 'gemini', pattern: '^gemini' }),
  Object.freeze({ id: 'google', family: 'gemini', pattern: '^google' }),
  Object.freeze({ id: 'deepseek', family: 'deepseek', pattern: '^deepseek' }),
  Object.freeze({ id: 'glm', family: 'glm', pattern: '^glm' }),
  Object.freeze({ id: 'kimi', family: 'kimi', pattern: '^kimi' }),
  Object.freeze({ id: 'moonshot', family: 'kimi', pattern: '^moonshot' }),
  Object.freeze({ id: 'grok', family: 'grok', pattern: '^grok' }),
  Object.freeze({ id: 'nous', family: 'nous', pattern: '^nous' }),
  Object.freeze({ id: 'hermes', family: 'nous', pattern: '^hermes' }),
  Object.freeze({ id: 'gemma', family: 'gemma', pattern: '^gemma' }),
  Object.freeze({ id: 'phi', family: 'phi', pattern: '^phi' }),
]);

/**
 * The MIRROR of the producer's declared family EQUIVALENCE GROUPS.
 *
 * Two families in the same group are the SAME family for the purposes of
 * the independence comparison. A family with no entry here is its own group.
 *
 * `aware-lora` is grouped with `qwen` because the AWARE-LoRA artefact IS a
 * Qwen3.5-9B build: a Qwen judge and the LoRA share one house style.
 *
 * @type {Readonly<Record<string, string>>} family -> group key
 */
const MIRRORED_MODEL_FAMILY_GROUPS = Object.freeze({
  'aware-lora': 'qwen',
});

/**
 * The leading alphabetic run of a normalised id — the LINEAGE fallback for
 * an id the declared map does not name. `gpt5judge` -> `gpt`, `qwen257b` ->
 * `qwen`, `mockjudge` -> `mock`.
 *
 * @param {string} normalisedId
 * @returns {string} the lineage, or '' when the id does not start with a letter
 */
function leadingLineage(normalisedId) {
  const match = /^[a-z]+/.exec(normalisedId);
  return match ? match[0] : '';
}

/**
 * The equivalence group a family belongs to.
 *
 * @param {string} family
 * @returns {string} the group key
 */
function familyGroup(family) {
  return MIRRORED_MODEL_FAMILY_GROUPS[family] || family;
}

/**
 * Resolve a model id to the family it belongs to, using a given rule set.
 *
 * @param {*} model
 * @param {Array} rules
 * @returns {{family: string, group: string, known: boolean, corpusTrained: boolean, source: string}}
 */
function resolveModelFamilyFromRules(model, rules) {
  const id = normaliseModelId(model);
  if (!id) {
    return { family: '', group: '', known: false, corpusTrained: false, source: 'none' };
  }
  for (const rule of rules) {
    if (new RegExp(rule.pattern).test(id)) {
      return {
        family: rule.family,
        group: familyGroup(rule.family),
        known: true,
        corpusTrained: Boolean(rule.corpusTrained),
        source: 'map',
      };
    }
  }
  const lineage = leadingLineage(id);
  if (!lineage) {
    return { family: '', group: '', known: false, corpusTrained: false, source: 'none' };
  }
  return {
    family: lineage,
    group: familyGroup(lineage),
    known: true,
    corpusTrained: false,
    source: 'lineage',
  };
}

// ─── live-module resolution ───────────────────────────────────────────────

let liveModule;

/**
 * Prefer the LIVE vendored family module, so the config-time guard cannot
 * drift from the producer's runtime guard. Falls back to the mirrored
 * implementation when the vendored copy is absent (the published npm package
 * ships `src/config/` but NOT `backend/`).
 *
 * require() of an ES module works on Node >= 22.12; older runtimes and any
 * load failure fall through to the mirror.
 *
 * @returns {Object|null}
 */
function resolveFamilyModule() {
  if (liveModule !== undefined) return liveModule;
  const candidate = path.resolve(
    __dirname, '..', '..', 'backend', 'heavy-think', 'src', 'judge-family.js'
  );
  liveModule = null;
  try {
    if (!fs.existsSync(candidate)) return liveModule;
    const mod = require(candidate);
    if (mod && typeof mod.resolveModelFamily === 'function') {
      liveModule = mod;
    }
  } catch {
    liveModule = null;
  }
  return liveModule;
}

/**
 * Resolve a model id to the family it belongs to.
 *
 * @param {*} model
 * @returns {{family: string, group: string, known: boolean, corpusTrained: boolean, source: string}}
 *   `source` is 'map' | 'lineage' | 'none'.
 */
function resolveModelFamily(model) {
  const live = resolveFamilyModule();
  if (live) return live.resolveModelFamily(model);
  return resolveModelFamilyFromRules(model, MIRRORED_MODEL_FAMILY_RULES);
}

/**
 * The family a model id belongs to, or '' when it resolves to none.
 *
 * @param {*} model
 * @returns {string}
 */
function modelFamily(model) {
  return resolveModelFamily(model).family;
}

/**
 * True when `model` names the AWARE-trained LoRA artefact — the merged
 * Qwen3.5-9B build the preference pairs train. Such a model cannot judge
 * those pairs independently: it is scoring with a model trained on the
 * corpus it selects (t_8f049433 section 5.1 — "independence in the wrong
 * direction").
 *
 * @param {*} model
 * @returns {boolean}
 */
function isCorpusTrainedArtefact(model) {
  return resolveModelFamily(model).corpusTrained === true;
}

/**
 * True when `judgeModel` is the same model family as `candidateModel`.
 *
 * The comparison is on the FAMILY, never on the id: `MiniMax-M3` and
 * `MiniMax-M3.1-Flash` are the same family, and so are `MiniMax-M3.1-Flash`
 * and `minimax-M3.1-flash`. When one family is a PREFIX of the other they
 * are treated as the same family (conservative direction).
 *
 * @param {*} candidateModel
 * @param {*} judgeModel
 * @returns {boolean} false when either id resolves to no family.
 */
function sameModelFamily(candidateModel, judgeModel) {
  const a = resolveModelFamily(candidateModel).group;
  const b = resolveModelFamily(judgeModel).group;
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && longer.startsWith(shorter);
}

/**
 * True when the judge may be treated as INDEPENDENT of the candidate.
 *
 * The producer's rule (backend/heavy-think/src/judge-role.js), mirrored so
 * the config-time guard and the runtime guard cannot disagree:
 *
 *   - both model ids must resolve to a family — "cannot name the family" is
 *     not evidence of independence, in either direction;
 *   - the judge must NOT be the corpus-trained artefact;
 *   - the two families must differ.
 *
 * @param {*} candidateModel
 * @param {*} judgeModel
 * @returns {boolean}
 */
function isIndependentJudge(candidateModel, judgeModel) {
  const candidate = resolveModelFamily(candidateModel);
  const judge = resolveModelFamily(judgeModel);
  if (!candidate.family || !judge.family) return false;
  if (judge.corpusTrained) return false;
  return !sameModelFamily(candidateModel, judgeModel);
}

module.exports = {
  normaliseModelId,
  sameModelFamily,
  isIndependentJudge,
  modelFamily,
  resolveModelFamily,
  isCorpusTrainedArtefact,
  MIRRORED_MODEL_FAMILY_RULES,
  MIRRORED_MODEL_FAMILY_GROUPS,
  resolveFamilyModule,
};
