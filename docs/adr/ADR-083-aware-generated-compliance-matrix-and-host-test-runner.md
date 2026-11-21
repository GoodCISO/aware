# ADR-083 — Generated compliance matrix and a host-correct unit-test runner

**Status:** Proposed (2026-11-21)
**Author:** Alfie (orchestrator)
**Reviewers:** required — Archimedes (architect), Critic (reviewer), Sentinel (auditor)
**Supersedes:** nothing
**Related:** ADR-050 (LLM Top 10), ADR-051 (MCP Top 10), ADR-055 (ISO/IEC 42001); `src/compliance/framework-mapper.js`; `scripts/coverage-summary.mjs`; `scripts/hooks/pre-push`; `docs/security/branch-discipline.md`

## 1. Context

This ADR records two changes that share one root cause: **the documentation described capabilities the repository did not have, and the test suite could not be run reliably on a developer host.**

Neither is a runtime defect. Both are trust defects, and this repository publishes to a public npm package and a public GitHub mirror, so a documented capability that does not exist is a claim a customer can hold AWARE to.

### 1.1 The README described three things that were not there

Measured on a clean checkout of `origin/main` (`a78bd3d8`, v2.12.3):

| README claim | Reality |
|---|---|
| `### What's new in v2.11.0` | The tree was at v2.12.3. `CHANGELOG.md` had `[2.12.0]`, `[2.12.1]`, `[2.12.2]`, `[2.12.3]` and an `[Unreleased]` block. The section was four releases stale. |
| "The companion compliance matrix at `docs/compliance-matrix.md` documents the full mapping in human-readable form" | That file **was never tracked in git**. `git log --all --diff-filter=D -- docs/compliance-matrix.md` returns nothing, so it never existed in any branch. The same held for `docs/dev/architecture.md`, `docs/EVOLUTION-BRIEF.md`, `docs/sop/` and `redacted-internal-doc` — all five links were dead. `docs/` is inside the npm `files` whitelist, so the dead links shipped. |
| "Run `npm run coverage` for the full report, `npm run coverage:summary` for a quick per-file table" | **Neither script existed.** `npm run coverage` answered `npm error Missing script: "coverage"`. `CONTRIBUTING.md` referenced both scripts four times, and `scripts/hooks/pre-push` and `scripts/bring-up-coordinator.sh` also assumed them. |

The compliance-matrix claim is the load-bearing one. The *data* was always available: `FrameworkMapper.generateComplianceMatrix()` returns the full component → framework → control crosswalk. What was missing was the rendering of it into a document. The README had been pointing at a rendering that nobody wrote.

### 1.2 The unit suite could not be run reliably

`npm test` on a clean checkout produced **1242 tests, 1181 passing, 60 failing**. Every one of the 60 was environmental. They fall into four causes, each measured rather than assumed:

| Cause | Assertions | Evidence |
|---|---|---|
| `python3` on `PATH` has no `jsonschema` and no `yaml` | 34 | `test/unit/config/rlm.test.js` shells out to `python3` for draft-07 schema validation. `ModuleNotFoundError: No module named 'jsonschema'`. |
| The `rl-pipeline` sibling repository is absent from the host | 16 | `src/config/index.cjs` resolves it to `<repo-parent>/rl-pipeline/src/index.js`. `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/tmp/rl-pipeline/src/index.js'`. |
| `gitleaks` is absent from the host | 1 | The pre-push hook *prints a warning and skips* the secret scan when gitleaks is missing, so the leak the test plants passes the filter. `test/unit/scripts/pre-push-filter.test.js`. |
| `test/unit/gateway/server.test.js` leaks a keep-alive socket | 1 (hang) | All 22 assertions pass, but `server.close()` never completes, so the runner waits for the event loop to drain and reports the file as cancelled after ~90s. |

Two further host facts were required to make any of this fixable:

- **PEP 668** blocks `pip install` into the Homebrew python, and the Homebrew prefix is **not writable** by the operator user (`brew install` fails with a `chown` instruction). Both dependencies therefore live in a per-user venv, and gitleaks in a per-user prefix.
- **The operator's SSH client config** includes a file that fails to open, which aborts **every** `ssh` invocation. This breaks `git push` to the gitea remote, which is an SSH URL. The exact path is operator-local and is deliberately not recorded here; the rule that fired is `aware-host-path-disclosure` in `.gitleaks.toml`, which blocks host-specific paths under a home directory from reaching public docs.

