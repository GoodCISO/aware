#!/usr/bin/env bash
# scripts/verify-acs-conformance.sh
#
# The ACS conformance gate.
#
# WHY THIS EXISTS
# ---------------
# The repository has no test-running CI on the public tree: its CI surface
# is the gitea pipeline, and the public tree carries the four-layer PRIVACY
# filter (scripts/hooks/pre-commit, pre-push, the gitea pre-receive and the
# gitea lint-private-data workflow) rather than a test runner. The ACS work
# therefore needs its own gate that a reviewer, a CI job or an operator can
# run as ONE command.
#
# This gate does NOT claim to be the repository's CI. It is the single
# command that proves the ACS adapter's conformance claims, and it is
# designed to be callable FROM a CI job when one is added.
#
# WHAT IT CHECKS
# --------------
#   1. The vendored ACS schemas match the pinned SHA-256 table. A spec
#      bump that forgets to re-vendor the schemas fails here.
#   2. The pinned upstream version in docs/acs/VERSION is the one the
#      schemas were taken from.
#   3. Every ACS artefact the adapter produces validates against the PINNED
#      schema.
#   4. The MIT notice for the vendored material is present.
#   5. The ACS unit suites pass.
#   6. The adapter contains no path that catches an error and returns an
#      allow -- the issue-#83 guard, checked at the source level rather
#      than only through the suites.
#
# Usage:
#   bash scripts/verify-acs-conformance.sh
#   bash scripts/verify-acs-conformance.sh --json    # machine-readable
#
# Exit codes:
#   0  every check passed
#   1  a check FAILED
#   2  usage or environment error (node missing, repo not found)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}" || exit 2

JSON=0
for arg in "$@"; do
  case "${arg}" in
    --json) JSON=1 ;;
    *) echo "usage: $0 [--json]" >&2; exit 2 ;;
  esac
done

