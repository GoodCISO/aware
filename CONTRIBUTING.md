# Contributing to AWARE 2.0

Welcome — this guide is for anyone reading or modifying the v2 source. If
you are an **operator** bringing the stack up, see
[README.md](README.md) instead. If you are **curious about the design**,
start with [docs/adr/ADR (internal).md](docs/adr/ADR (internal).md) (the v2 architecture
decision) and the per-phase SOPs in [internal SOPs/](internal SOPs/).

---

## 30-second orientation

AWARE 2.0 is a **5-stage self-improving feedback loop** that wraps the v1
bio-inspired routing layer:

```
1. Coordinator       (src/coordinator/)     routes /coordinate calls
2. Conversation Logger (src/db/logger.js)   logs every call to Postgres
3. PRM Score Cache    (src/db/prm-cache.js)  caches PRM judge by content hash
4. AZR Self-Play      (src/trainer/)         Modal A100 task proposer/solver
5. DPO Trainer        (src/trainer/)         Modal QLoRA on trained-model
```

Each stage writes to Postgres; the next stage consumes. The training
stages (4 + 5) live behind the `--profile training` compose profile.

**Public API surface** (v2 source paths only):

| File | Exports |
|------|---------|
| `src/coordinator/index.js` | `coordinate`, `buildDefaultRouter`, `makeModelRouter`, `makeOllamaHealth`, `awareRlPipeline` |
| `src/coordinator/http-server.js` | `startServer` |
| `src/coordinator/model-router.js` | `makeModelRouter`, `makeOllamaHealth` |
| `src/coordinator/rl-pipeline-bridge-integration.js` | `awareRlPipeline`, `buildPairPath`, `classifyError`, `K_CONFIGS` |
| `src/gateway/server.js` | `app`, `GATEWAY_VERSION`, `isKilled` (CJS) |
| `src/db/index.js` | `getPool`, `runMigrations`, `closePool` |
| `src/db/logger.js` | `logConversation`, `logConversationFireAndCodert`, `_resetForTest` |
| `src/db/prm-cache.js` | `buildCacheKey`, `isCacheEnabled`, `getCachedScore`, `putCachedScore`, `getCacheStats` |
| `src/budget/watchdog.js` | (kill switch + budget enforcer) |
| `src/trainer/index.js` | `TrainerPoller` (class) |
| `src/trainer/modal-client.js` | `makeModalClient`, `preflightModal`, `resolveInflight` |
| `src/trainer/outcome-filter.js` | `filterOutcomePairs`, `listFilterRules` |
| `src/config/index.cjs` | `config` (lazy getters — see [docs/config.md](docs/config.md)) |

---

## Setup (5 commands)

```bash
git clone https://github.com/GoodCISO/aware
cd aware
npm install          # installs deps; c8 is in devDependencies
cp deploy/env.example .env
$EDITOR .env          # uncomment + fill what you have; defaults are safe
npm test              # 239/239 should pass on a clean checkout
```