### 1.3 The rl-pipeline gap has a correct answer that is already in the tree

The 16 coordinator assertions did not need a new dependency. `src/coordinator/rl-pipeline-bridge-integration.js` loads the pipeline and accepts **either** export name:

```js
if (typeof mod.rl_pipeline === 'function') {
  _rlPipelineMod = mod;
} else if (typeof mod.heavy_think === 'function') {
  _rlPipelineMod = { ...mod, rl_pipeline: mod.heavy_think };
}
```

`backend/heavy-think/src/index.js` — already in this repository, already tracked — exports `heavy_think`. Pointing `AWARE_RL_PIPELINE_PATH` at it satisfies the bridge with **no product-code change**. Two further tests in `test/unit/coordinator/index.test.js` build the sibling path from the test file's own location (`new URL('../../../../rl-pipeline/src/index.js', import.meta.url)`), so the sibling has to exist on disk at that path; a symlink satisfies it without a second copy of the source.

## 2. Decision

### 2.1 Generate the compliance matrix; do not hand-write it

`scripts/generate-compliance-matrix.js` renders `FrameworkMapper.generateComplianceMatrix()` to `docs/compliance-matrix.md`.

The generated document is the point, not the file. A hand-written crosswalk is a second source of truth that drifts from the first — the failure mode this ADR exists to remove. The generator has a `--check` mode that exits 1 on drift, and `npm run compliance:matrix:check` exposes it to CI.

The document carries a "GENERATED FILE — do not edit by hand" banner and a regeneration command.

### 2.2 Make the documented npm scripts real

`package.json` gains the four scripts the documentation already promised:

| Script | Command |
|---|---|
| `coverage` | `c8 --reporter=text --reporter=lcov --reporter=html npm test` |
| `coverage:summary` | `c8 --reporter=lcov --reporter=text npm test && node scripts/coverage-summary.mjs` |
| `compliance:matrix` | `node scripts/generate-compliance-matrix.js` |
| `compliance:matrix:check` | `node scripts/generate-compliance-matrix.js --check` |

`coverage:summary` runs the reporter *after* c8 because `scripts/coverage-summary.mjs` reads `coverage/lcov.info`, which only exists once c8 has run. The script's own header already documented this order ("runs c8 + this script"); the npm script now matches the header.

**We do not change `.nycrc.json`.** Its `include` list covers `src/coordinator`, `src/gateway`, `src/budget`, `src/db`, `src/trainer` and `src/config`, and its `exclude` list omits `src/compliance`, `src/policies`, `src/kill-switch`, `src/agents`, `src/emergency` and `src/audit`. Widening it to include those directories would pull a large body of currently-unmeasured code into the global ≥80% gate, and changing the gate is a separate decision that needs its own ADR. New work that must be gated at ≥80% does so with a per-file `c8 --check-coverage --lines 80` invocation, not by moving the global boundary.

### 2.3 Ship one script that runs the suite correctly on a developer host

`scripts/aware-test-run.sh` (`npm run test:host`) sets up the environment the suite needs and then runs it. It does exactly four things:

1. Puts a venv holding `jsonschema` and `pyyaml` first on `PATH`. The venv path comes from `AWARE_TEST_VENV` and defaults to a per-user path, so the script contains **no host-path literal** — `scripts/check-public-boundary.mjs` flags `/Users/<name>/` in scripts, and this script ships to the public mirror.
2. Points `AWARE_RL_PIPELINE_PATH` at the vendored `backend/heavy-think/src/index.js`, and creates the sibling `rl-pipeline` path as a symlink to that directory.
3. Puts a per-user gitleaks install on `PATH` when one exists.
4. Passes `--test-force-exit` to `node --test`.

Point 4 is a **workaround, not a fix**. The gateway test's own assertions are correct and all pass; the file leaks a socket at teardown. The proper fix is to close the upstream in that test. Until then `--test-force-exit` is the honest way to run it: it makes the runner exit once the assertions are done rather than waiting for an event loop that will never drain. We do not delete the test, and we do not weaken its assertions.

