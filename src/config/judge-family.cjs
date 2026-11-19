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
//
// NAMESPACE HANDLING (t_2ca310b8)
// -------------------------------
// A PROVIDER-PREFIXED id (`meta-llama/llama-3.3-70b`, `google/gemma-2-9b`)
// is resolved on its MODEL SEGMENT first, so two spellings of one model are
// the SAME family. Reading the whole id first made the namespace part of the
// family, so the prefixed and unprefixed spellings resolved to DIFFERENT
// families and the judge was declared independent of its own twin — the
// over-claiming direction. The mirrored implementation below carries the
// same algorithm as the producer's `src/judge-family.js`.
//
// The `^google` rule is NARROWED to Google's Gemini line
// (`^google(?:gemini|palm)`): a bare `^google` swept Gemma into the Gemini
// family, which made the gemma/gemini pair's verdict depend on ARGUMENT
// ORDER.
//
// WHERE THE CANONICAL MODULE ACTUALLY LIVES (t_8b44fe9d)
// ------------------------------------------------------
// The resolver below looks for the canonical producer module at
// `<repo>/backend/heavy-think/src/judge-family.js`. That path is the REPO
// layout only. The DEPLOYED coordinator image ships the same file at
// `/app/rl-pipeline/src/judge-family.js` (Dockerfile.coordinator COPYs
// `backend/heavy-think/src` -> `./rl-pipeline/src`) and has NO `/app/backend`
// at all — so in production the resolver found nothing and the config-time
// guard silently ran the MIRROR while the runtime guard
// (`/app/rl-pipeline/src/judge-family.js`) ran the canonical module. The two
// were kept in step only by a drift test that, in a tree where the vendored
// copy is present, compares the mirror against ITSELF (the mirror delegates
// to the live module), so the mirror's own algorithm was never executed by
// the suite.
//
// `resolveFamilyModule` now resolves the DEPLOYED layout first (via
// `AWARE_RL_PIPELINE_PATH`, the same env var the coordinator's other
// live-tree resolvers use), then the repo layout, then the dev-layout
// sibling. The mirror's OWN algorithm is exported and drift-checked
// directly, so it cannot diverge silently even where the canonical module
// cannot be loaded at all.
//
// `require()` failure is NOT silent: the reason is recorded and surfaced
// (see `familyModuleResolution` / `resolveFamilyModule`).

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
  return MIRRORED_MODEL_FAMILY_GROUPS[family] || family;
}

/**
 * Match a normalised id against a rule set.
 *
 * @param {string} id the normalised id
 * @param {Array} rules
 * @returns {{family: string, group: string, known: boolean, corpusTrained: boolean, source: string}|null}
 *   null when no rule matches.
 */
function matchDeclaredRule(id, rules) {
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
  return null;
}

/**
 * Resolve a model id to the family it belongs to, using a given rule set.
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
 * @param {Array} rules
 * @returns {{family: string, group: string, known: boolean, corpusTrained: boolean, source: string}}
 */