`npm install` is the only "build" step. There is no TypeScript compile
(`pnpm build` is v1's React UI build and is not required for v2 dev).
The test runner is `node --test 'test/unit/**/*.test.js'` — no Jest, no
Mocha. Tests are plain ESM `import` + `node:test` + `node:assert/strict`.

---

## Workflow

```bash
# Branch from feature/aware-2.0 (the active v2 branch)
git checkout feature/aware-2.0
git pull
git checkout -b feature/your-change

# Edit + add tests in test/unit/<source-dir>/<basename>.test.js
# Run the suite, run the coverage harness, run the bring-up
npm test
npm run coverage:summary       # per-file table; current floor is 80% lines
BRINGUP_FULL=1 ./scripts/bring-up-coordinator.sh   # optional, slow

# Commit, push to your fork or the same remote, open a PR
git commit -m "..."   # conventional commit prefix: 'aware:' for code, 'docs:' for docs
git push
```

**Commit message prefix convention** (matches existing history):

- `aware:` — code change (src/, config/, scripts/, training/)
- `docs:` — documentation only (README, CHANGELOG.md, docs/)
- `test:` — test-only change
- `chore:` — tooling / dependency bumps / .gitignore

**Secrets policy:** never commit a real token, key, or password. Secrets
are sourced from `redacted-credential-dir/credentials.env` on the
operator's host. If you need a new secret, document its env-var name in
`deploy/env.example` as a placeholder — the value lives in the operator's
credential store, not the repo.

---

## Conventions

### ESM imports

v2 source files are ESM (`import` / `export`). The CJS exception is
`src/config/index.cjs` — kept as `.cjs` because it uses CommonJS
`require()` for the centralized config (consumed by both ESM coordinator
code and the CJS gateway). Do not introduce new CJS files; everything
new is ESM.

```js
// GOOD
import { makeModelRouter } from './model-router.js';
export async function coordinate(req) { ... }

// BAD — CJS in v2 code
const { makeModelRouter } = require('./model-router.js');
module.exports = { coordinate };
```

### Pure functions where possible

`src/trainer/outcome-filter.js` is the model: `filterOutcomePairs(records, options) → {kept, dropped, stats}`. Pure input → output, no I/O, no clock, no randomness. This makes it trivial to test (14 unit tests, all under 2ms each) and trivial to compose. New v2 modules should follow the same shape unless they are explicitly I/O wrappers (DB, HTTP, Modal).

### Test layout

| Source | Test | Notes |
|--------|------|-------|
| `src/coordinator/model-router.js` | `test/unit/coordinator/model-router.test.js` | One test file per source file |
| `src/db/logger.js` | `test/unit/db/logger.test.js` | Same |
| `src/trainer/index.js` | `test/unit/trainer/index.test.js` | Same — the TrainerPoller class is tested via injection (the test file passes a stub `pool`, `modalClient`, etc.) |

Test name format: `<module-or-class>: <behavior>`. Example:
`test('outcome-filter: tag_match drops records with no task_type', ...)`.

### Config

Adding a new env var requires three changes:

1. `src/config/index.cjs` — add a lazy getter in the matching namespace
2. `src/config/index.cjs#snapshot()` — add the field so it appears in `npm run config:show`
3. `deploy/env.example` — add a documented entry in the matching section

If the new var is a **secret**, also add it to the `SECRET_NAMES` set in
`src/config/index.cjs` so it gets redacted in `snapshot()`.

### Coverage

`npm run coverage` runs `c8 --reporter=text --reporter=lcov --reporter=html npm test` and produces a `coverage/` tree. The default bring-up only sanity-checks the harness (smoke 8h); the ≥80% gate enforcement runs only with `BRINGUP_FULL=1` (smoke 8i). **The current floor is 80% lines on v2 source paths; do not let a new commit drop total below that.**

If you add a new v2 source file:

1. Put it in one of the include paths (`src/coordinator/`, `src/gateway/`, `src/budget/`, `src/db/`, `src/trainer/`, `src/config/`)
2. The `.nycrc.json` will pick it up automatically
3. Add a test file at the matching `test/unit/<dir>/<basename>.test.js` path
4. The default coverage table will include it on the next `npm run coverage`

### The `redacted-external-repo/` dependency

The coordinator imports `redacted-external-repo/src/index.js` for the AZR task
proposer / solver. The path is configurable via
`AWARE_RL_PIPELINE_PATH` (see `deploy/env.example`). This is a sibling
repo, not a submodule. If you change the rl-pipeline API, you must
update the AWARE call sites in `src/coordinator/rl-pipeline-bridge-integration.js`.

### The Modal dependency

The trainer calls Modal via `src/trainer/modal-client.js`. The real
`modal@0.8.0` JS SDK is in `package.json`; tests use a stub. The bring-up
script's smoke 8e asserts the real SDK is installed and the
`Function.from_training_script` API (which does NOT exist) is not used.
If you change the Modal call shape, update both `modal-client.js` and
its test, and verify smoke 8e still passes.

---

## Where the architectural decisions live

When you encounter a fork in the road (e.g. "should the outcome filter
join on tag or embedding similarity?"), do NOT invent the answer. The
process is:

1. **Read** `docs/adr/ADR (internal).md` — the v2 master architecture decision
2. **Read** the relevant per-phase SOPs in `internal SOPs/` — they often call
   out a pending decision
3. **Surface** the decision as a menu (A/B/C + P/Q/R + X/Y) to the
   operator with a recommendation block
4. **Wait** for the operator to pick a 4-5-token response (e.g., "B, P,
   X, go") before writing code that depends on the choice
5. **Record** the picked option in the SOP's `decision` field after the
   code lands

The three currently-open Phase 4 decisions (A/X/Y) are listed in the
Phase 4 first-slice SOP. The outcome filter module
(`src/trainer/outcome-filter.js`) defaults to `noop` and a default
filter rule from `AWARE_TRAINER_FILTER_RULE` — the architecture decision
is deferred to deploy time, not code time.

### Creating a new ADR

ADRs live in `docs/adr/`. The pre-commit hook
(`scripts/pre-commit-check.sh`) enforces the numbering convention at
commit time, so the rules below are not optional.

**Numbering:** Before creating a new ADR, run

```bash
ls docs/adr/ | grep -oE "ADR-[0-9]+" | sort -V | tail -1
```

to find the highest existing number, then use **next + 1** as your
ADR-NNN. **Never reuse a number** — even if an old ADR is rejected,
the number is "burned" and stays off-limits. The pre-commit hook
will block the commit if two files in `docs/adr/` share a number
(see `docs/adr/AWARE-FIX-2026-07-13.md` for the most recent incident
and the gate that prevents recurrence).

**Filename pattern:** `ADR-NNN-aware-<short-slug>.md`. Examples:
`ADR-048-aware-llm-caching.md`, `ADR-049-aware-tool-allowlist.md`. The
`-aware-` segment is required so the pre-commit check can pattern-match
project files vs random docs in the same directory.

**H1 line:** First line of the file must be `# ADR-NNN — <Title>`. The
number in the H1 must match the filename; the pre-commit check enforces
this.

**Un-numbered files:** If a doc in `docs/adr/` is *not* an ADR (e.g.
a positioning memo like `vnx-positioning.md`), add
`**ADR-number: skipped**` in the first 3 lines of front matter.
The check looks for this marker and exempts the file from the
ADR-NNN-prefix rule.

**Cross-references:** When you reference another ADR in the body of
your new file, use the form `ADR-NNN §"<section name>"` so future
readers can find the cited section. After renaming an existing ADR,
sed-replace the OLD ADR-NNN across `docs/adr/`, `src/`, and `test/`
— the pre-commit check's "stale reference" rule is what catches a
half-done rename, and it will block the commit until you've
updated all references.

**Exemptions:** The check exempts two files from the stale-reference
rule: the check script itself (`scripts/pre-commit-check.sh`) and
the historical fix record (`docs/adr/AWARE-FIX-2026-07-13.md`).
These are the only legitimate places to mention retired ADR numbers
going forward.

---

## Where the operator actions live

Three things require **operator-side** action that no amount of code
review can replace:

1. **Modal deploy (one-time, ~5 min):** `MODAL_PROFILE=goodciso modal deploy training/run.py` registers the App on Modal. Without this, the trainer cannot submit jobs.
2. **Bring-up test (Phase 5 "fresh VM in <30 min"):** `./scripts/aware-up` on a clean Ubuntu 22.04 VM, see [README.md](README.md#quickstart-v2).
3. **Coverage gate (BRINGUP_FULL=1):** the bring-up's smoke 8i enforces ≥80% lines. Run `BRINGUP_FULL=1 ./scripts/bring-up-coordinator.sh` before tagging a release.

The repo's [CHANGELOG.md](CHANGELOG.md) records every release closure with the commit hash.
The `redacted-host-config/sops/` mirror is the canonical SOP store for the
operator's runtime.

---

## Pull request checklist

Before opening a PR, run these in order:

- [ ] `npm test` — 239/239 should pass
- [ ] `npm run coverage:summary` — total ≥ 80% lines, no new file < 60%
- [ ] `bash -n scripts/aware-up && bash -n scripts/bring-up-coordinator.sh` — no syntax errors
- [ ] `npm run config:validate` — config still parses
- [ ] `docker compose -f docker-compose.coordinator.yml config --quiet` — compose still valid
- [ ] `git diff --cached | grep -E "ak-|as-|sk-"` — no real token values
- [ ] If you added a new env var, update `src/config/index.cjs` AND `deploy/env.example`
- [ ] If you added a new v2 source file, add the matching test file
- [ ] If you changed the public API, update the table at the top of this file
- [ ] Commit message uses one of: `aware:`, `docs:`, `test:`, `chore:`

When the PR is merged, mirror any new SOPs to `redacted-host-config/sops/`.

---

## Style

- 2-space indent, LF line endings, UTF-8
- Prefer `const` over `let`; never `var`
- Prefer early-return over nested if-else
- Functions ≤ 50 lines when possible
- Comments only when the WHY is non-obvious
- No emoji in code, comments, or commit messages

The repo does not run a formatter. The "check" gate is
`pnpm check` (v1 only — `lint` + `format:check`); v2 currently relies on
code review. If you want to add a formatter, propose it as an ADR first.

---

## Further reading

- [README.md](README.md) — operator onboarding, architecture overview, what AWARE is
- [CHANGELOG.md](CHANGELOG.md) — closure status of every release, with commit hashes
- [docs/adr/](docs/adr/) — the architecture decision records
- [docs/config.md](docs/config.md) — full config reference (auto-generated from `src/config/index.cjs`)
- [docs/security/threat-model.md](docs/security/threat-model.md) — the threat model and the enforcement surfaces
- [docs/rlm.md](docs/rlm.md) — the recursive language model configuration
- [docs/compliance-matrix.md](docs/compliance-matrix.md) — the generated component-to-control crosswalk