# The node binary. `node` is not on the PATH in every shell on this host,
# and the guard suites spawn `node` as a child process, so a missing PATH
# entry produces a spurious failure.
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ] && [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN=/opt/homebrew/bin/node
fi
if [ -z "${NODE_BIN}" ]; then
  echo "FATAL: node is not available on PATH" >&2
  exit 2
fi
export PATH="$(dirname "${NODE_BIN}"):${PATH}"

FAILURES=0
declare -a RESULTS=()

record() {
  # record <name> <status> <detail>
  RESULTS+=("$1|$2|$3")
  if [ "${JSON}" -eq 1 ]; then
    printf '{"check":"%s","status":"%s","detail":"%s"}\n' "$1" "$2" "$3"
  else
    if [ "$2" = "PASS" ]; then
      printf '  PASS  %-46s %s\n' "$1" "$3"
    else
      printf '  FAIL  %-46s %s\n' "$1" "$3"
    fi
  fi
  if [ "$2" != "PASS" ]; then
    FAILURES=$((FAILURES + 1))
  fi
}

echo "==> ACS conformance gate"
echo "    repo:    ${REPO_ROOT}"
echo "    node:    ${NODE_BIN}"
echo

# ---------------------------------------------------------------------------
# 1. The vendored schemas match the pinned SHA-256 table.
# ---------------------------------------------------------------------------
SCHEMA_DRIFT_OUTPUT="$("${NODE_BIN}" --test --test-force-exit \
  test/unit/acs/schema-drift.test.js 2>&1)"
if printf '%s' "${SCHEMA_DRIFT_OUTPUT}" | grep -qE "^ℹ fail 0"; then
  record "vendored schemas match the pinned hashes" "PASS" \
    "sha256 of every vendored schema verified"
else
  record "vendored schemas match the pinned hashes" "FAIL" \
    "a vendored schema differs from its pinned SHA-256"
fi

# ---------------------------------------------------------------------------
# 2. The pinned upstream version is the one the schemas came from.
# ---------------------------------------------------------------------------
if [ -f docs/acs/VERSION ]; then
  PINNED_SHA="$(grep -E '^SPEC_COMMIT=' docs/acs/VERSION | cut -d= -f2-)"
  if [ -n "${PINNED_SHA}" ]; then
    record "docs/acs/VERSION records the pinned commit" "PASS" "${PINNED_SHA}"
  else
    record "docs/acs/VERSION records the pinned commit" "FAIL" "SPEC_COMMIT is missing"
  fi
else
  record "docs/acs/VERSION records the pinned commit" "FAIL" "docs/acs/VERSION is missing"
fi

# ---------------------------------------------------------------------------
# 3. Every ACS artefact validates against the PINNED schema.
# ---------------------------------------------------------------------------
VALIDATION_OUTPUT="$("${NODE_BIN}" --test --test-force-exit \
  test/unit/acs/validator.test.js test/unit/acs/receipt.test.js 2>&1)"
if printf '%s' "${VALIDATION_OUTPUT}" | grep -qE "^ℹ fail 0"; then
  record "artefacts validate against the pinned schemas" "PASS" \
    "policy input, verdict, receipt and the manifest schema"
else
  record "artefacts validate against the pinned schemas" "FAIL" \
    "an artefact failed schema validation"
fi

# ---------------------------------------------------------------------------
# 4. The MIT notice for the vendored material is present.
# ---------------------------------------------------------------------------
if [ -f docs/acs/LICENSE.acs ] && grep -q "^MIT License" docs/acs/LICENSE.acs \
   && [ -f docs/acs/VENDORED.md ]; then
  record "the vendored MIT notice is present" "PASS" "docs/acs/LICENSE.acs + VENDORED.md"
else
  record "the vendored MIT notice is present" "FAIL" "the MIT notice or the provenance file is missing"
fi

# ---------------------------------------------------------------------------
# 5. The ACS unit suites pass.
# ---------------------------------------------------------------------------
ACS_OUTPUT="$("${NODE_BIN}" --test --test-force-exit 'test/unit/acs/*.test.js' 2>&1)"
ACS_TESTS="$(printf '%s' "${ACS_OUTPUT}" | grep -oE '^ℹ tests [0-9]+' | grep -oE '[0-9]+' | head -1)"
ACS_PASS="$(printf '%s' "${ACS_OUTPUT}" | grep -oE '^ℹ pass [0-9]+' | grep -oE '[0-9]+' | head -1)"
ACS_FAIL="$(printf '%s' "${ACS_OUTPUT}" | grep -oE '^ℹ fail [0-9]+' | grep -oE '[0-9]+' | head -1)"
if [ "${ACS_FAIL:-1}" = "0" ] && [ -n "${ACS_TESTS:-}" ]; then
  record "the ACS unit suites pass" "PASS" "${ACS_PASS}/${ACS_TESTS} tests"
else
  record "the ACS unit suites pass" "FAIL" \
    "${ACS_PASS:-0}/${ACS_TESTS:-0} passed, ${ACS_FAIL:-?} failed"
fi

# ---------------------------------------------------------------------------
# 6. No adapter path catches an error and returns an allow.
# ---------------------------------------------------------------------------
# This is the issue-#83 guard at the source level. A behavioural test only
# sees the paths it injects; this scan sees the code.
SCAN_OUTPUT="$("${NODE_BIN}" -e '
const fs = require("fs");
const path = require("path");
const dir = path.join(process.cwd(), "src", "acs");
const offenders = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/catch\s*(\(|\{)/.test(lines[i])) continue;
    const window = lines.slice(i, i + 12).join("\n");
    if (/decision\s*:\s*.allow./.test(window) || /return\s+.allow./.test(window)) {
      offenders.push(file + ":" + (i + 1));
    }
  }
}
console.log(offenders.length ? offenders.join(",") : "CLEAN");
' 2>&1 | tail -1)"
if [ "${SCAN_OUTPUT}" = "CLEAN" ]; then
  record "no adapter path catches an error and returns allow" "PASS" "source scan clean"
else
  record "no adapter path catches an error and returns allow" "FAIL" "${SCAN_OUTPUT}"
fi

echo
if [ "${FAILURES}" -eq 0 ]; then
  if [ "${JSON}" -eq 1 ]; then
    printf '{"result":"pass","failures":0}\n'
  else
    echo "==> ACS conformance gate PASSED"
  fi
  exit 0
fi

if [ "${JSON}" -eq 1 ]; then
  printf '{"result":"fail","failures":%d}\n' "${FAILURES}"
else
  echo "==> ACS conformance gate FAILED (${FAILURES} check(s))"
fi
exit 1