function resolveModelFamilyFromRules(model, rules) {
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
    const viaSegment = matchDeclaredRule(segmentId, rules);
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
  const viaWhole = matchDeclaredRule(id, rules);
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

// ─── live-module resolution ───────────────────────────────────────────────

let familyModuleResolutionCache;

/**
 * The canonical producer module paths to try, in priority order.
 *
 * The FIRST candidate that EXISTS is the tree the coordinator actually runs
 * and is DECISIVE — the next candidate is a different tree, and answering
 * for it proves nothing about the one in production.
 *
 * 1. `deployed` — the directory of `AWARE_RL_PIPELINE_PATH`. In the
 *    coordinator image that is `/app/rl-pipeline/src`, the copy the
 *    runtime guard executes. This is the same env var the coordinator's
 *    other live-tree resolvers use (`src/config/rlm.cjs`,
 *    `src/config/rl-pipeline-build.cjs`).
 * 2. `deployed-layout` — `<app>/rl-pipeline/src/judge-family.js`, resolved
 *    relative to THIS module. The image ships the canonical module there
 *    (Dockerfile.coordinator COPYs `backend/heavy-think/src` ->
 *    `./rl-pipeline/src`) and has NO `/app/backend` at all, so before
 *    t_8b44fe9d the config-time guard silently ran the MIRROR while the
 *    runtime guard ran the canonical module.
 * 3. `vendored` — the repo's copy at
 *    `<repo>/backend/heavy-think/src/judge-family.js`. This is what the
 *    test-suite and a source checkout run against.
 * 4. `dev-layout` — the sibling checkout at `<repo>/../rl-pipeline/src`.
 *
 * @param {Object} [env]
 * @returns {Array<{path: string, source: string}>}
 */
function familyModuleCandidates(env) {
  const e = env || process.env;
  const out = [];

  const fromEnv = e.AWARE_RL_PIPELINE_PATH;
  if (fromEnv && String(fromEnv).trim()) {
    out.push({
      path: path.join(
        path.dirname(path.resolve(String(fromEnv).trim())),
        'judge-family.js'
      ),
      source: 'deployed',
    });
  }

  // src/config/judge-family.cjs -> src/config -> src -> <app> -> ../../ -> <app>
  out.push({
    path: path.resolve(__dirname, '..', '..', 'rl-pipeline', 'src', 'judge-family.js'),
    source: 'deployed-layout',
  });

  out.push({
    path: path.resolve(
      __dirname, '..', '..', 'backend', 'heavy-think', 'src', 'judge-family.js'
    ),
    source: 'vendored',
  });

  // src/config/judge-family.cjs -> ../../.. -> the parent of the repo
  out.push({
    path: path.resolve(__dirname, '..', '..', '..', 'rl-pipeline', 'src', 'judge-family.js'),
    source: 'dev-layout',
  });

  // De-duplicate by path, keeping the FIRST source label.
  const seen = new Set();
  return out.filter((c) => {
    if (seen.has(c.path)) return false;
    seen.add(c.path);
    return true;
  });
}

/**
 * Resolve the canonical producer module, and RECORD WHY it was or was not
 * found.
 *
 * `require()` failure is NOT silent. A candidate that exists but cannot be
 * loaded (an ES module on a runtime below Node 22.12, a syntax error, a
 * broken vendored copy) yields `source: 'mirror'` with `reasonCode:
 * 'load-failed'` and a human-readable `reason` naming the path and the
 * error. The reason is warned about once and is also reachable through
 * `familyModuleResolution()`, so the config layer can surface it in
 * `config.warnings()`.
 *
 * A candidate that does not exist at all yields `reasonCode: 'absent'`,
 * which is NOT an anomaly: the published npm package ships `src/config/`
 * but not `backend/`, so the mirror is the only implementation there.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.env] the environment to resolve against
 * @param {boolean} [opts.fresh] ignore the cached resolution
 * @returns {{module: Object|null, path: string|null, source: string, reasonCode: string, reason: string, candidate: Object|null, candidates: Array}}
 */
function familyModuleResolution(opts = {}) {
  const env = opts.env || process.env;
  if (!opts.fresh && opts.env === undefined && familyModuleResolutionCache) {
    return familyModuleResolutionCache;
  }

  const candidates = familyModuleCandidates(env);
  const existing = candidates.filter((c) => fs.existsSync(c.path));

  let resolution;
  if (existing.length === 0) {
    resolution = {
      module: null,
      path: null,
      source: 'mirror',
      reasonCode: 'absent',
      reason:
        'no canonical model-family module was found in any known layout ' +
        `(${candidates.map((c) => c.path).join(', ')}); the config-time guard is ` +
        'running the MIRRORED family map',
      candidate: null,
      candidates,
    };
  } else {
    const candidate = existing[0];
    let mod = null;
    let reasonCode = 'absent';
    let reason = '';
    try {
      mod = require(candidate.path);
      if (!mod || typeof mod.resolveModelFamily !== 'function') {
        reasonCode = 'invalid';
        reason =
          `the canonical model-family module at ${candidate.path} (${candidate.source}) ` +
          'does not export resolveModelFamily; the config-time guard is running the ' +
          'MIRRORED family map';
        mod = null;
      }
    } catch (err) {
      reasonCode = 'load-failed';
      reason =
        `the canonical model-family module at ${candidate.path} (${candidate.source}) ` +
        `could not be loaded (${err && err.message ? err.message : String(err)}); ` +
        'the config-time guard is running the MIRRORED family map';
      mod = null;
    }
    resolution = {
      module: mod,
      path: mod ? candidate.path : null,
      source: mod ? 'live' : 'mirror',
      reasonCode: mod ? 'resolved' : reasonCode,
      reason: mod ? '' : reason,
      candidate,
      candidates,
    };
  }

  // A load failure is never silent. The 'absent' case is normal (the
  // published npm package ships no backend/), so it is not warned about.
  if (resolution.reasonCode === 'load-failed' || resolution.reasonCode === 'invalid') {
    // eslint-disable-next-line no-console
    console.warn(`[aware-config] judge-family: ${resolution.reason}`);
  }

  if (opts.env === undefined && !opts.fresh) {
    familyModuleResolutionCache = resolution;
  }
  return resolution;
}

/**
 * Forget the cached live-module resolution. Test-only: the resolution is
 * cached for the process lifetime because the live tree does not change
 * under a running coordinator.
 */
function resetFamilyModuleCache() {
  familyModuleResolutionCache = undefined;
}

/**
 * Prefer the LIVE canonical family module, so the config-time guard cannot
 * drift from the producer's runtime guard. Falls back to the mirrored
 * implementation when the canonical copy is absent (the published npm
 * package ships `src/config/` but NOT `backend/`).
 *
 * require() of an ES module works on Node >= 22.12; on an older runtime
 * the load fails and the reason is RECORDED (see `familyModuleResolution`)
 * rather than swallowed.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.env]
 * @param {boolean} [opts.fresh]
 * @returns {Object|null}
 */
function resolveFamilyModule(opts = {}) {
  return familyModuleResolution(opts).module;
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
  return sameModelFamilyWithResolver(candidateModel, judgeModel, resolveModelFamily);
}

/**
 * The SAME-FAMILY comparison, over an EXPLICIT resolver.
 *
 * This is the mirror's OWN algorithm, parameterised by the way a model id is
 * resolved. `sameModelFamily` passes the LIVE resolver (the canonical
 * producer module when it is present, the mirrored rules otherwise); the
 * drift test passes a resolver backed ONLY by the mirrored rules, so the
 * mirror's own rule logic — the prefix threshold, the lineage fallback —
 * is the thing actually under test.
 *
 * Before t_8b44fe9d the mirror's own implementation was never executed by
 * the suite in a tree where the vendored copy was present: the mirror
 * delegated to the producer, so the drift test compared the producer
 * against ITSELF, and a mutation of the mirror's prefix threshold
 * (`>= 3` -> `>= 6`) passed the whole suite.
 *
 * @param {*} candidateModel
 * @param {*} judgeModel
 * @param {function(*): {group: string, family: string, corpusTrained: boolean}} resolve
 * @returns {boolean}
 */
function sameModelFamilyWithResolver(candidateModel, judgeModel, resolve) {
  const a = resolve(candidateModel).group;
  const b = resolve(judgeModel).group;
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && longer.startsWith(shorter);
}

/**
 * The mirror's OWN same-family comparison, driven ONLY by the mirrored
 * rule tables — never by the live canonical module.
 *
 * This is the implementation that runs wherever the canonical module cannot
 * be loaded (the published npm package, and the deployed image before
 * t_8b44fe9d fixed the resolver's path).
 *
 * @param {*} candidateModel
 * @param {*} judgeModel
 * @param {Array} [rules]
 * @returns {boolean}
 */
function sameModelFamilyFromRules(candidateModel, judgeModel, rules = MIRRORED_MODEL_FAMILY_RULES) {
  return sameModelFamilyWithResolver(
    candidateModel,
    judgeModel,
    (model) => resolveModelFamilyFromRules(model, rules)
  );
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
  return isIndependentJudgeWithResolver(candidateModel, judgeModel, resolveModelFamily);
}

/**
 * The INDEPENDENCE rule, over an EXPLICIT resolver.
 *
 * The same-family comparison is made with the SAME resolver, so a caller
 * that exercises the mirror's own rules exercises the mirror's own
 * same-family rule too — not the live module's.
 *
 * @param {*} candidateModel
 * @param {*} judgeModel
 * @param {function(*): {group: string, family: string, corpusTrained: boolean}} resolve
 * @returns {boolean}
 */
function isIndependentJudgeWithResolver(candidateModel, judgeModel, resolve) {
  const candidate = resolve(candidateModel);
  const judge = resolve(judgeModel);
  if (!candidate.family || !judge.family) return false;
  if (judge.corpusTrained) return false;
  return !sameModelFamilyWithResolver(candidateModel, judgeModel, resolve);
}

/**
 * The mirror's OWN independence rule, driven ONLY by the mirrored rule
 * tables — never by the live canonical module.
 *
 * @param {*} candidateModel
 * @param {*} judgeModel
 * @param {Array} [rules]
 * @returns {boolean}
 */
function isIndependentJudgeFromRules(candidateModel, judgeModel, rules = MIRRORED_MODEL_FAMILY_RULES) {
  return isIndependentJudgeWithResolver(
    candidateModel,
    judgeModel,
    (model) => resolveModelFamilyFromRules(model, rules)
  );
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
  // The mirror's OWN rule-driven resolver. `resolveModelFamily` delegates to
  // the live canonical producer module whenever it is present, so this
  // export is the only way to exercise the mirrored ALGORITHM itself.
  resolveModelFamilyFromRules,
  // The mirror's OWN same-family and independence rules, driven ONLY by the
  // mirrored rule tables. Without these the suite cannot detect a mutation
  // of the mirror's own algorithm (its prefix threshold, its lineage
  // fallback) in a tree where the canonical module IS present — the mirror
  // delegates, so the drift test compared the producer against itself.
  // (t_8b44fe9d)
  sameModelFamilyFromRules,
  isIndependentJudgeFromRules,
  // The rule logic, parameterised by an explicit resolver.
  sameModelFamilyWithResolver,
  isIndependentJudgeWithResolver,
  // The live-module resolution, WITH the reason it succeeded or failed.
  // `resolveFamilyModule()` alone cannot distinguish "no canonical module
  // anywhere" from "the canonical module is there but could not be loaded",
  // which is exactly the silent degradation t_8b44fe9d exists to remove.
  familyModuleResolution,
  familyModuleCandidates,
  resetFamilyModuleCache,
};
