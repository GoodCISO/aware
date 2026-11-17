// src/trainer/judge-role.js — the judge-role contract, AWARE-side (kanban t_155a95a1).
//
// Every evaluation needs a declared ROLE before it runs
// (`measurement-experimentation-ops/references/04-ai-product-evaluation.md:27-43`):
//
//   launch gate  — may block a launch
//   diagnostic   — finds the weakness; NEVER blocks
//   guardrail    — may block on its own, within a pre-set tolerance
//
// and the rule that matters for a judge:
//
//   "Same family -> the verdict is a DIAGNOSTIC, never a launch gate."
//   (04:187-190)
//
// The producer (backend/heavy-think/src/judge-role.js) writes three tags on
// every preference pair:
//
//   prm_score_role        — 'launch_gate' | 'diagnostic' | 'guardrail'
//   prm_score_independent — boolean
//   prm_score_judge_model — the judge's model / family id
//
// THIS MODULE IS THE AWARE-SIDE MIRROR of that contract, and it is a separate
// file on purpose: the published npm package ships `src/trainer/` but NOT
// `backend/`, so the trainer cannot import the producer's module. The two
// must stay in step -- `test/unit/trainer/judge-role.test.js` drift-checks
// the mirror against the producer's module whenever the vendored copy is
// present, the same way `test/unit/config/rlm-loader.test.js` drift-checks
// the verification-method list.

/**
 * The three roles, exactly as named in 04-ai-product-evaluation.md:16-21.
 */
export const JUDGE_ROLES = Object.freeze(['launch_gate', 'diagnostic', 'guardrail']);

/**
 * The role a judge gets when it is not known to be independent of the
 * candidate. "If you cannot name which of the three it is, it is a
 * diagnostic." (04:35-36) The safe default is the one that cannot gate.
 */
export const DEFAULT_JUDGE_ROLE = 'diagnostic';

/**
 * The roles whose verdict MAY decide membership of a training set. A
 * 'diagnostic' verdict never does (04:37-38).
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
 * Read the judge declaration off a preference record.
 *
 * The producer writes the role / independence / judge-model on the record AND
 * on both sides. A record written before that change carries none of them --
 * that is the legacy corpus, and "no declaration" means "diagnostic", never
 * "gate".
 *
 * If the record and its sides DISAGREE, the declaration is treated as
 * undeclared: a contradiction about who judged the pair is not evidence that
 * the judge was fit to gate.
 *
 * @param {Object} rec
 * @returns {{role: string|null, independent: boolean|null, judgeModel: string,
 *            declared: boolean, conflict: boolean}}
 */
export function judgeDeclaration(rec) {
  const sources = [rec, rec?.chosen, rec?.rejected].filter(
    (s) => s && typeof s === 'object'
  );
  const roles = new Set();
  const independents = new Set();
  let judgeModel = '';
  for (const src of sources) {
    if (typeof src.prm_score_role === 'string') roles.add(src.prm_score_role);
    if (typeof src.prm_score_independent === 'boolean') {
      independents.add(src.prm_score_independent);
    }
    if (!judgeModel && typeof src.prm_score_judge_model === 'string') {
      judgeModel = src.prm_score_judge_model;
    }
  }
  const conflict = roles.size > 1 || independents.size > 1;
  return {
    role: roles.size === 1 ? [...roles][0] : null,
    independent: independents.size === 1 ? [...independents][0] : null,
    judgeModel,
    declared: roles.size > 0 && independents.size > 0 && !conflict,
    conflict,
  };
}

/**
 * True when this record's judge MAY decide membership of the training set.
 *
 * Both conditions must hold (04:27-43, :187-190):
 *   - the judge is INDEPENDENT of the candidate (a different model family),
 *   - and its role is a gating role ('launch_gate' or 'guardrail').
 *
 * Independence is NECESSARY for a gate, not sufficient -- a gate still has to
 * be declared as one. Everything else (a same-family judge, a diagnostic
 * role, no declaration at all, a contradictory declaration) means the verdict
 * may not gate.
 *
 * @param {Object} rec
 * @returns {boolean}
 */
export function mayJudgeGate(rec) {
  const decl = judgeDeclaration(rec);
  if (decl.conflict || !decl.declared) return false;
  if (decl.independent !== true) return false;
  return GATING_JUDGE_ROLES.includes(decl.role);
}
