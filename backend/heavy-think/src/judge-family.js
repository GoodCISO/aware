// src/judge-family.js — WHICH model family a model id belongs to, and
// therefore whether a judge is independent of the candidate it grades
// (kanban t_2a91cc4b).
//
// WHY THIS EXISTS
// ---------------
// t_155a95a1 declared the judge role on every preference pair and computed
// `prm_score_independent` by comparing the judge's model ID with the
// candidate's model ID FOR EQUALITY. That comparison is too narrow: it
// catches the identical id and nothing else, so a CHEAPER SIBLING from the
// same family — `MiniMax-M3` judging `MiniMax-M3.1-Flash` — was declared
// independent and was allowed to GATE the DPO set.
//
// The rule being enforced is
// `measurement-experimentation-ops/references/04-ai-product-evaluation.md`:
//   :157-160 — "If judge and candidate share a model family, the judge is
//              grading its own house style..."
//   :187-190 — "Same family -> the verdict is a DIAGNOSTIC, never a launch
//              gate."
// and the audit (t_8f049433 §5.1, "What must NOT count as independence")
// names a cheaper sibling of the candidate's family explicitly.
//
// THE DIRECTION OF THE ERROR
// --------------------------
// Under-claiming independence is SAFE: the pair is demoted to a diagnostic
// and the gate stops. Over-claiming independence re-opens the same-family
// gate that t_155a95a1 closed. So every rule below errs towards "same
// family" / "not independent":
//
//   * a model id that resolves to no family at all is NOT independent
//     ("cannot name the family" is not evidence of independence);
//   * two families whose GROUPS are equal are the SAME family;
//   * one family that is a PREFIX of the other is the same family;
//   * the AWARE-trained LoRA artefact is NEVER independent, whatever the
//     candidate's family — it is the artefact the preference pairs TRAIN,
//     so a judge that is it is grading the corpus it selects
//     (t_8f049433 §5.1: "independence in the wrong direction");
//   * a PROVIDER-PREFIXED id is resolved on its MODEL segment, so two
//     spellings of one model — `meta-llama/llama-3.3-70b` and
//     `llama-3.3-70b` — are the SAME family. The lineage fallback used
//     to read the namespace as part of the family (`metallamallama`), so
//     the two spellings resolved to DIFFERENT families and the judge was
//     declared independent of its own unprefixed twin (t_2ca310b8).
//
// WHERE THE FAMILY SOURCE LIVES
// ------------------------------
// This module is the canonical source. It lives in the PRODUCER's package
// (heavy-think), because the producer is the half that decides a pair's
// role — `src/judge-role.js` imports it and nothing else does.
//
// AWARE vendors this package under `backend/heavy-think/` and keeps the copy
// BYTE-IDENTICAL to upstream's `src/`. AWARE's own config-time guard
// (`src/config/index.cjs`, CommonJS) cannot import this ES module — the
// published npm package ships `src/config/` but NOT `backend/`, so the
// vendored copy is absent there — and it therefore carries a CommonJS
// MIRROR at `src/config/judge-family.cjs`. The mirror is drift-checked
// against this module by `test/unit/config/judge-family.test.js` in the
// AWARE repo: the config-time guard and the runtime guard must agree, or
// the config accepts a judge the producer then treats as same-family.
//
// The trainer (`src/trainer/judge-role.js`) needs NO family logic: it reads
// the already-computed `prm_score_independent` boolean off the pair record.

/**
 * Normalise a model id for the family comparison.
 *
 * The same family can be spelled differently across providers
 * (`MiniMax-M3.1-Flash` vs `minimax-M3.1-flash`), so the comparison is
 * case-insensitive and ignores separators.
 *
 * @param {*} model
 * @returns {string} the normalised id, or '' when there is no model id
 */
