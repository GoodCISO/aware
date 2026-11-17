// src/judge-role.js — declare the ROLE of a judge score on every preference pair
// (kanban t_155a95a1; family comparison fixed by t_2a91cc4b).
//
// WHY THIS EXISTS
// ---------------
// The DPO training set was gated on a PRM judge that was never declared to be
// anything. Under `measurement-experimentation-ops/references/04-ai-product-evaluation.md`
// (the three roles: "launch gate" / "diagnostic" / "guardrail"):
//
//   - "Same family -> the verdict is a DIAGNOSTIC, never a launch gate."
//     (04:187-190)
//   - "Write the role on the eval ticket BEFORE the eval runs. If you cannot
//     name which of the three it is, it is a diagnostic." (04:35-36)
//
// In AWARE one client served BOTH the producer and the judge, so the judge was
// same-family by construction -- but its score was wired into a GATE position
// (the trainer's `min_score_gap` rule). Same-family + undeclared + gating is
// the contradiction this module removes.
//
// THE CONTRACT
// ------------
// Every preference pair carries, on BOTH sides and at the record level:
//
//   prm_score_role        -- 'launch_gate' | 'diagnostic' | 'guardrail'
//   prm_score_independent -- boolean. True only when the judge is a DIFFERENT
//                            model family from the candidate it grades.
//   prm_score_judge_model -- the judge's model / family id.
//
// The default role is 'diagnostic' (04:35-36). A diagnostic verdict must never
// gate anything, so the trainer's filter reads these tags before it lets a
// score decide membership of the training set.
//
// INDEPENDENCE IS COMPUTED, NOT ASSERTED
// ---------------------------------------
// `prm_score_independent` is a FACT about the client that served the judge,
// derived by comparing the judge's model FAMILY against the candidate's. A
// different serving path or a cheaper sibling is still the same family
// (audit t_8f049433 section 5.1: "What must NOT count as independence").
//
// The FAMILY comparison lives in `src/judge-family.js` — the canonical
// source for the family map. This module compares families, not model ids:
// an id comparison misses a cheaper sibling (`MiniMax-M3` judging
// `MiniMax-M3.1-Flash`), which is the defect t_2a91cc4b closed.
//
// Likewise, an explicit `role` request is honoured ONLY for an independent
// judge: a same-family judge is a diagnostic no matter what the caller asks
// for, because 04:187-190 says so in those words.

import {
  isIndependentJudge,
} from './judge-family.js';

export {
  normaliseModelId,
  sameModelFamily,
  isIndependentJudge,
  modelFamily,
  resolveModelFamily,
  isCorpusTrainedArtefact,
  MODEL_FAMILY_RULES,
  MODEL_FAMILY_GROUPS,
} from './judge-family.js';

/**
 * The three roles, exactly as named in 04-ai-product-evaluation.md:16-21.
 */
export const JUDGE_ROLES = Object.freeze(['launch_gate', 'diagnostic', 'guardrail']);

/**
 * The role a judge gets when it is not known to be independent of the
 * candidate. `04:35-36`: "If you cannot name which of the three it is, it
 * is a diagnostic." The safe default is the one that cannot gate.
 */
export const DEFAULT_JUDGE_ROLE = 'diagnostic';

/**
 * The roles whose verdict may decide membership of a training set. A
 * 'diagnostic' verdict never does.
 */
export const GATING_JUDGE_ROLES = Object.freeze(['launch_gate', 'guardrail']);

/**
 * True when `role` is one of the three declared roles.
 *
 * @param {*} role
 * @returns {boolean}
 */
export function isJudgeRole(role) {
  return typeof role === 'string' && JUDGE_ROLES.includes(role);
}

/**
 * Describe the judge that produced a score.
 *
 * @param {Object} [opts]
 * @param {string} [opts.candidateModel] -- the model that produced the trace
 * @param {string} [opts.judgeModel] -- the model that judged it
 * @param {string} [opts.role] -- an explicit role request. Honoured ONLY for
 *        an independent judge; a same-family judge is a diagnostic whatever
 *        the caller asks for (04:187-190).
 * @returns {{prm_score_role: string, prm_score_independent: boolean, prm_score_judge_model: string}}
 */
export function describeJudge(opts = {}) {
  const candidateModel = opts.candidateModel ?? null;
  const judgeModel = opts.judgeModel ?? null;

  // Independence is computed from the model FAMILIES. A judge whose family
  // cannot be named is NOT independent: "cannot name the judge" is not
  // evidence of independence. Symmetrically, a judge cannot be shown to be
  // in a DIFFERENT family when the CANDIDATE's family cannot be named —
  // "cannot place the candidate" is not evidence of independence either.
  //
  // The AWARE-trained LoRA artefact is NEVER independent, whatever the
  // candidate's family: it is the model the preference pairs TRAIN, so a
  // judge that is it is scoring with a model trained on the corpus it
  // selects (t_8f049433 section 5.1 -- "independence in the wrong
  // direction").
  const independent = isIndependentJudge(candidateModel, judgeModel);

  // The role. Independence is NECESSARY for a gate, not SUFFICIENT -- a gate
  // still has to be declared as one. But a same-family judge can never be
  // one, no matter what the caller requests.
  const role = (independent && isJudgeRole(opts.role)) ? opts.role : DEFAULT_JUDGE_ROLE;

  return {
    prm_score_role: role,
    prm_score_independent: independent,
    prm_score_judge_model: typeof judgeModel === 'string' ? judgeModel : '',
  };
}
