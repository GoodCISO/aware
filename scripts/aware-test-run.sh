#!/usr/bin/env bash
# scripts/aware-test-run.sh — the ONE way to run the AWARE test suite on this host.
#
# WHY THIS EXISTS
# ---------------
# Three host-environment facts make `npm test` unreliable on this machine.
# Each was measured, not guessed:
#
# 1. `python3` on PATH has no `jsonschema` / `yaml`.
#    `test/unit/config/rlm.test.js` shells out to `python3` for draft-07
#    schema validation. Without those modules, 34 assertions fail.
#    PEP 668 blocks `pip install` into the Homebrew python, so the deps live
#    in a dedicated venv that is prepended to PATH here. The venv path is
#    read from AWARE_TEST_VENV so this script stays free of host-path
#    literals (the public-boundary checker flags them in scripts/).
#
# 2. The `rl-pipeline` sibling repo is absent from this host.
#    `src/config/index.cjs` resolves it to `<repo-parent>/rl-pipeline/src/index.js`.
#    The bridge accepts either `rl_pipeline` or `heavy_think` as the export,
#    and `backend/heavy-think/src/index.js` exports `heavy_think` — so
#    pointing AWARE_RL_PIPELINE_PATH at the vendored copy makes all 14
#    bridge assertions pass without any code change.
#
# 3. `test/unit/gateway/server.test.js` leaks a keep-alive socket.
#    All 22 assertions PASS, but `server.close()` never completes, so the
#    test runner waits for the event loop to drain and the FILE is reported
#    as cancelled after ~90s. `--test-force-exit` makes the runner exit once
#    the assertions are done. This is a pre-existing teardown defect in the
#    test, not a product defect — the proper fix belongs in the test file.
#
# USAGE
# -----
#   bash scripts/aware-test-run.sh                 # tracked unit tests
#   bash scripts/aware-test-run.sh <file> [<file>] # specific files
#
# ENVIRONMENT
# -----------
#   AWARE_TEST_VENV   venv holding jsonschema + pyyaml for the RLM schema
#                     tests. Defaults to a per-user path under $HOME.
#
# EXIT CODE: node's exit code (0 = all assertions passed).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 1. Python deps for the RLM schema tests (see note 1 above).
#
# The venv is PREPENDED so `python3` resolves to the venv's interpreter (it
# ships the jsonschema + yaml modules the RLM schema tests need). node lives
# in the Homebrew bin directory, which is appended so the venv cannot shadow
# it — the venv has no `node`, and a venv-first PATH would make `node`
# unresolvable.
VENV_BIN="${AWARE_TEST_VENV:-$HOME/.venvs/aware-test}/bin"
if [[ -d "$VENV_BIN" ]]; then
  export PATH="$VENV_BIN:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin /usr/local/bin; do
    if [[ -x "$candidate/node" ]]; then
      export PATH="$PATH:$candidate"
      break
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "aware-test-run: node is not on PATH and no known fallback was found" >&2
  exit 127
fi

# gitleaks is required by the pre-push hook. When it is absent the hook
# PRINTS a warning and SKIPS the secret scan, so a leak passes the filter
# and `test/unit/scripts/pre-push-filter.test.js` fails on the leak it
# plants. Homebrew is not writable by every user on this host, so gitleaks
# is installed under a per-user prefix instead.
if ! command -v gitleaks >/dev/null 2>&1; then
  for candidate in "$HOME/.local/bin" "$HOME/bin"; do
    if [[ -x "$candidate/gitleaks" ]]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi

# 2. The vendored rl-pipeline (see note 2 above).
#
# Two paths are needed:
#   - AWARE_RL_PIPELINE_PATH is what the runtime bridge resolves. The
#     vendored `backend/heavy-think/src/index.js` exports `heavy_think`,
#     which the bridge accepts as an alias for `rl_pipeline`.
#   - Two tests in test/unit/coordinator/index.test.js build the sibling
#     path directly from the test file's own location
#     (`<repo-parent>/rl-pipeline/src/index.js`), so the sibling has to
#     exist on disk at that path. A symlink from the sibling path to the
#     vendored directory satisfies it without a second copy of the source.
VENDORED_RL_PIPELINE="$REPO_ROOT/backend/heavy-think/src"
export AWARE_RL_PIPELINE_PATH="$VENDORED_RL_PIPELINE/index.js"

RL_PIPELINE_SIBLING="$(cd "$REPO_ROOT/.." && pwd)/rl-pipeline"
if [[ ! -e "$RL_PIPELINE_SIBLING/src/index.js" && -d "$VENDORED_RL_PIPELINE" ]]; then
  mkdir -p "$RL_PIPELINE_SIBLING" 2>/dev/null || true
  ln -sfn "$VENDORED_RL_PIPELINE" "$RL_PIPELINE_SIBLING/src" 2>/dev/null || true
fi

# 3. Force exit so the leaking gateway test cannot hang the run (note 3).
NODE_TEST_FLAGS=(--test-force-exit)

if [[ $# -gt 0 ]]; then
  exec node --test "${NODE_TEST_FLAGS[@]}" "$@"
fi

# Default: every TRACKED unit test. Untracked test files in a dirty working
# tree are excluded on purpose — they are other people's in-flight work and
# several of them fail for missing modules.
#
# NOTE: `mapfile` is not available in the bash 3.2 that ships with macOS,
# so the list is built with a portable read loop.
TEST_FILES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && TEST_FILES+=("$line")
done < <(git ls-files 'test/unit/**/*.test.js' 'test/unit/*.test.js')

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
  echo "no tracked unit tests found" >&2
  exit 2
fi

exec node --test "${NODE_TEST_FLAGS[@]}" "${TEST_FILES[@]}"