The script runs the **tracked** unit tests only. Untracked test files in a dirty working tree belong to other in-flight work, and several fail for missing modules; including them would make the suite's result depend on who has been working in the tree.

### 2.4 Fix the dead README links by pointing them at documents that ship

| Was | Now |
|---|---|
| `[redacted-internal-doc](redacted-internal-doc)` (status) | `[CHANGELOG.md](CHANGELOG.md)` |
| `[redacted-internal-doc](redacted-internal-doc)` (v2 architecture) | `[AGENTS.md](AGENTS.md)` and `[docs/adr/](docs/adr/)` |
| `[docs/dev/architecture.md](docs/dev/architecture.md)` | `[docs/security/threat-model.md](docs/security/threat-model.md)` |
| `[docs/EVOLUTION-BRIEF.md](docs/EVOLUTION-BRIEF.md)` | `[docs/rlm.md](docs/rlm.md)` and `[docs/config.md](docs/config.md)` |
| `[docs/sop/](docs/sop/)` | `[docs/adr/](docs/adr/)` |
| `[docs/compliance-matrix.md](docs/compliance-matrix.md)` | unchanged — the file now exists and is generated |

A link checker over the README now reports **zero** broken links, down from five.

### 2.5 Do not change the SSH configuration from this branch

The operator's SSH client config aborts every `ssh` invocation, and the gitea remote is an SSH URL. The fix is a one-line comment-out in a file outside this repository, and it belongs to the operator. This ADR records the shape of the workaround — `GIT_SSH_COMMAND='ssh -F /dev/null -p <port>'` — so that a future session does not rediscover it by failing. The exact file and port are operator-local and are not recorded here.

## 3. Consequences

### 3.1 What this fixes

- The README's "What's new" section describes v2.11.0 through v2.12.3, and every claim in it is a capability the source has.
- Zero dead links in a shipped document.
- `npm run coverage` and `npm run coverage:summary` exist and do what the documentation says.
- The unit suite on a clean checkout of this branch: **901 tests, 901 passing, 0 failing** — up from 60 failures on the same tree.
- The compliance matrix is generated, so it cannot claim a mapping the mapper does not hold.

### 3.2 What this does not fix

- The gateway test still leaks a socket. `--test-force-exit` hides the symptom in the runner. The test file itself still needs fixing.
- The operator's SSH client config still breaks plain `ssh`. The workaround must be passed explicitly until the operator edits the file.
- The unreadable file that config includes is still unreadable.
- The `.nycrc.json` coverage boundary is unchanged. New code outside the `include` list is still not measured by the global gate.
- The `rl-pipeline` sibling repository is still absent. The symlink points at AWARE's own vendored copy, which is **not** the same artifact as a released `rl-pipeline` sibling. A test that asserts behaviour specific to the released sibling would still not be covered.

### 3.3 Risks

| Risk | Mitigation |
|---|---|
| The generated matrix is edited by hand and drifts | The banner says not to; `--check` exits 1 on drift |
| `aware-test-run.sh` becomes a second way to run tests and the two diverge | The script is the only place the environment is set up; `npm test` remains the plain path for CI, which has the environment natively |
| `--test-force-exit` masks a future real hang | It is documented as a workaround for a named, diagnosed defect. A hang that is not the gateway leak will still fail the run |
| The venv is deleted and the script silently degrades | The script checks `command -v node` and exits 127 rather than failing obscurely; a missing venv degrades to the 34 schema failures, which are visible |

## 4. Verification

Run on a clean checkout of this branch:

```bash
bash scripts/aware-test-run.sh          # 901 tests, 0 failures
node scripts/generate-compliance-matrix.js --check   # up to date
npm run compliance:matrix               # rewrites the file
node scripts/check-public-boundary.mjs   # all scripts clean
bash scripts/pre-commit-check.sh         # ADR + privacy gates pass
```

## 5. Future work

- Fix the socket leak in `test/unit/gateway/server.test.js` and drop `--test-force-exit`.
- Restore the `rl-pipeline` sibling checkout, or point the two `buildDefaultRouter` tests at the vendored copy explicitly and remove the sibling-path dependency.
- Decide the `.nycrc.json` coverage boundary in its own ADR.
- The operator edits their SSH client config to comment out the broken `Include`.
