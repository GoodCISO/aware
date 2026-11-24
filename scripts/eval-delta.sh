#!/usr/bin/env bash
# scripts/eval-delta.sh — Phase 4 D5: compute the trained-vs-baseline delta.
#
# Reads eval results written by `npm run eval:baseline` / `npm run
# eval:trained` (or `node scripts/run-eval-baseline.mjs`), computes the
# per-benchmark and aggregate accuracy delta, and prints a PASS/FAIL
# verdict.
#
# MEASURED NULL BAND (this host, qwen3.5:9b, in-repo 5+5 fixture)
# ------------------------------------------------------------------
# Before this change the gate was `trained.mean >= baseline.mean + 3pp`
# (ADR (internal) Phase 4 D5). The SAME command run twice returned
# accuracy 0.40 then 0.50 -- and five measured draws spanned 40.0pp to
# 60.0pp, a 20pp swing -- so the 3pp gate sat INSIDE the noise it was
# meant to detect, 6.7x narrower than it. The paper this card follows
# (arXiv:2611.14068 section 9) says to "run two or more null draws, the
# same policy on the same seeds, before reading any arm, report every
# control as a draw with its null center rather than as a point, and
# judge each comparison by its own paired interval, using the null
# draws to check the noise that interval assumes."
#
# Measured null band, SAME model on the SAME fixtures, N=5 draws each:
#
#   regime                          n   mean      sd      range   95% t CI
#   ------------------------------- --- --------- ------- ------- ------------------
#   unseeded (pre-change request)    5  50.0pp    7.1pp   20.0pp  [32.5pp, 67.5pp]
#   seeded (seed=20261123, T=0)     5  50.0pp    0.0pp    0.0pp  [50.0pp, 50.0pp]
#
# Full draw-by-draw data and the reproduction commands:
#   docs/research/aware-eval-null-band-2026-11-23.md
#   docs/research/aware-eval-null-band-2026-11-23.json
#
# THE DEFAULT THRESHOLD IS DERIVED FROM THE BAND, NOT FROM A CONSTANT.
# `--target` overrides it, but the default is:
#
#   threshold = max(3pp [the historical ADR target],
#                   the measured null band RANGE of each arm)
#
# so the gate is never inside the noise band. Note that the seeded
# band's 0.0pp range is a property of THIS model at THIS temperature on
# THIS fixture set -- not a guarantee -- so the band is measured at
# comparison time rather than hard-coded.
#
# THE VERDICT IS A PAIRED ONE. When both arms are band files with
# per-problem scores, the two arms are paired draw-by-draw and
# problem-by-problem, and the verdict requires BOTH:
#
#   (a) the paired mean delta >= threshold, and
#   (b) the paired 95% t interval EXCLUDES ZERO (its lower bound > 0).
#
# A single-draw comparison cannot satisfy (b) and is reported
# INDETERMINATE with exit code 1 -- a point estimate from one draw is
# not a comparison.
#
# Usage:
#   ./scripts/eval-delta.sh                       # picks newest baseline + newest trained
#   ./scripts/eval-delta.sh --target=0.03         # override the threshold
#   ./scripts/eval-delta.sh --results-dir=./foo   # use a different output dir
#   ./scripts/eval-delta.sh --baseline=./a.json --trained=./b.json
#
# Env vars (all optional):
#   AWARE_EVAL_OUTPUT_DIR  default: ./eval-results
#   AWARE_EVAL_TARGET_PP   default: (derived from the measured band)
#
# Exit codes:
#   0 = PASS (paired delta >= threshold AND paired CI excludes zero)
#   1 = FAIL (delta < threshold, CI includes zero, or inputs are single draws)
#   2 = operator error (bad args, missing files)

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────
OUTPUT_DIR="${AWARE_EVAL_OUTPUT_DIR:-./eval-results}"
TARGET_PP="${AWARE_EVAL_TARGET_PP:-}"
BASELINE_JSON=""
TRAINED_JSON=""

# The historical ADR (internal) Phase 4 D5 target. It is the FLOOR of
# the derived threshold, never the whole of it.
HISTORICAL_TARGET_PP="0.03"

# ─── Arg parse ──────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --target=*)      TARGET_PP="${arg#*=}" ;;
    --results-dir=*) OUTPUT_DIR="${arg#*=}" ;;
    --baseline=*)    BASELINE_JSON="${arg#*=}" ;;
    --trained=*)     TRAINED_JSON="${arg#*=}" ;;
    -h|--help)
      sed -n '2,80p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

