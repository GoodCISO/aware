#!/usr/bin/env bash
# test-eval-delta.sh — exercise scripts/eval-delta.sh against synthetic
# result files.
#
# This is a NEGATIVE-CONTROL harness: most cases must FAIL or be
# INDETERMINATE. A gate that passes everything is a gate that passes
# on noise, which is the exact defect this card fixes.
#
# Usage: bash test/unit/training/test-eval-delta.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# This file lives at test/unit/training/ — three levels below the repo root.
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DELTA="$REPO_ROOT/scripts/eval-delta.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

check() {
  local name="$1" expected_rc="$2" expected_pattern="$3"
  shift 3
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  local ok=1
  if [ "$rc" != "$expected_rc" ]; then
    ok=0
    echo "  ✗ $name: expected exit $expected_rc, got $rc"
    echo "$out" | sed 's/^/      | /'
  fi
  if [ -n "$expected_pattern" ] && ! printf '%s' "$out" | grep -qE "$expected_pattern"; then
    ok=0
    echo "  ✗ $name: output did not match /$expected_pattern/"
    echo "$out" | sed 's/^/      | /'
  fi
  if [ "$ok" = 1 ]; then
    PASS=$((PASS+1))
    echo "  ✓ $name"
  else
    FAIL=$((FAIL+1))
    echo "  ✗ $name (FAILED)"
  fi
}

# ── Fixture builders ─────────────────────────────────────────────────

# A single-draw result file (the pre-change shape, plus per-problem).
mk_single() {
  local file="$1" label="$2" acc="$3" gsm="$4" lcb="$5"
  cat > "$file" <<EOF
{
  "accuracy": $acc,
  "label": "$label",
  "modelName": "qwen3.5:9b",
  "gsm8k": { "name": "gsm8k", "total": 5, "correct": 4, "accuracy": $gsm, "perProblem": [
    { "id": "g1", "score": 1, "detail": "ok" },
    { "id": "g2", "score": 1, "detail": "ok" },
    { "id": "g3", "score": 0, "detail": "no" },
    { "id": "g4", "score": 1, "detail": "ok" },
    { "id": "g5", "score": 0, "detail": "no" }
  ] },
  "livecodebench": { "name": "livecodebench", "total": 5, "correct": 3, "accuracy": $lcb, "perProblem": [
    { "id": "l1", "score": 1, "detail": "ok" },
    { "id": "l2", "score": 1, "detail": "ok" },
    { "id": "l3", "score": 0, "detail": "no" },
    { "id": "l4", "score": 1, "detail": "ok" },
    { "id": "l5", "score": 0, "detail": "no" }
  ] },
  "disclosure": { "artefact": { "modelDigest": "digest-abc" }, "sampling": {} }
}
EOF
}

# Per-draw helper: one draw object.
# draw <acc> <gsm> <lcb> <perProblem-json-array>
draw() {
  local acc="$1" gsm="$2" lcb="$3" ps="$4"
  echo "{\"drawId\": 1, \"label\": \"d\", \"accuracy\": $acc, \"gsm8k\": $gsm, \"livecodebench\": $lcb, \"perProblem\": $ps}"
}

# A band file with N draws and per-problem scores.
# mk_band <file> <label> <n> <acc1,acc2,...> <draws-json-array>
mk_band() {
  local file="$1" label="$2" n="$3" accs="$4" draws_json="$5"
  cat > "$file" <<EOF
{
  "label": "$label",
  "modelName": "qwen3.5:9b",
  "modelIdentity": { "digest": "digest-abc", "size": 100 },
  "gitRevision": { "revision": "rev1234567890" },
  "seed": 20261123,
  "temperature": 0,
  "n": $n,
  "accuracies": [$accs],
  "draws": $draws_json
}
EOF
}

# A band file whose two draws are IDENTICAL: the null band is
# zero-width (a deterministic arm), so only a real difference can pass.
mk_band_det() {
  local file="$1" label="$2" acc="$3" gsm="$4" lcb="$5" ps="$6"
  local d1 d2
  d1="$(draw "$acc" "$gsm" "$lcb" "$ps")"
  d2="$(draw "$acc" "$gsm" "$lcb" "$ps")"
  mk_band "$file" "$label" 2 "$acc, $acc" "[$d1, $d2]"
}

scores5() { echo '[{"id":"g1","score":1},{"id":"g2","score":1},{"id":"g3","score":0},{"id":"g4","score":1},{"id":"g5","score":0},{"id":"l1","score":1},{"id":"l2","score":1},{"id":"l3","score":0},{"id":"l4","score":1},{"id":"l5","score":0}]'; }

# All-perfect scores (the arm that wins everything).
scores5_all() { echo '[{"id":"g1","score":1},{"id":"g2","score":1},{"id":"g3","score":1},{"id":"g4","score":1},{"id":"g5","score":1},{"id":"l1","score":1},{"id":"l2","score":1},{"id":"l3","score":1},{"id":"l4","score":1},{"id":"l5","score":1}]'; }

echo ""
echo "eval-delta.sh behaviour tests"
echo ""

# ── Case 1: single-draw arms are INDETERMINATE ──────────────────────
# A point estimate from one draw is not a comparison. This must NOT pass.
mk_single "$WORK/b-single.json" baseline 0.5 0.6 0.4
mk_single "$WORK/t-single.json" trained 0.9 1.0 0.8
check "single-draw arms are INDETERMINATE, not PASS" 1 "verdict: INDETERMINATE" \
  bash "$DELTA" --baseline="$WORK/b-single.json" --trained="$WORK/t-single.json"