export function normaliseModelId(model) {
  if (typeof model !== 'string') return '';
  return model.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The declared model-family map.
 *
 * Each entry maps a normalised-id PATTERN to the family every id matching it
 * belongs to. The pattern is stored as a RegExp SOURCE string so the
 * CommonJS mirror in AWARE's `src/config/judge-family.cjs` can rebuild an
 * identical RegExp without the two files drifting.
 *
 * `corpusTrained` marks the artefact AWARE's preference pairs TRAIN: the
 * AWARE-LoRA-merged Qwen3.5-9B build. A judge that is this artefact is
 * never independent of anything — it is scoring with a model trained on the
 * corpus it selects.
 *
 * ORDER MATTERS: the first matching rule wins, and the corpus-trained rule
 * is listed first so it is never shadowed by the plain `qwen` rule.
 *
 * @type {ReadonlyArray<{id: string, family: string, corpusTrained?: boolean, pattern: string}>}
 */
export const MODEL_FAMILY_RULES = Object.freeze([
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
  // `^google` names Google's GEMINI line, NOT every model Google publishes:
  // Gemma is a separate family with a separate house style, so sweeping it
  // into `gemini` made the gemma/gemini pair's verdict depend on ARGUMENT
  // ORDER — `gemma-2-9b` vs `gemini-3-pro` was accepted while
  // `google/gemma-2-9b` vs `gemini-3-pro` was refused (t_2ca310b8).
  //
  // The narrow pattern keeps the vendor rule meaningful for the ids it does
  // own (`google/gemini-3-pro`, `google-palm`) while letting a NAMED model
  // segment win: `google/gemma-2-9b` resolves on its `gemma-2-9b` segment to
  // family `gemma`. The `^googlegemma` rule below is the belt-and-braces
  // case for a normalised id where the segment is not separable.
  Object.freeze({ id: 'google', family: 'gemini', pattern: '^google(?:gemini|palm)' }),
  Object.freeze({ id: 'googlegemma', family: 'gemma', pattern: '^googlegemma' }),
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
 * The declared EQUIVALENCE GROUPS of families.
 *
 * Two families in the same group are the SAME family for the purposes of
 * the independence comparison. A family with no entry here is its own group.
 *
 * `aware-lora` is grouped with `qwen` because the AWARE-LoRA artefact IS a
 * Qwen3.5-9B build: a Qwen judge and the LoRA share one house style, so
 * grouping them is the conservative direction — a base Qwen judge of the
 * LoRA candidate is NOT independent. (The LoRA is separately barred from
 * being a JUDGE at all, via `corpusTrained`.)
 *
 * @type {Readonly<Record<string, string>>} family -> group key
 */
export const MODEL_FAMILY_GROUPS = Object.freeze({
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
 * The candidate MODEL SEGMENTS of a model id, most specific first.
 *
 * HuggingFace-style ids are `<vendor>/<model>` — `meta-llama/llama-3.3-70b`,
 * `x-ai/grok-4`, `google/gemma-2-9b`, `01-ai/yi-34b`. The vendor names the
 * PUBLISHER; the model segment names the FAMILY. Normalisation strips the
 * `/`, so without this the namespace is read as part of the family and the
 * two spellings of one model resolve to DIFFERENT families — which declared
 * the judge independent of its own unprefixed twin (t_2ca310b8).
 *
 * A dotted vendor prefix is also recognised (`azure.gpt-4o-mini`), but a
 * segment that is a bare VERSION TOKEN is not a namespace: `3.1` in
 * `3.1-turbo` is a version, not a vendor. The candidates are only a
 * PREFERENCE — the resolver tries each and falls back to the whole id, so a
 * segment that yields nothing usable costs nothing.
 *
 * @param {*} model the RAW (un-normalised) model id
 * @returns {string[]} candidate model segments, most specific first
 */
function namespaceSegments(model) {
  if (typeof model !== 'string') return [];
  const trimmed = model.trim();
  if (!trimmed) return [];
  const segments = [];

  // A slash namespace: `meta-llama/llama-3.3-70b`.
  const slash = trimmed.indexOf('/');
  let base = trimmed;
  if (slash > 0 && slash < trimmed.length - 1) {
    const vendor = trimmed.slice(0, slash);
    if (isVendorToken(vendor)) {
      segments.push(trimmed.slice(slash + 1));
      base = trimmed.slice(slash + 1);
    }
  }

  // A dotted vendor prefix on the (possibly slash-stripped) tail:
  // `azure.gpt-4o-mini`.
  const dot = base.indexOf('.');
  if (dot > 0 && dot < base.length - 1) {
    const head = base.slice(0, dot);
    if (isVendorToken(head)) segments.push(base.slice(dot + 1));
  }

  return segments;
}

/**
 * True when a segment names a PUBLISHER rather than a version.
 *
 * A vendor token does not END with a digit: `azure`, `google`, `microsoft`,
 * `meta-llama`, `x-ai` and `01-ai` are vendors; `3`, `3.1`, `gpt-3` and
 * `qwen2` are a version or a model name, and splitting at them would cut a
 * model id in half (`gpt-3.1-turbo` -> `1-turbo`).
 *
 * @param {string} segment
 * @returns {boolean}
 */
function isVendorToken(segment) {
  if (!segment) return false;
  if (isVersionToken(segment)) return false;
  return !/[0-9]$/.test(segment);
}

/**
 * True when a model id carries a namespace but NO model segment — a dangling
 * namespace like `meta-llama/`.
 *
 * Such an id names no model at all, so it must resolve to NO family. Left to
 * the lineage fallback it would resolve to the VENDOR's name (`metallama`),
 * which differs from the model's own family (`llama`) — so the id would be
 * declared independent of the very model it names. That is the
 * over-claiming direction again, one spelling further out.
 *
 * @param {*} model
 * @returns {boolean}
 */
function namesNoModel(model) {
  if (typeof model !== 'string') return false;
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return false;
  return trimmed.slice(slash + 1).trim() === '';
}

/**
 * True when a segment is a bare VERSION TOKEN (`3`, `3.1`, `1.5`) rather
 * than a vendor name.
 *
 * @param {string} segment
 * @returns {boolean}
 */
function isVersionToken(segment) {
  return /^[0-9]+(?:\.[0-9]+)*$/.test(segment);
}

/**
 * The equivalence group a family belongs to.
 *
 * @param {string} family
 * @returns {string} the group key
 */
function familyGroup(family) {
  return MODEL_FAMILY_GROUPS[family] || family;
}

/**
 * Match a normalised id against the declared map.
 *
 * @param {string} id the normalised id
 * @returns {{family: string, group: string, known: boolean, corpusTrained: boolean, source: string}|null}
 *   null when no rule matches.
 */
function matchDeclaredRule(id) {
  for (const rule of MODEL_FAMILY_RULES) {
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
  return null;
}

/**
 * Resolve a model id to the family it belongs to.
 *
 * The declared map wins; an id the map does not name falls back to its
 * LINEAGE (the leading alphabetic run of the normalised id), which is the
 * documented per-provider default. An id that resolves to nothing at all is
 * reported as family '' — and such a judge is never independent.
 *
 * A PROVIDER-PREFIXED id is resolved on its MODEL SEGMENT FIRST
 * (`meta-llama/llama-3.3-70b` -> `llama-3.3-70b` -> family `llama`), and only
 * then on the WHOLE id. Reading the whole id first made the namespace part
 * of the family (`metallamallama`), so two spellings of one model resolved to
 * DIFFERENT families and the judge was declared independent of its own
 * unprefixed twin — the over-claiming direction this module exists to avoid
 * (t_2ca310b8).
 *
 * The whole-id fallback is what keeps the `^google` rule meaningful: a
 * vendor-prefixed id whose model segment the map does not name (or cannot
 * name — `01-ai/yi-34b` has no leading alphabetic run) still resolves
 * through the vendor prefix, and a vendor-prefixed id whose MODEL segment IS
 * named resolves on the model, so `google/gemma-2-9b` is `gemma` and not
 * `gemini`.
 *
 * @param {*} model
 * @returns {{family: string, group: string, known: boolean, corpusTrained: boolean, source: string}}
 *   `source` is 'map' | 'lineage' | 'none'.
 */
export function resolveModelFamily(model) {
  const id = normaliseModelId(model);
  if (!id) {
    return { family: '', group: '', known: false, corpusTrained: false, source: 'none' };
  }

  // A namespace with no model segment names NO model: it must not fall
  // through to the lineage fallback, which would read the VENDOR's name as
  // the family and declare the id independent of the model it names.
  if (namesNoModel(model)) {
    return { family: '', group: '', known: false, corpusTrained: false, source: 'none' };
  }

  // The MODEL segment of a provider-prefixed id, resolved FIRST.
  for (const segment of namespaceSegments(model)) {
    const segmentId = normaliseModelId(segment);
    if (!segmentId || segmentId === id) continue;
    const viaSegment = matchDeclaredRule(segmentId);
    if (viaSegment) return viaSegment;
    // The segment is NAMED but not by a declared rule — its own LINEAGE is
    // still a family (`01-ai/yi-34b` -> `yi`), and using it keeps the
    // vendor-prefixed id in the SAME family as its unprefixed twin. Without
    // this the digit-prefixed id resolved to family '' and a legitimate
    // judge of it was refused outright.
    const segmentLineage = leadingLineage(segmentId);
    if (segmentLineage) {
      return {
        family: segmentLineage,
        group: familyGroup(segmentLineage),
        known: true,
        corpusTrained: false,
        source: 'lineage',
      };
    }
  }

  // The WHOLE id — this is where a vendor-prefixed id whose model segment is
  // not named falls through to the vendor rule (`^google` -> `gemini`).
  const viaWhole = matchDeclaredRule(id);
  if (viaWhole) return viaWhole;

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

/**
 * The family a model id belongs to, or '' when it resolves to none.
 *
 * @param {*} model
 * @returns {string}
 */
export function modelFamily(model) {
  return resolveModelFamily(model).family;
}

/**
 * True when `model` names the AWARE-trained LoRA artefact — the merged
 * Qwen3.5-9B build the preference pairs train. Such a model cannot judge
 * those pairs independently: it is scoring with a model trained on the
 * corpus it selects (t_8f049433 §5.1 — "independence in the wrong
 * direction").
 *
 * `aware-qwen35-9b`, `aware-qwen35-9b:latest` and `aware-qwen35-9b-q4_k_m`
 * all name the same artefact.
 *
 * @param {*} model
 * @returns {boolean}
 */
export function isCorpusTrainedArtefact(model) {
  return resolveModelFamily(model).corpusTrained === true;
}

/**
 * True when `judgeModel` is the same model family as `candidateModel`.
 *
 * The comparison is on the FAMILY, never on the id: `MiniMax-M3` and
 * `MiniMax-M3.1-Flash` are the same family, and so are `MiniMax-M3.1-Flash`
 * and `minimax-M3.1-flash`.
 *
 * When one family is a PREFIX of the other they are treated as the same
 * family (conservative direction: a lineage and its narrower sibling are
 * one house style).
 *
 * @param {*} candidateModel
 * @param {*} judgeModel
 * @returns {boolean} false when either id resolves to no family — absence of
 *   evidence is not evidence of sameness, but it is also not evidence of
 *   independence, which is why `describeJudge` treats an unnameable judge as
 *   NOT independent.
 */
export function sameModelFamily(candidateModel, judgeModel) {
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
 * The rule, in one place, so the config-time guard (AWARE's
 * `src/config/index.cjs`, mirrored in `src/config/judge-family.cjs`) and the
 * runtime guard (this module) cannot drift:
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
export function isIndependentJudge(candidateModel, judgeModel) {
  const candidate = resolveModelFamily(candidateModel);
  const judge = resolveModelFamily(judgeModel);
  if (!candidate.family || !judge.family) return false;
  if (judge.corpusTrained) return false;
  return !sameModelFamily(candidateModel, judgeModel);
}