# ─── Color helpers ──────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YEL=""; C_BLU=""; C_DIM=""; C_RST=""
fi
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RST" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YEL" "$C_RST" "$*"; }
fail() { printf '%s✗%s %s\n' "$C_RED" "$C_RST" "$*" >&2; exit 1; }
step() { printf '\n%s==>%s %s\n' "$C_BLU" "$C_RST" "$*"; }

# ─── Find inputs ────────────────────────────────────────────────────
if [ ! -d "$OUTPUT_DIR" ] && [ -z "$BASELINE_JSON" ]; then
  fail "output dir '$OUTPUT_DIR' does not exist. Run: npm run eval:baseline && npm run eval:trained"
fi

# Prefer a BAND file over a single-draw file: the band file carries the
# per-problem scores the paired comparison needs.
if [ -z "$BASELINE_JSON" ]; then
  BASELINE_JSON=$(ls -1 "$OUTPUT_DIR"/*-baseline-band.json 2>/dev/null | sort | tail -1 || true)
  if [ -z "$BASELINE_JSON" ]; then
    BASELINE_JSON=$(ls -1 "$OUTPUT_DIR"/*-baseline.json 2>/dev/null | sort | tail -1 || true)
  fi
fi
if [ -z "$TRAINED_JSON" ]; then
  TRAINED_JSON=$(ls -1 "$OUTPUT_DIR"/*-trained-band.json 2>/dev/null | sort | tail -1 || true)
  if [ -z "$TRAINED_JSON" ]; then
    TRAINED_JSON=$(ls -1 "$OUTPUT_DIR"/*-trained.json 2>/dev/null | sort | tail -1 || true)
  fi
fi

if [ -z "$BASELINE_JSON" ]; then
  fail "no *-baseline.json (or *-baseline-band.json) in $OUTPUT_DIR. Run: npm run eval:baseline"
fi
if [ -z "$TRAINED_JSON" ]; then
  fail "no *-trained.json (or *-trained-band.json) in $OUTPUT_DIR. Run: npm run eval:trained (after the trainer produces weights)"
fi

# An explicitly named input must exist. Without this check the
# comparison dies in node with a stack trace instead of naming the
# missing file.
if [ ! -f "$BASELINE_JSON" ]; then
  fail "baseline file '$BASELINE_JSON' does not exist."
fi
if [ ! -f "$TRAINED_JSON" ]; then
  fail "trained file '$TRAINED_JSON' does not exist."
fi

step "Inputs"
log_n() { printf '  %-22s %s\n' "$1" "$2"; }
log_n "baseline" "$(basename "$BASELINE_JSON")"
log_n "trained"  "$(basename "$TRAINED_JSON")"

# ─── Compare ────────────────────────────────────────────────────────
# The comparison lives in node (no jq dependency), same as before.
node -e '
  const fs = require("node:fs");
  const path = require("node:path");

  const baselinePath = process.argv[1];
  const trainedPath = process.argv[2];
  const targetOverride = process.argv[3];
  const historicalTarget = parseFloat(process.argv[4]);

  const fmt = (n) => (Number.isFinite(n) ? (n * 100).toFixed(1) + "pp" : "n/a");

  function load(p) {
    const r = JSON.parse(fs.readFileSync(p, "utf8"));
    // A band file wraps the draws under `draws`; a single-draw result
    // file has the benchmark objects at the top level.
    const isBand = Array.isArray(r.draws) && r.draws.length > 0;
    const draws = isBand
      ? r.draws
      : [{
          drawId: 1,
          label: r.label,
          accuracy: r.accuracy,
          gsm8k: r.gsm8k?.accuracy,
          livecodebench: r.livecodebench?.accuracy,
          perProblem: [
            ...(r.gsm8k?.perProblem || []).map((p) => ({ id: p.id, score: p.score, detail: p.detail })),
            ...(r.livecodebench?.perProblem || []).map((p) => ({ id: p.id, score: p.score, detail: p.detail })),
          ],
        }];
    const accs = draws.map((d) => d.accuracy);
    const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
    const sd = accs.length > 1
      ? Math.sqrt(accs.reduce((a, b) => a + (b - mean) ** 2, 0) / (accs.length - 1))
      : NaN;
    return {
      path: p,
      isBand,
      n: draws.length,
      draws,
      accs,
      mean,
      sd,
      range: Math.max(...accs) - Math.min(...accs),
      label: r.label || path.basename(p),
      seed: r.seed ?? (r.draws ? r.seed : null) ?? null,
      temperature: r.temperature ?? null,
      modelDigest: r.modelIdentity?.digest ?? r.disclosure?.artefact?.modelDigest ?? null,
      harnessRevision: r.gitRevision?.revision ?? r.disclosure?.artefact?.harnessRevision ?? null,
    };
  }

  const b = load(baselinePath);
  const t = load(trainedPath);

  // ── Threshold derivation ───────────────────────────────────────────
  // The default threshold is the measured null band — the spread the
  // SAME model on the SAME fixtures shows — floored by the historical
  // ADR target. A gate inside the noise band is a gate that passes on
  // noise.
  //
  // Both arms contribute a null band: each arm mean carries its own
  // draw noise, and a threshold below either arm band is below the
  // noise the comparison carries.
  const bandSources = [];
  let derived = historicalTarget;
  bandSources.push(`historical ADR target ${fmt(historicalTarget)}`);
  for (const [name, arm] of [["baseline", b], ["trained", t]]) {
    if (Number.isFinite(arm.range) && arm.range > 0) {
      if (arm.range > derived) derived = arm.range;
      bandSources.push(`${name} null band range ${fmt(arm.range)} (n=${arm.n})`);
    }
  }
  let target = derived;
  let targetSource = "derived from " + bandSources.join(" + ");
  if (targetOverride !== undefined && targetOverride !== "") {
    target = parseFloat(targetOverride);
    targetSource = `operator override (${fmt(target)})`;
    if (target < derived) {
      console.log("");
      console.log("  ⚠ operator override is BELOW the measured null band.");
      console.log(`    derived threshold would be ${fmt(derived)} (${bandSources.join(" + ")}).`);
      console.log("    A threshold inside the null band passes on noise. Proceeding as instructed.");
      console.log("");
    }
  }

  // ── Paired comparison ──────────────────────────────────────────────
  // Pair draw-by-draw and problem-by-problem. Pairing removes the
  // scenario component: a difference is "how much did this arm move on
  // this problem", not "what did each arm score in total".
  const pairs = [];
  const unmatched = [];
  const nPairs = Math.min(b.draws.length, t.draws.length);
  for (let i = 0; i < nPairs; i++) {
    const bd = b.draws[i];
    const td = t.draws[i];
    const bMap = new Map((bd.perProblem || []).map((p) => [p.id, p.score]));
    const tMap = new Map((td.perProblem || []).map((p) => [p.id, p.score]));
    for (const id of new Set([...bMap.keys(), ...tMap.keys()])) {
      if (!bMap.has(id) || !tMap.has(id)) { unmatched.push(`draw${i + 1}:${id}`); continue; }
      // The published accuracy counts a problem as correct when its
      // score is >= 1.0 (a LiveCodeBench score is a FRACTION). The
      // paired difference therefore differences the BINARY PASS
      // INDICATOR, so the paired mean equals the difference in the
      // published mean accuracy exactly.
      const pass = (s) => (Number.isFinite(s) && s >= 1.0 ? 1 : 0);
      pairs.push({
        draw: i + 1, id,
        base: bMap.get(id), arm: tMap.get(id),
        diff: pass(tMap.get(id)) - pass(bMap.get(id)),
        rawDiff: tMap.get(id) - bMap.get(id),
      });
    }
  }

  const diffs = pairs.map((p) => p.diff);
  const wins = diffs.filter((d) => d > 0).length;
  const losses = diffs.filter((d) => d < 0).length;
  const ties = diffs.length - wins - losses;
  const pairedMean = diffs.length ? diffs.reduce((a, x) => a + x, 0) / diffs.length : NaN;
  const pairedSd = diffs.length > 1
    ? Math.sqrt(diffs.reduce((a, x) => a + (x - pairedMean) ** 2, 0) / (diffs.length - 1))
    : NaN;

  // 95% t interval over the paired differences.
  const T = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228 };
  let ciLow = NaN, ciHigh = NaN, ciKind = "none (fewer than 2 paired differences)";
  if (diffs.length > 1) {
    const df = diffs.length - 1;
    const t = T[df] ?? 1.96;
    const half = (t * pairedSd) / Math.sqrt(diffs.length);
    ciLow = pairedMean - half;
    ciHigh = pairedMean + half;
    ciKind = `t interval over ${diffs.length} paired differences (95%, df=${df}, t=${t})`;
  } else if (diffs.length === 1) {
    ciKind = "none (a single paired difference has no spread to state)";
  }

  // ── Verdict ────────────────────────────────────────────────────────
  let verdict;
  let reason;
  const bothBands = b.isBand && t.isBand;
  if (!bothBands || b.n < 2 || t.n < 2) {
    verdict = "INDETERMINATE";
    reason = "one or both arms is a SINGLE draw — a point estimate from one draw is not a comparison. " +
      "Re-run both arms with --draws>=2 to get a null band and a paired interval.";
  } else if (!Number.isFinite(pairedMean)) {
    verdict = "INDETERMINATE";
    reason = "no paired differences could be formed (the arms share no problem ids).";
  } else if (pairedMean < target) {
    verdict = "FAIL";
    reason = `paired mean delta ${fmt(pairedMean)} is below the threshold ${fmt(target)}.`;
  } else if (!(ciLow > 0)) {
    verdict = "FAIL";
    reason = `paired mean delta ${fmt(pairedMean)} meets the threshold, but the paired 95% interval ` +
      `[${fmt(ciLow)}, ${fmt(ciHigh)}] does not exclude zero — the difference is not distinguishable from the null band.`;
  } else {
    verdict = "PASS";
    reason = `paired mean delta ${fmt(pairedMean)} >= threshold ${fmt(target)} and the paired 95% interval ` +
      `[${fmt(ciLow)}, ${fmt(ciHigh)}] excludes zero.`;
  }

  // ── Report ─────────────────────────────────────────────────────────
  console.log("");
  console.log("  benchmark         baseline   trained    delta");
  console.log("  ──────────────── ──────── ──────── ────────");
  const row = (name, bv, tv) => {
    const d = Number.isFinite(bv) && Number.isFinite(tv) ? tv - bv : NaN;
    return `  ${name.padEnd(13)} ${fmt(bv).padStart(7)} → ${fmt(tv).padStart(7)}    ` +
      `${(Number.isFinite(d) ? (d >= 0 ? "+" : "") + (d * 100).toFixed(1) + "pp" : "n/a").padStart(7)}`;
  };
  const bG = b.draws[0].gsm8k, bL = b.draws[0].livecodebench;
  const tG = t.draws[0].gsm8k, tL = t.draws[0].livecodebench;
  console.log(row("gsm8k",         bG, tG));
  console.log(row("livecodebench", bL, tL));
  console.log(row("mean",          b.mean, t.mean));
  console.log("");

  console.log("  Artefact identity:");
  console.log(`    baseline digest:   ${b.modelDigest || "UNKNOWN"}`);
  console.log(`    trained  digest:   ${t.modelDigest || "UNKNOWN"}`);
  console.log(`    baseline revision: ${(b.harnessRevision || "UNKNOWN").slice(0, 12)}`);
  console.log(`    trained  revision: ${(t.harnessRevision || "UNKNOWN").slice(0, 12)}`);
  if (b.modelDigest && t.modelDigest && b.modelDigest !== t.modelDigest) {
    console.log("    ⚠ the two arms ran against DIFFERENT model digests — this is not a like-for-like comparison.");
  }
  console.log("");

  console.log("  Null band of the CONTROL arm (the same model on the same fixtures):");
  console.log(`    draws:      ${b.n}   accuracies: ${b.accs.map((a) => fmt(a)).join(", ")}`);
  console.log(`    center:     ${fmt(b.mean)}   sd: ${fmt(b.sd)}   range: ${fmt(b.range)}`);
  console.log("");

  console.log("  Threshold:");
  console.log(`    ${fmt(target)}   (${targetSource})`);
  console.log("");

  console.log("  Paired comparison (draw-by-draw, problem-by-problem):");
  console.log(`    paired differences: ${diffs.length}   wins ${wins} / losses ${losses} / ties ${ties}`);
  console.log(`    paired mean delta: ${fmt(pairedMean)}   sd: ${fmt(pairedSd)}`);
  const rawMean = pairs.length ? pairs.reduce((a, p) => a + p.rawDiff, 0) / pairs.length : NaN;
  console.log(`    (criterion: binary pass, score >= 1.0; raw-score mean delta ${fmt(rawMean)})`);
  console.log(`    paired 95% CI:     [${fmt(ciLow)}, ${fmt(ciHigh)}]   (${ciKind})`);
  if (unmatched.length) {
    console.log(`    ⚠ ${unmatched.length} problem id(s) could not be paired: ${unmatched.join(", ")}`);
  }
  console.log("");

  console.log("  verdict: " + verdict);
  console.log("  reason:  " + reason);
  if (verdict === "FAIL" && Number.isFinite(pairedSd) && pairedSd > 0) {
    const needed = Math.ceil(Math.pow((1.96 * pairedSd) / target, 2));
    console.log("");
    console.log(`  Fixture count required to resolve a ${fmt(target)} effect at 95% confidence with this`);
    console.log(`  observed paired sd (${fmt(pairedSd)}): ~${needed} paired problems ` +
      `(the current fixture set has ${pairs.length ? new Set(pairs.map((p) => p.id)).size : 0}).`);
  }
  console.log("");

  process.exit(verdict === "PASS" ? 0 : 1);
' "$BASELINE_JSON" "$TRAINED_JSON" "$TARGET_PP" "$HISTORICAL_TARGET_PP"