# ── Case 2: a large apparent delta on single draws still fails ──────
check "single draws with a huge delta still fail" 1 "verdict: INDETERMINATE" \
  bash "$DELTA" --baseline="$WORK/b-single.json" --trained="$WORK/t-single.json"

# ── Case 3: band vs band, no real difference → FAIL ─────────────────
mk_band_det "$WORK/b-band.json" baseline 0.5 0.6 0.4 "$(scores5)"
mk_band_det "$WORK/t-band.json" trained 0.5 0.6 0.4 "$(scores5)"
check "band vs band with zero difference does not PASS" 1 "verdict: FAIL" \
  bash "$DELTA" --baseline="$WORK/b-band.json" --trained="$WORK/t-band.json"

# ── Case 4: band vs band, the arm wins on every problem → PASS ──────
mk_band_det "$WORK/b-band2.json" baseline 0.5 0.6 0.4 "$(scores5)"
mk_band_det "$WORK/t-band2.json" trained 0.9 1.0 0.8 "$(scores5_all)"
check "an arm that wins every paired problem PASSES" 0 "verdict: PASS" \
  bash "$DELTA" --baseline="$WORK/b-band2.json" --trained="$WORK/t-band2.json"

# ── Case 5: the threshold is DERIVED from the measured band ─────────
# The baseline band is wide (0.4..0.6 = 20pp). The trained arm is only
# +2pp better on the mean. The derived threshold must be at least the
# 20pp band, so a +2pp difference must FAIL even though it clears the
# historical 3pp target.
B3="$(draw 0.4 0.5 0.3 "$(scores5)")"
B3b="$(draw 0.6 0.7 0.5 "$(scores5)")"
T3="$(draw 0.6 0.7 0.5 "$(scores5)")"
mk_band "$WORK/b-band3.json" baseline 2 "0.4, 0.6" "[$B3, $B3b]"
mk_band "$WORK/t-band3.json" trained 2 "0.6, 0.6" "[$T3, $T3]"
check "a +2pp difference fails against a 20pp measured band" 1 "verdict: FAIL" \
  bash "$DELTA" --baseline="$WORK/b-band3.json" --trained="$WORK/t-band3.json"

# ── Case 6: the report names the derived threshold ───────────────────
out="$("$DELTA" --baseline="$WORK/b-band3.json" --trained="$WORK/t-band3.json" 2>&1)"
if printf '%s' "$out" | grep -qE "null band range 20\.0pp"; then
  PASS=$((PASS+1)); echo "  ✓ the derived threshold names the measured band range"
else
  FAIL=$((FAIL+1)); echo "  ✗ the derived threshold does NOT name the measured band range"
  printf '%s\n' "$out" | sed 's/^/      | /'
fi

# ── Case 7: an operator override below the band warns ───────────────
out="$("$DELTA" --baseline="$WORK/b-band3.json" --trained="$WORK/t-band3.json" --target=0.03 2>&1)"
if printf '%s' "$out" | grep -qE "override is BELOW the measured null band"; then
  PASS=$((PASS+1)); echo "  ✓ an override below the band warns"
else
  FAIL=$((FAIL+1)); echo "  ✗ an override below the band does NOT warn"
  printf '%s\n' "$out" | sed 's/^/      | /'
fi

# ── Case 8: a missing input is an operator error ────────────────────
check "a missing trained file fails" 1 "does not exist" \
  bash "$DELTA" --baseline="$WORK/b-band.json" --trained="$WORK/does-not-exist.json"

# ── Case 9: the paired win count is reported ─────────────────────────
out="$("$DELTA" --baseline="$WORK/b-band2.json" --trained="$WORK/t-band2.json" 2>&1)"
if printf '%s' "$out" | grep -qE "paired differences: 20   wins 8 / losses 0 / ties 12"; then
  PASS=$((PASS+1)); echo "  ✓ the paired win/loss/tie count is reported"
else
  FAIL=$((FAIL+1)); echo "  ✗ the paired win/loss/tie count is NOT reported"
  printf '%s\n' "$out" | sed 's/^/      | /'
fi

# ── Case 10: the paired mean equals the published mean-accuracy delta
# The paired difference must be on the SAME scale as the published
# accuracy (binary pass), so the paired mean and the mean-accuracy
# delta agree. This catches a unit mismatch between the two.
out="$("$DELTA" --baseline="$WORK/b-band2.json" --trained="$WORK/t-band2.json" 2>&1)"
paired="$(printf '%s' "$out" | grep -oE 'paired mean delta: [-0-9.]+pp' | grep -oE '[-0-9.]+')"
meanrow="$(printf '%s' "$out" | grep -oE '^  mean .*' | grep -oE '\+[-0-9.]+pp' | tr -d '+pp')"
if [ -n "$paired" ] && [ -n "$meanrow" ] && [ "$paired" = "$meanrow" ]; then
  PASS=$((PASS+1)); echo "  ✓ the paired mean agrees with the published mean-accuracy delta"
else
  FAIL=$((FAIL+1)); echo "  ✗ the paired mean ($paired) disagrees with the published mean delta ($meanrow)"
  printf '%s\n' "$out" | sed 's/^/      | /'
fi

# ── Case 11: the artefact digests are reported and compared ─────────
out="$("$DELTA" --baseline="$WORK/b-band2.json" --trained="$WORK/t-band2.json" 2>&1)"
if printf '%s' "$out" | grep -qE "baseline digest:   digest-abc"; then
  PASS=$((PASS+1)); echo "  ✓ the artefact digest is reported"
else
  FAIL=$((FAIL+1)); echo "  ✗ the artefact digest is NOT reported"
  printf '%s\n' "$out" | sed 's/^/      | /'
fi

echo ""
echo "  passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
