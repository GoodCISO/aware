// src/trainer/dpo-dataset.js — Phase 4 (ADR (internal) 618-627, ADR (internal) Repair 4)
//
// DPO dataset assembly. Converts filtered preference-pair records into
// DPO training rows in "messages" format, ready for Modal.
//
// This module was extracted from rl-pipeline's expected `toDpoDataset`
// surface (which was documented in redacted-internal-doc and referenced in
// trainer/index.js:593, but never actually exported from rl-pipeline
// — see ADR (internal) §Finding 4). Implementing it in AWARE keeps rl-pipeline
// as a K+S primitive (its actual job) and makes DPO assembly a trainer
// concern (where it logically belongs). The trainer is the only consumer
// of DPO-shaped output; it shouldn't depend on a sibling repo for that
// shape.
//
// Contract:
//   toDpoDataset(records, options) -> { rows, skipped: {lowGap, duplicate, invalid} }
//
//   records: Array<PreferenceRecord> — same shape as outcome-filter.js input:
//     { problem, chosen: {reasoning, prm_score}, rejected: {reasoning, prm_score},
//       _content_hash?: string, [other metadata] }
//
//   options:
//     format: 'messages' (only format supported)
//     minScoreGap: number — drop records where (chosen.prm_score -
//                              rejected.prm_score) < minScoreGap
//     dedupeByHash: boolean — drop records with duplicate _content_hash
//                              (first occurrence wins)
//
//   rows: Array<{ prompt, chosen, rejected }> where each is a
//         [{role: 'user'|'assistant', content: string}] messages array.
//
//   skipped: { lowGap, duplicate, invalid, mixedInstrument, nonIndependentJudge }
//            — counts of records dropped for each reason. Surfaced in
//            trainer's debug log.
//
// The function is pure — no I/O, no clock, no randomness. Safe to call
// from tests, from the trainer's main loop, or from a one-off CLI script.

import { mayJudgeGate } from './judge-role.js';

const SUPPORTED_FORMATS = new Set(['messages']);

// Score-instrument parity (2026-11-11, kanban t_99423c45).
//
// The producer writes `prm_score_source` on each side of a preference pair
// so the two are self-describing. Untagged sides predate that field; for
// those we fall back to the legacy heuristic-signature check (the old
// length heuristic only ever emitted 0.4 / 0.5 / 0.6 / 0.75).
const JUDGE_SCORE_SOURCE = 'prm_judge';
const LEGACY_HEURISTIC_BUCKETS = new Set([0.4, 0.5, 0.6, 0.75]);

/**
 * @param {number} score
 * @returns {boolean} true when `score` is one of the legacy heuristic buckets
 */
function isLegacyHeuristicBucket(score) {
  return LEGACY_HEURISTIC_BUCKETS.has(score);
}

/**
 * True when both sides of a pair carry scores produced by the same
 * instrument, and therefore their difference is meaningful.
 *
 * @param {Object} chosen
 * @param {Object} rejected
 * @returns {boolean}
 */
export function sameScoreInstrument(chosen, rejected) {
  const chosenSource = chosen?.prm_score_source;
  const rejectedSource = rejected?.prm_score_source;
  if (typeof chosenSource === 'string' || typeof rejectedSource === 'string') {
    return chosenSource === rejectedSource;
  }
  // Both untagged — legacy record. Detect the exact legacy signature:
  // chosen on a heuristic bucket while rejected is on any other value.
  const cs = chosen?.prm_score;
  const rs = rejected?.prm_score;
  if (typeof cs === 'number' && typeof rs === 'number') {
    if (isLegacyHeuristicBucket(cs) && !isLegacyHeuristicBucket(rs)) return false;
  }
  return true;
}

/**
 * @typedef {Object} PreferenceRecord
 * @property {string} problem
 * @property {{reasoning: string, prm_score?: number}} chosen
 * @property {{reasoning: string, prm_score?: number}} rejected
 * @property {string} [_content_hash]
 */

/**
 * @typedef {Object} DpoRow
 * @property {Array<{role: string, content: string}>} prompt
 * @property {Array<{role: string, content: string}>} chosen
 * @property {Array<{role: string, content: string}>} rejected
 */

/**
 * @typedef {Object} ToDpoOptions
 * @property {"messages"} [format="messages"]
 * @property {number} [minScoreGap=0.05]
 * @property {boolean} [dedupeByHash=true]
 */

/**
 * @typedef {Object} SkippedStats
 * @property {number} lowGap
 * @property {number} duplicate
 * @property {number} invalid
 * @property {number} mixedInstrument — pairs whose two sides carry scores
 *           from different instruments (the gap would be meaningless)
 * @property {number} nonIndependentJudge — pairs whose judge was not
 *           independent of the candidate (their verdict may not gate)
 * @property {number} inverted — pairs whose chosen side scored at or below
 *           their rejected side (the pair's labels contradict its own
 *           numbers — a defect in the PAIR, not a judgement about quality)
 */

/**
 * @typedef {Object} ToDpoResult
 * @property {DpoRow[]} rows
 * @property {SkippedStats} skipped
 */

/**
 * Convert preference-pair records into DPO training rows.
 *
 * Pure function — see module docstring for full contract.
 *
 * @param {PreferenceRecord[]} records
 * @param {ToDpoOptions} [options]
 * @returns {ToDpoResult}
 */
export function toDpoDataset(records, options = {}) {
  const format = options.format || 'messages';
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(
      `dpo-dataset: unknown format '${format}', expected one of: ` +
      [...SUPPORTED_FORMATS].join(', ')
    );
  }
  if (!Array.isArray(records)) {
    throw new Error('dpo-dataset: records must be an array');
  }

  const minScoreGap = typeof options.minScoreGap === 'number' ? options.minScoreGap : 0.05;
  const dedupeByHash = options.dedupeByHash !== false; // default true

  const rows = [];
  const skipped = {
    lowGap: 0,
    duplicate: 0,
    invalid: 0,
    mixedInstrument: 0,
    nonIndependentJudge: 0,
    inverted: 0,
  };
  const seenHashes = new Set();

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') {
      skipped.invalid += 1;
      continue;
    }
    const chosenReasoning = rec?.chosen?.reasoning;
    const rejectedReasoning = rec?.rejected?.reasoning;
    if (typeof chosenReasoning !== 'string' || typeof rejectedReasoning !== 'string') {
      skipped.invalid += 1;
      continue;
    }
    const chosenScore = rec?.chosen?.prm_score;
    const rejectedScore = rec?.rejected?.prm_score;
    // Instrument parity (2026-11-11, kanban t_99423c45). The gap below is
    // only a preference signal when both sides were produced by the SAME
    // instrument. A surrogate (e.g. the legacy length heuristic) scored
    // against a judge score yields a bogus gap — the exact defect that
    // dropped better-refined pairs as "inverted" (74,840 of 329,558 live
    // pairs). Skip such pairs here too, so the rule holds even when the
    // operator runs the outcome filter with rule='noop'.
    // JUDGE ROLE (2026-11-17, kanban t_155a95a1).
    //
    // The assembler's gap check is a QUALITY certification: "this pair is
    // good enough to train on". Only a judge that is independent of the
    // candidate AND declared with a gating role may certify that
    // (04-ai-product-evaluation.md:27-43, :187-190). For every other judge
    // the gap is a DIAGNOSTIC: the pair is admitted, the gap is not a reason
    // to exclude it, and the signal is preserved on the record for the
    // future independent judge and the human re-read slice.
    //
    // This is checked FIRST because it is the coarser question: a pair the
    // judge may not certify is not excluded on a gap computed by that judge.
    // The score-instrument PARITY check below is NOT affected -- it is about
    // the two sides being comparable at all (t_99423c45), not about
    // certifying quality, and it must keep running.
    //
    // NOTE: the counter for a demoted judge is incremented only when the
    // pair is ADMITTED (see below, just before the row is pushed). Counting
    // it here would report a DROPPED pair as "admitted on a diagnostic
    // signal" in the trainer's rowsDiagnostic (src/trainer/index.js) --
    // the operator would see a diagnostic count for pairs that never
    // reached the training set.
    const judgeMayGate = mayJudgeGate(rec);
    if (typeof chosenScore === 'number' && typeof rejectedScore === 'number') {
      if (!sameScoreInstrument(rec.chosen, rec.rejected)) {
        skipped.mixedInstrument += 1;
        continue;
      }
      const gap = chosenScore - rejectedScore;
      // DIRECTIONALITY (inverted pair) — 2026-11-17, kanban t_ebf7e27f.
      //
      // A pair whose chosen side scores at or BELOW its rejected side
      // contradicts its own labels: the "rejected" attempt is the better one
      // by the numbers on the record. That is a defect in the PAIR, not a
      // judgement about quality -- the same reasoning the outcome filter
      // gives at src/trainer/outcome-filter.js ("the pair's labels contradict
      // its own numbers, which is a defect in the PAIR, not a judgement
      // about quality"). It is therefore NOT demoted with the gap
      // magnitude: it stays OUTSIDE the judgeMayGate guard, so it holds for
      // every judge, including a same-family (non-gating) one.
      //
      // Before this check the assembler dropped an inverted pair only as a
      // side effect of the magnitude gate, so the demotion of that gate
      // (t_155a95a1) silently stopped dropping inverted pairs -- while the
      // outcome filter kept dropping them. The two paths disagreed, and the
      // `noop` filter rule let inverted pairs into the training set.
      if (gap <= 0) {
        skipped.inverted += 1;
        continue;
      }
      // GAP MAGNITUDE — a quality certification, so it is demoted for a
      // judge that may not gate (t_155a95a1). The signal is not lost: it
      // stays on the record and the filter reports it as a diagnostic.
      if (judgeMayGate && gap + 1e-9 < minScoreGap) {
        skipped.lowGap += 1;
        continue;
      }
    }
    // dedupeByHash filter — first occurrence wins. Honors content
    // hash set by rl-pipeline's preference-pair writer.
    if (dedupeByHash && rec._content_hash) {
      if (seenHashes.has(rec._content_hash)) {
        skipped.duplicate += 1;
        continue;
      }
      seenHashes.add(rec._content_hash);
    }
    // The pair is ADMITTED. Only now is the demoted-judge signal counted,
    // because it is a count of pairs admitted WITHOUT their score being
    // allowed to gate -- not a count of pairs the assembler looked at.
    if (!judgeMayGate) {
      skipped.nonIndependentJudge += 1;
    }
    rows.push({
      prompt: [{ role: 'user', content: rec.problem }],
      chosen: [{ role: 'assistant', content: chosenReasoning }],
      rejected: [{ role: 'assistant', content: rejectedReasoning }],
    });
  }

  return { rows, skipped };
}

/**
 * Return the canonical list of supported output format names. Exposed so
 * config.validate() and the bring-up smoke can assert the set hasn't
 * drifted.
 *
 * @returns {string[]}
 */
export function listDpoFormats() {
  return [...SUPPORTED_FORMATS];
}