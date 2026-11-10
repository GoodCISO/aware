# Changelog

All notable changes to AWARE Evolution are documented here.

## [2.12.0] — 2026-11-10 — Compliance engine becomes persistent and auditable; MCP Top 10 classifier shipped; provider model made configurable

**Release type:** minor. New capability (MCP Top 10 classification, durable compliance state, failure-path auditing) plus four defect fixes that each disabled a documented control.

### Added

- **OWASP MCP Top 10 classifier** (`src/compliance/mcp-top10-classifier.js`) — 8 rules covering 8 of the 10 OWASP MCP Top 10 classes, with confidence ratings and evidence capture. The module was **referenced by the gateway but had never been written**; the require was made tolerant so its absence would not crash the compliance router, which is what actually prevented the v1 backend from starting. MCP06 and MCP07 have no deterministic, event-only test and are not yet covered.
- **Durable compliance state** (`src/compliance/persistence.js`) — assessments and collected evidence now persist to `/data/compliance/compliance-state.json` and survive a restart. Previously both lived only in memory, so the compliance dashboard read 0/0 after every deployment regardless of what had been collected.
- **Provider model as an operator setting** (`AWARE_PROVIDER_MODEL`, default `MiniMax-M3.1-Flash`) — the model name was previously hard-coded inside the pinned rl-pipeline dependency and could not be changed without republishing that library.
- **Failure outcomes on the decision chain** — timeout, backend error, internal error, cost-cap, and `ok:false` responses are now written to the hash-chained audit trail. Previously only successful decisions were recorded, so the chain could evidence *what succeeded* but not *completeness*.
- **PRM cache model backfill** (`db/backfill-prm-model-20261110.sql`) — 515,327 rows in `aware_prm_cache` were labelled `primary-model` because the coordinator never passed a model name and rl-pipeline's cache key read a router property that was never set.
- **Compliance UI service** (`aware-2-ui`) — the React compliance dashboard, served by nginx, proxying `/api` to the v2 gateway.

### Fixed

- **The cost cap was not enforced.** The check read `result.cost_usd`, but the coordinate envelope carries `cost: {attempts_usd, refinement_usd, judge_usd}`. The field was always `undefined`, the comparison was always false, and the 402 branch was unreachable — a request with `cost_cap_usd=0.000001` succeeded and spent ~$0.003. Now resolved by `resolveResultCostUsd()`, which prefers the envelope's own accounting and does not double-count the per-attempt costs.
- **The audit export failed for recent records.** `getChainBetween()` resolved from the in-memory index, which flushes on a 5-second debounce, so exporting the newest record returned `Decision <id> not found in index` even though the record was on disk and verified. It now falls back to reading the JSONL log.
- **The gateway could not write compliance state.** It mounts the audit volume read-only — deliberately, so a compromised gateway cannot rewrite the audit trail — so state written there failed with `EROFS`. Compliance state now has its own `aware-2-compliance-data` volume, mounted read-write to both the gateway and the coordinator.
- **The compliance dashboard rendered fabricated figures.** `API_BASE` pointed at `localhost:8080`, held by an unrelated process, and the fetch failure path substituted mock numbers (ISO 27001 89, SOC 2 72, GDPR 65, overall 65) as if they were live readings. The mock fallback is deleted: failures now render an error. Framework lists and counts are driven by the API.

### Changed

- **The compliance posture is now measured, not asserted.** Posture reads from persisted state: CSA_AI_CM 5/184 controls assessed. The remaining seven frameworks report 0 assessed, which is the honest state — the engine works, the assessments have never been recorded.
- **The provider model is exposed on the router** (`src/coordinator/model-router.js`), which also removes the `prm_model` label drift described above.

### Notes

- New unit tests: `test/unit/compliance/mcp-top10-classifier.test.js` (14 tests, all passing).
- The full unit suite runs **961 tests: 838 pass, 123 fail**. The 123 failures are **pre-existing and unrelated** — verified by running the suite against a pristine worktree of `main` (661 tests, 537 pass, 124 fail) and against `main` with only these changes applied (675 tests, 551 pass, 124 fail). The failing test *names* are identical before and after: **zero regressions**. The failures are in RLM schema validation, CORS allowlist, and the aidefend mapper — all from untracked work dated 2026-09-25 that is not part of this release.
- The credential rule inspects only **top-level** `action.parameters` keys; a credential nested in `parameters.headers` is not detected. This is a known coverage gap, pinned by a test so it stays visible.
- Not released in this version: `src/compliance/mcp-governance-catalog.js`, `src/trainer/security-sensitive-diff.js`, and their tests are untracked work dated 2026-09-25 that predates this release and is excluded from it.

## [2.11.1] — 2026-08-02 — Docs patch: README compliance frameworks table updated for v2.11.0 catalogs

**Release type:** patch. README.md only — no code/runtime changes from v2.11.0. Closes the post-release README gap surfaced in the Herald website audit cycle.

### Documentation
- **README compliance frameworks table** — bumped count from 5 to 8 frameworks to reflect v2.11.0's catalog additions.
- **ISO/IEC 42001** (AI Management System, v1.0-2026-07-28) added per ADR-055.
- **OWASP Top 10 for LLM Applications** updated from v1.1 → **2025** per ADR-050 GAP-1 (deprecated v1.1 IDs preserved at `OWASP_LLM_TOP_10_v1_1` for traceability).
- **OWASP Agentic Skills Top 10 (AST10)** added (v1.0-2026) per ADR-048.
- **OWASP MCP Top 10** added (2025) per ADR-051.
- New **"What's new in v2.11.0"** subsection covering the rebrand (`aware` → `@goodciso/aware`; `alvinchang/aware` → `GoodCISO/aware`), the three new framework catalogs, AST10 gap closure, Vaara shadow audit adapter, and OSS hygiene (license cleanup, tarball 88.3 MB → 452 kB).

### Notes
- npm tarball regenerated to include the updated README. Code, tests, and runtime behaviour unchanged from v2.11.0.
- v2.11.0 tag remains immutable; v2.11.1 is the canonical docs-patch follow-up.
- Herald msg 8439 ("Ship v2.11.1") authorised this release.

— Alvin Chang, 2026-08-02

## [2.11.0] — 2026-07-31 — Package rebrand to @goodciso/aware + OWASP LLM Top 10:2025 + AST10 + MCP + Vaara + ISO 42001

**Release type:** minor. Major rebrand (aware → @goodciso/aware), closes 4 OWASP framework gaps (LLM07, LLM09, LLM10, AST10), ships MCP adapter, ATLAS mapper, VaaraAuditBackend, ISO/IEC 42001 catalog, plus 30+ feature/fix commits.

**Rebrand:** `aware` → `@goodciso/aware`. The npm package now lives under the `@goodciso` scope; the GitHub repo moves from `alvinchang/aware` to `GoodCISO/aware`. Source files are unchanged.

### Added (high-level)
- **OWASP LLM Top 10:2025** (ADR-050) — rebind from v1.1 to 2025; LLM07 system-prompt-elicit rule; LLM09 review-loop event; LLM10 projection tightened to gate on outcome.success=false; DonkAI replay harness; SARIF surface-routing plumbing for LLM07/LLM09/LLM10.
- **OWASP AST10** (ADR-048) — close remaining 3 AST10 gaps (AST01, AST06, AST08) with Rules 8/9/10 in `src/compliance/ast10-mapper.js`; new `src/compliance/ast10-catalog.js` + `src/compliance/skill-scanner.js` (vendor-neutral, NVIDIA SkillSpector default, Cisco compatible); `src/policies/sandbox-decision-emitter.js`.
- **MCP adapter** (ADR-051) — coordinator JSON-RPC adapter + `mcp_message` emitter.
- framework-mapper.js: register OWASP_MCP_TOP_10 framework block + per-component mappings per ADR-051 §2.2.
- **VaaraAuditBackend** — opt-in shadow-mode audit backend for the AWARE decision chain; `src/coordinator/adapters/vaara.js` + 1k-fixture integration tests.
- **Independent stdlib chain verifier** — decoupled verifier with 1k fixture.
- **ATLAS mapper** — wire ATLAS v2026.06 catalogue + mapper into the consumer tree; 22-case test suite for `atlas-mapper` (all 7 rules).
- **ISO/IEC 42001:2023 catalog** (ADR-055) — `src/compliance/iso42001-catalog.js` + framework-mapper entry; A.2.4/A.7.4/A.9.3 reconciled to partial per PR #9 review.
- **Tier promotions** — `feat(db)` audit table + store, `feat(api+gateway)` tier-promotion handler + audit manifest, `feat(v2)` initial v2 namespace scaffolding, `feat(scripts)` build-and-export-coordinator, `chore(docker)` tier-promotion image updates, `docs` tier promotions changelog + OpenAPI sync.
- **AICM v1 support** (re-shipped) — real CSA AICM v1 control IDs (184 verified across 18 domains) replace placeholder IDs.
- **Coordinator resilience** — upstream-aware 429 backoff/retry; debounced async index flush for decision-logger; OLLAMA_URL re-enabled via `host.docker.internal`; ESM credential-stub export; MCP adapter + `src/policies` copy to Dockerfile.

### Changed
- **package.json name** `aware` → `@goodciso/aware`; **version** 2.10.0 → 2.11.0; new `repository`, `homepage`, `bugs`, `files` fields.
- **Privacy** — strip stale `@license GPL-3.0` headers from S3-origin audit files (Phase 4 §7 follow-up).
- **Scripts** — `scripts/collect-runtime-evidence.sh` output redirected to `../runtime/evidence/` (operator-internal path).

### Documentation
- ADR-051 (MCP JSON-RPC adapter), ADR-055 (ISO/IEC 42001 catalog).
- `docs/contributing.md` — new "Creating a new ADR" section.
- ADR numbering pre-commit gate + 2026-07-13 incident record.
- Retired-numbers list parameterised.
- Branch-discipline doc rewritten (security §), public-boundary checker re-shipped.

### Testing
- DonkAI replay harness covers LLM Top 10:2025 end-to-end.
- `atlas-mapper` test suite: 22/22.
- Vaara integration tests pass.
- 1k-fixture chain-verifier.

### Privacy / security
- Public-boundary checker (cherry-pick `08a6523`) ensures no operator-internal literals (literal ports, Modal workspace names) leak to GitHub.
- Branch-discipline doc clarifies dual-remote discipline (gitea operator-internal vs github public).
- `08a6523` cherry-pick sanitises `scripts/aware-up` to use generic topology references.

### Source commits (35 feature commits, oldest-first)
```
08a6523 chore(security): add public-boundary checker
d1e170a docs(security): branch-discipline — gitea vs github remotes
db92ff1 docs(security): rewrite branch-discipline on public branch
910bedf feat(compliance): AICM v1 support
18603fc feat(db): tier promotions audit table + store
a67218c feat(api+gateway): tier promotion handler + audit package manifest
5669acd feat(v2): initial v2 namespace scaffolding
643f9b4 chore(docker): tier promotion image updates
b14be10 docs: tier promotions changelog + openapi sync
1e4ef71 feat(scripts): build-and-export-coordinator
ebc2b0d chore(license): strip stale @license GPL-3.0 headers
bb596a6 fix(scripts): redirect collect-runtime-evidence.sh output
6b5d7bb feat(coordinator): upstream-aware 429 backoff/retry
f69e483 fix(adr): pre-commit gate for ADR numbering + 2026-07-13 incident record
e726a5b docs(contributing): add Creating a new ADR section
f7d8941 refactor(adr): parameterize the retired-numbers list
e925a6b feat(compliance): wire ATLAS v2026.06 catalogue + mapper
b20e15e test(compliance): add atlas-mapper test suite
b8caaa0 feat(audit): VaaraAuditBackend — opt-in shadow-mode adapter
e6c2b95 feat(compliance): rebind OWASP_LLM_TOP_10 framework v1.1 → 2025
3d299d6 feat(policies): LLM07:2025 system-prompt-elicit rule
ef4730e feat(coordinator): MCP JSON-RPC adapter + mcp_message emitter
4abdc20 feat(compliance): LLM09:2025 review-loop event + route
5e4bbf7 test(compliance): DonkAI replay harness
1673259 test(compliance): GAP-1+4+6 plumbing — surface LLM07 + LLM09 events
0d07551 test(compliance): GAP-7 projection — surface LLM10 events
f8af100 test(compliance): tighten LLM10 projection
0505b33 feat(aware): close AST10 gap
32081af feat(audit): independent stdlib chain verifier + 1k fixture
83d40f4 fix(aware): ship MCP adapter + src/policies copy to Dockerfile
e4c5c92 fix(aware): export credential stub as ESM
c31cf23 fix(aware): re-enable OLLAMA_URL via host.docker.internal
07c1053 fix(aware): debounced async index flush for decision-logger
b5e1e2b feat(compliance): ISO/IEC 42001:2023 catalog + framework-mapper entry
d8c470a docs(adr)+catalog: add ADR-055 + reconcile A.2.4/A.7.4/A.9.3
```

(Excludes: `65171a4` v2.8.0 release metadata; `156d58d` v2.9.0 release metadata; `77701f1` / `e89b16e` / `d69ac27` merge commits — content carried by the non-merge commits above.)

### Naming history

Prior marketing materials used "Adaptive Workflow Agent with Recursive Evolution" — a real acronym from earlier iterations of the product. Canonical expansion since v2.8.0 is "Autonomous Compliance Infrastructure for AI Agents". Full historical context: see `NAMING.md` (S354, commit `a5c7bfd`).


## [2.10.0] — 2026-07-21 — OWASP AST10 support (ADR-048)

**Release type:** minor. Closes the remaining 3 AST10 gaps (AST01, AST06, AST08) per ADR-048.

**Coverage:** 10/10 OWASP AST10 risk classes have dedicated rules in `src/compliance/ast10-mapper.js`.
- **H-confidence (3):** AST01 (malicious skills), AST03 (over-privilege write), AST06 (weak isolation)
- **M-confidence (7):** AST02, AST04, AST05, AST07, AST08, AST09, AST10

### Added
- New `src/compliance/ast10-catalog.js` — canonical OWASP AST10 risk catalogue (10 risk classes)
- New `src/compliance/skill-scanner.js` — vendor-neutral skill scanner adapter (NVIDIA SkillSpector default, Cisco compatible)
- New `src/policies/sandbox-decision-emitter.js` — AST06 source-event producer
- `src/compliance/ast10-mapper.js` extended with 3 new rules (Rule 8, 9, 10) closing the remaining AST10 gaps
- `src/policies/tool-observation-proxy.js` extended with AST06 + AST08 source-event producers
- `docs/adr/ADR-048-aware-ast10-coverage.md` — canonical follow-up ADR

### Rules shipped (10/10 AST10 risks)
- **Rule 1** `scannerRequired` → AST01 (H)
- **Rule 2** `publisherProvenance` → AST02 (M)
- **Rule 3** `overPrivilegeWrite` → AST03 (H)
- **Rule 4** `networkManifestIntegrity` → AST04 (M)
- **Rule 5** `untrustedInstructionOrigin` → AST05 (M)
- **Rule 6** `sandboxBoundaryEnforcement` → AST06 (H)
- **Rule 7** `updateWithoutPin` → AST07 (M)
- **Rule 8** `sandbox-boundary-violation` → AST06 (H, closes AST06 gap)
- **Rule 9** `skill-scan-finding` → AST08 (M, closes AST08 gap)
- **Rule 10** `malicious-or-unproven-skill` → AST01 (H, closes AST01 gap)

### Testing
- 25/25 standards tests pass (`test/standards/owasp-ast10/ast01.test.js` … `ast10.test.js` + 2 fanout tests + helpers)
- 44/44 unit tests pass (`test/unit/compliance/skill-scanner.test.js` + `test/unit/policies/tool-observation-proxy-ast06-ast08.test.js`)

### Privacy fix
- Sanitized stale host-path comment in `ast10-mapper.js:526` to clear gitleaks (an operator-specific home path was replaced with a generic `<profile-dir>` placeholder)

### Pre-commit + pre-push hooks
- Layer 1 (pre-commit): ✅ passed (privacy filter + gitleaks clean)
- Layer 2 (pre-push): ✅ passed (public-boundary check on 20 changed scripts, all clean)

## [2.8.0] — 2026-06-30 — Public release

## [2.9.0] — 2026-06-30 — CSA AICM v1 support

**Release type:** minor. Promotes the AICM v1 work from a feature addition to a release milestone.

**Version-bump policy reversal:** An earlier in-session note in this CHANGELOG (under the now-removed "[Unreleased] — AICM v1 support" entry) said there would be no `package.json` version bump because AICM coverage was "a feature addition, not a release milestone." That note was wrong — 184 real AICM v1 control IDs across all 18 domains is a release milestone. Policy reversed; `package.json` is bumped to `2.9.0` and the work is tagged `v2.9.0` (post-v2.8.0; consistent with the github tag pattern).

**Note on github tag pattern:** AWARE's github-side tag pattern is `v2.X.x` (see `v2.7.0`, `v2.7.3`, `v2.8.0` in `git tag --list`). `package.json` was at `1.0.0-phase4-complete` before this release, so there is a one-time inconsistency: `package.json` says `2.9.0` but the codebase line of releases is `v2.7.0 → v2.7.3 → v2.8.0 → v2.9.0`. Future releases should keep `package.json` and github tags aligned on the `2.x` line.

### 2026-06-30 — CSA AICM v1 support (real control IDs)

### Added

- **`scripts/check-public-boundary.mjs`** — companion to the existing
  4-layer privacy filter. Detects operator-internal script binding
  (host paths, operator env dirs, LAN IPs, non-default localhost
  ports, operator org literals, bearer tokens, common secret prefixes,
  connection strings with credentials). Enforces a per-file
  `# public-boundary:` marker convention (`ok`, `operator-internal`,
  `test-fixture`). Pure-analysis scripts are exempt by default. Wire
  it in via `scripts/hooks/pre-push` for Layer 2 coverage on every
  push; the marker grammar and decision logic live in the file-header
  comment.

- **`docs/security/branch-discipline.md`** — documents the dual-remote
  workflow (gitea vs github), the public-boundary rule, and the
  cherry-pick procedure for cutting public releases. Covers the four
  conditions a commit must satisfy to be public-safe and the
  operator-internal marker convention.

- **`.gitleaks.toml` allowlist** — added `scripts/check-public-
  boundary.mjs` to the rule-definition allowlist (its regex literals
  match its own patterns; same self-defining-file pattern as the
  existing hook scripts).

### Changed

- **`scripts/run-phase4-d5.sh`** — `MODAL_PROFILE` default changed
  from the operator's workspace name to `default`. The script is now
  operator-org-agnostic: deploys to whatever Modal workspace is
  named in `$MODAL_PROFILE`. Marked `# public-boundary: ok`.

- **`scripts/aware-up`** — added `# public-boundary: operator-internal`
  marker. The script binds to the operator's local stack topology and
  is not public-safe in this form. See the marker comment for the
  generic placeholder language; the operator-specific values live
  only on the internal `main` branch.

### Fixed

- **`CHANGELOG.md`** — sanitised the v2.7-era historical port-mapping
  reference (line 227 in the prior version) to remove the literal
  coordinator publish port. The internal `main` branch retains the
  historical record; this public copy documents the change
  generically.

### Notes

- This is the first release cut under the new dual-remote discipline.
  The internal gitea repository (`origin`) tracks `main` on every
  push; the public github repository tracks `public/v2.8.x` only at
  release checkpoints. See `docs/security/branch-discipline.md` for
  the procedure future releases follow.

- The public-boundary checker, the 4-layer privacy filter, and the
  pre-push hook on `public/v2.8.x` together enforce that no
  operator-literal value reaches the github tree at any commit.

### AICM v1 support (cherry-picked from main, 2026-06-30)

Real CSA AICM v1 control IDs replace the previous placeholders. 184 verified control IDs across all 18 AICM v1 domains (76% of CSA's published 243-control universe).

- `src/compliance/aicm-v1-catalog.js` — generated AICM v1 control catalog (184 controls × 18 domains)
- `scripts/regenerate-aicm-catalog.js` — regeneration script that pulls from the OpenCRE TRACT public CSV mirror
- `docs/compliance/aicm-v1.md` — coverage documentation, sources, gap analysis
- `src/compliance/framework-mapper.js` — `CSA_AI_CM` framework now backed by the real AICM v1 catalog; all 10 AWARE component mappings updated to use real control IDs
- `src/compliance/evidence-collector.js` — 5 default collectors re-keyed from placeholder IDs to real AICM v1 IDs

**Privacy fix (95f1c25):** `scripts/regenerate-aicm-catalog.js` no longer hardcodes `/tmp/aicm-fetch/` (an operator-machine directory name); uses `os.tmpdir()` for OS-portable temp paths. Caught during the post-commit privacy audit.

**Testing:** 34/34 compliance-mapping tests pass; 18/18 tool-access-control tests pass.

**Sources:** AICM v1 spec at https://cloudsecurityalliance.org/artifacts/ai-controls-matrix ; control IDs verified against the OpenCRE TRACT public CSV mirror (https://github.com/rocklambros/TRACT).

**Open items:**
- Close the 76% → 100% coverage gap (184 → 243 controls) when CSA publishes a non-gated full mirror or OpenCRE updates their TRACT export. See `docs/compliance/aicm-v1.md` § "Closing the coverage gap".

## [Unreleased] — v2 OpenAPI: /tier-promotions + Mandate schemas (2026-07-06)

**Kanban:** t_58ba2031, t_e4aaab5d

### Added

- **`docs/openapi.yaml` v2 surface** — adds the contract RiskMandate.ai
  needs to consume AWARE tier-promotion events. Schemas: `TierPromotion`
  (AWARE event payload), `Mandate` (RM acceptance), `MandateCreate`
  (RM request), `MandateResponse` (RM response). Paths:
  `POST /v2/tier-promotions` (202 Accepted — event ingest) and
  `POST /v2/mandates` (201 Created, 409 on idempotency hit). All new
  paths are protected by `bearerAuth` (JWT) like the rest of the v2 API.

- **`src/v2/tier_promotions_handler.js`** — server-side handler for
  `POST /v2/tier-promotions` (the contract surface above). Validates
  the `TierPromotion` schema hand-rolled against openapi.yaml (required
  fields, UUID format, RFC3339 `promoted_at`, tier enum,
  `additionalProperties: false` at root). Mounted under `/v2` in
  `src/api/index.js` after the bearer-auth gate so 401 falls through
  cleanly. Persistence delegated to the DB-backed writer at
  `src/db/tier-promotions.js` (sibling card `t_5955682e`) via a
  dynamic-import bridge from this CJS handler; if the pool is
  unavailable the handler still returns 202 per the openapi spec
  ("the server has recorded the event; downstream Mandate creation is
  the coordinator's responsibility"). New unit suite:
  `test/unit/api/tier-promotions-handler.test.js` (39 cases — every
  validation branch + every HTTP status path).

### Fixed

- **`src/api/index.js`** — mount the v2 handler at the root path `/v2`
  (per openapi.yaml) rather than under `/api/v2`. The handler is
  lazy-required so a missing SECRET_KEY doesn't take the whole gateway
  down at boot (mirrors the existing identity-v2 mounting pattern).

### Schema-rigor notes

- `additionalProperties: false` on every new object schema (BLOCK-13
  precedent: closed root objects force clients to declare extensions
  explicitly).
- `Mandate.underwriters.minItems: 1` (RM "no executive accepts alone"
  — the deeper "min 2 / no one-person acceptance" rule is enforced by
  the RM policy engine, not the schema).
- `Mandate.expiry` is required on `Mandate` and `MandateCreate`
  (RM "no standing mandates" — grants that should persist must be
  renewed).
- `Mandate.direction` enum deliberately omits `deny` (RM's contract is
  to bound the agent's envelope, not to refuse it).
- `MandateResponse.ramm_level` (integer 1–5) surfaces the RiskMandate
  Maturity Model level alongside the grant, so the AWARE coordinator
  can record how mature the accepting organisation is.

### Out of scope (follow-up cards)

- `src/server.js` route handlers for `/v2/tier-promotions` and
  `/v2/mandates`.
- `src/coordinator/` tier-promotion trigger logic.
- `src/ui/` mandate-history views.
- RiskMandate API client.
- Docker compose changes.

## [Unreleased] — Tier-promotion audit log writer (2026-07-06)

**Kanban:** t_5955682e

### Added

- **`db/migrations/006_tier_promotions_audit_table.sql`** — forward migration
  for the `aware_tier_promotions` audit table. Two UNIQUE columns: `event_id`
  (wire-level UUID, mirrors openapi.yaml `TierPromotion.id`) and
  `idempotency_key` (sha256 of `(agent_id, from_tier, promoted_at, promoted_by)`)
  so coordinator retries can't double-write. Indexes on
  `(agent_id, promoted_at DESC)` and `(promoted_by, promoted_at DESC)` for the
  RM "show me this agent's history" and operator "what did this principal
  promote?" queries respectively.
- **`src/db/tier-promotions.js`** — `recordTierPromotion(conn, promotion)`
  writer. Validates the PBOM capability grammar (`<verb>:<resource>:<scope?>`)
  pre-DB so malformed entries fail loudly in the coordinator log instead of
  landing as garbage that RM can't query. Persists the wire-level TierPromotion
  shape plus the audit-only `policies_evaluated` (array of
  `{policy_id, parameters}` — RM reconstructs the approval rationale from
  this) and `idempotency_key`. ON CONFLICT (idempotency_key) DO NOTHING
  makes retries idempotent; the function also treats `event_id` UNIQUE
  collisions as `reason: 'duplicate'` (covers the case where a retry computes
  the same idempotency key from a re-derived timestamp). Never throws — the
  coordinator's request path is more important than the audit write.
- **`src/db/index.js`** — re-exports `recordTierPromotion`,
  `buildIdempotencyKey`, and `isValidCapability` from the db barrel.
- **`test/unit/db/tier-promotions.test.js`** — 28 new tests covering: pure
  helpers (`buildIdempotencyKey` determinism + field sensitivity,
  `isValidCapability` grammar), validation (every missing-required-field
  branch, invalid tiers, malformed capabilities, malformed
  `policies_evaluated`), connection handling (null conn, conn-without-query),
  happy path (SQL shape + param count + JSONB serialisation), idempotency
  (two identical writes produce exactly one row), distinct promoted_at
  produces a fresh row, `23505` unique-violation treated as duplicate,
  generic insert failure surfaces as `insert-failed` with the error message.

### Coverage

- `tier-promotions.js`: 100% statements / 100% lines / 91.54% branch /
  100% functions.
- Suite-wide: 90.09% statements / 90.09% lines (ADR threshold ≥ 88% ✓).

### Schema-rigor notes

- `policies_evaluated` is a JSONB array of `{policy_id, parameters}` objects
  (not a flat list of IDs) — RM queries need the parameters to reconstruct
  the "why this was approved" rationale.
- `capabilities_added` is validated against the PBOM grammar
  `<verb>:<resource>:<scope?>` pre-DB. Pre-validation means a malformed entry
  surfaces as `{recorded: false, reason: 'invalid-capability'}` instead of
  being persisted and silently ignored by downstream consumers.
- The migration is forward-only (no reversible) per the card body; the
  project convention has been forward-only migrations since 002.

### Out of scope (sibling cards)

- `src/server.js` route handlers for `/v2/tier-promotions` (separate card).
- Automatic emission from `src/coordinator/` tier-promotion logic (separate card).
- RM-side hook + RiskMandate API client (separate card).
- Retroactive backfill from existing tier events (separate card).
- UI surfaces (separate card).

## [Unreleased] — AWARE Evolution COMPLETE ✅ (2026-04-02)

**All 4 phases complete:**
- Phase 1: ✅ Complete (1.1–1.4 all delivered)
- Phase 2: ✅ Complete (ADR (internal), ADR (internal), ADR (internal), ADR (internal) — all APPROVED + IMPLEMENTED)
- Phase 3: ✅ Complete (ADR (internal)–019 all APPROVED/IMPLEMENTED)
- Phase 4: ✅ Complete (compliance-matrix.md documented)

### 2026-04-02 — All ADRs Approved ✅

**ADR Status Updates:**
- ADR (internal) (Phase 2.1 Pheromone Specialists): ✅ APPROVED + IMPLEMENTED
- ADR (internal) (Phase 2.2 Security-Weighted Heuristic): ✅ APPROVED + IMPLEMENTED
- ADR (internal) (Phase 2.3 Quality-Gated Reinforcement): ✅ APPROVED + IMPLEMENTED
- ADR (internal) (Phase 2.4 Hot-Reload Policy): ✅ APPROVED + IMPLEMENTED
- ADR (internal) (Phase 3.3 Decision-Chain Traceability): ✅ APPROVED + IMPLEMENTED
- ADR (internal) (Phase 3.4 GitOps Agent-as-Code): ✅ APPROVED (F-3 resolved, alert-only)

**New ADRs Created:**
- ADR (internal) (Phase 3.3 Decision-Chain Traceability): Hash-chained audit logging for tamper-evident decision trails
- ADR (internal) (Phase 3.4 GitOps Agent-as-Code): Git-based agent definitions with PR workflow and drift detection

**Documentation:**
- All ADRs now have clear approval status
- Phase 3.3/3.4 gaps closed with new ADRs
- EVOLUTION-BRIEF.md fully implemented

## [1.2.1] — 2026-04-01 — Phase 3.1 Implementation

### ADR (internal)/016: Phase 3.1C/3.2 — APPROVED + IMPLEMENTED + TESTED ✅

**Status:** APPROVED (Reviewer, 2026-04-01 22:05 BST, commit b0f7104) | IMPLEMENTED (Coder, 2026-04-01 22:35 BST, commit 5a67661) | TESTED (Tester, 2026-04-01 22:36 BST, commit f20c262)

**Testing:** 40/40 PASS ✅

**Implementation fixes (5a67661):**
- shadow-detector.js: Add confirmedShadow flag for shadow state detection
- tool-audit-logger.js: Fix apiKey redaction (added lowercase 'apikey' to sensitiveKeys)
- evidence-collector.js: Fix custom collector data structure (spread result directly)
- posture-calculator.js: Add priority field to recordGap with severityToPriority mapping

**ADR (internal): Tool Access Control & Enforcement**
- RBAC with 5 roles (admin, coder, researcher, tester, scribe)
- Gateway-level shadow tool detection with confirmedShadow flag
- Parameter schema validation (type/enum/range)
- Audit logging with sensitive data redaction

**ADR (internal): Compliance Mapping & Reporting**
- CSA AI CM, NIST AI RMF, ISO 27001, DORA mapping
- Automatic evidence collection with custom collector support
- Gap tracking with severity-based priority
- Compliance posture calculation and report generation

---

### ADR (internal): Phase 3.2 — Kill Switch Propagation & Emergency Shutdown ✅ APPROVED

**Status:** APPROVED (Reviewer, 2026-04-01 22:38 BST, commit 192db34) | IMPLEMENTED (Architect, commit be5b430)

**Findings fixed:**
- F-1 [MEDIUM]: Acknowledgment etcd write verification with retry
- F-2 [MEDIUM]: Override/Cancel Authority Matrix defined for all severity levels

**Key features:**
- Kill Switch Trigger Types (LOCAL/DOMAIN/GLOBAL severity levels)
- Raft-based broadcast propagation mechanism
- GRACEFUL and FORCED shutdown procedures
- Acknowledgment protocol with etcd write verification
- Post-emergency recovery and re-onboarding
- Override/Cancel Authority Matrix (GLOBAL kills require 3 C-level approvers)
- API endpoints for kill switch management
- Compliance mapping (CSA AI CM, NIST AI RMF, ISO 27001, DORA)

---

### ADR (internal): Phase 3.1B — Behavioural Anomaly Detection ✅ IMPLEMENTED

**Status:** APPROVED (Reviewer, 2026-04-01 21:10 BST) | IMPLEMENTED (Coder, 2026-04-01 21:24 BST)
**Commit:** `06c983e` (approved) | `85b04a1` (implemented)
**Testing:** 14/14 tests PASS

**Implementation:**
- computeZScore(): stddev=0 guard (F-2 fix)
- computeAnomalyScore(): corrected penalty formula (F-1 fix)
- classifySeverity(): uses BOTH anomaly AND trust score (F-3 fix)

### ADR (internal): Phase 3.1B — Behavioural Anomaly Detection ✅

**Status:** APPROVED (Reviewer, 2026-04-01 21:10 BST)
**Commit:** `06c983e`

**Findings resolved:**
- F-1: Penalty formula now INCREASES with anomaly (was decreasing/inverted)
- F-2: stddev=0 guard prevents NaN in computeZScore()
- F-3: classifySeverity() uses BOTH anomaly AND trust score

### ADR (internal): Phase 3.1A — Agent Identity & Authentication Framework ✅

**Status:** APPROVED (Reviewer, 2026-04-01 14:00 BST)
**Commit:** `b61fda3`
**Testing:** 27/27 tests passing (identity-v2.test.js)

**Content:**
- NHI lifecycle state machine (PENDING→APPROVED→ACTIVE→INACTIVE/REVOKED)
- Extended JWT claims: trustDomain, sessionId, executionContext, trustScore
- Zero-downtime credential rotation
- Session binding to execution context
- Identity attestation for cross-agent communication
- Distributed revocation cache with blast radius
- Fixes C-01 (hardcoded secret), C-02 (heartbeat auth), C-03 (fail-closed)

---

### ADR (internal): Phase 2.2 — Security-Weighted Heuristic Function ✅

**Status:** APPROVED (Reviewer, 2026-04-01 20:39 BST)
**Commit:** `39bc2be`

**Findings resolved:**
- F-2: validateWeights() function added to prevent NaN/Infinity
- F-5: ALPHA/BETA explicitly defined (1.0 default)
- F-6: heuristicSum=0 guard prevents division by zero

---

## [1.1.4] — 2026-04-01 — Phase 1.4 Complete

### Phase 1.4 — Kill Switch with Raft Consensus ✅

**Status:** Complete (2026-04-01)

**Components:**
- **RevocationEntry** (C-01): Proper revocation type for emergency shutdown
- **Raft Consensus** (C-02): Majority quorum for kill-switch decisions
- **Vote Granting** (C-03): Proper Raft vote granting via node registry
- **Kill Switch Routes** (C-04): Emergency shutdown endpoints mounted in src/api/index.js

**Testing:** 10/10 kill-switch tests passing (Tester verified)
**Commits:** `d4f44d7`, `aa278ab`, `f711c3d`, `2846e2e`

---

## [1.1.3] — 2026-04-01 — Phase 1.3 Complete

### Phase 1.3 — Behavioural Baseline & Anomaly Detection

**Added:**
- **Metrics Collector** — `src/monitoring/metrics-collector.js` — Singleton service aggregating agent metrics
- **Baseline Service** — `src/monitoring/baseline-service.js` — Rolling 7-day window, z-score computation, statistics (mean, stddev, p50-p99)
- **Anomaly Detector** — `src/monitoring/anomaly-detector.js` — Z-score thresholds (CRITICAL >4σ, HIGH >3σ, MEDIUM >2.5σ, LOW >2σ)
- **Fingerprint Service** — `src/monitoring/fingerprint-service.js` — Prompt injection detection (beyond Phase 1.3 spec)
- **Metrics Store** — `src/monitoring/store.js` — JSON persistence with atomic writes, 30-day retention
- **Metrics Router** — `src/api/routes/metrics.js` — 11 REST API endpoints

**Metric Types:**
- `TOOL_CALL_FREQUENCY` — Tool usage tracking per agent
- `RESPONSE_LATENCY` — Response time distribution
- `ERROR_RATE` — Error frequency per agent
- `DECISION_FINGERPRINT` — Prompt injection detection (beyond spec)

**Review:** ✅ Reviewer APPROVED (2026-04-01)
**Testing:** 47/52 passing | 6 pre-existing auth failures (api.test.js)
**Commits:** `d679ec6`, `e0c0fd2`, `a3ceaec`, `f7e7427`, `653ba7a`, `8159cf7`, `1bc02ce`

---

### Phase 1.2 — Per-Agent Sandbox Policies ✅

**Status:** Complete (2026-03-31)

**Added:**
- **Policy Engine core** — Model, Tool Catalog, Policy Store, Policy Engine, Policy Routes
- **Per-Agent Sandboxes** — sandbox policy schema (tools, network, trust level)
- **Tool Contract Registry**
- **Runtime policy reload without restart**

**Security Fixes (Phase 1.2):**
- Heartbeat spoofing prevention — Policy Engine verifies caller owns slot before heartbeat accepted

**Commits:** `92a9443`

---

## [1.1.1] — 2026-03-29 — Phase 1.1 Complete

### Added
- **Agent Registry** — NHI (Non-Human Identity) lifecycle management
  - `POST /registry/agent` — Register new agent with identity
  - `GET /registry/agent/:agentId` — Retrieve agent details
  - `PUT /registry/agent/:agentId/heartbeat` — Heartbeat with ownership verification
  - `DELETE /registry/agent/:agentId` — Deregister agent
  - `GET /registry/agents` — List all registered agents
  - `GET /registry/agent/:agentId/telemetry` — Decision event telemetry
- **Decision Event Telemetry** — Observable routing decision trails
- **SQLite storage backend** — `src/store/etc7-store.ts` interface
- **etcd storage backend** — `src/store/etcd-store.ts` (production)

### Security Fixes (Phase 1.1)
- `trustDomain` — Server-assigned, not client-supplied (commit 44974f6)
- `webhookUrl` — SSRF protection via blocklist validation (commit 44974f6)

### Testing
- 17/17 unit tests pass
- Integration tests require etcd on port 18900

### Dependencies
- etcd (port 18900) for integration tests

---

## [v2.7.3] — 2026-06-27 — coordinator LLM reachability + probe auth

### Fixes
- **`docker-compose.coordinator.yml`** — the coordinator container now receives the
  LLM provider API key in addition to the existing `LLM_API_KEY`. The internal
  rl-pipeline client reads its credential directly from the environment with no
  fallback to `LLM_API_KEY`, so without this pass-through the provider client
  constructor threw at request time and `/coordinate` returned a backend-failure
  error. Verified live: the `/coordinate` round-trip now returns real LLM
  responses.

- **`docker-compose.coordinator.yml`** — revert the coordinator publish
  port mapping to the schema's documented value. Originally introduced
  as part of an earlier runtime-evidence update but never propagated
  to the schema, README, smoke tests, and probe script that all
  hardcode the same value. The `0.0.0.0` binding rationale is
  preserved; only the port mapping changes.

### Probe
The daily AWARE plugin loadability probe was failing 4/6 because `/coordinate`
requires an authorization credential (added in the Phase 1 security release) but
the probe was sending none. The probe now reads the credential from the
operator's `.env` and includes it on the request, with a no-auth fallback for
dev mode. **The probe now passes 6/6.**

### Operator actions required after upgrading to v2.7.3
- Set the LLM provider API key in the operator's compose `.env` to match the
  canonical credential stored in the OpenClaw gateway configuration. The prior
  value was truncated / wrong tier and was rejected by the provider with a
  401 authentication error.
- Apply the matching probe script change in the operator's probe location. See
  the v2.7.3 commit body for the full diff description.

### Deferred to v2.8.x
- **Adapter-layer bridge in `src/coordinator/index.js`** so a single credential
  name is canonical end-to-end. Today the AWARE code reads `LLM_API_KEY` and
  the rl-pipeline source reads a different name; the compose file passes both,
  but the right long-term answer is one name.
- **Move the loadability probe into `scripts/`** so it ships with every clone
  and operators get updates automatically.
- **Single source of truth for the LLM credential** — compose should read from
  the OpenClaw gateway configuration directly so there is one credential
  location, not two. The current copy-paste is fragile: if the key rotates,
  both files must update.
- **rl-pipeline distribution model.** The public `GoodCISO/aware` clone cannot
  fetch the rl-pipeline source (the URL is intentionally not vendored into the
  image; see the SEC-007/008 design notes in `Dockerfile.coordinator`). Either
  vendor the rl-pipeline source into the public repo, or stop shipping
  `docker-compose.coordinator.yml` to external consumers and document
  "operator-only builds."
- **LaunchAgent supervisor** for the `aware-2-coordinator` container. When it
  exits, nothing restarts it.

### Verification
```
=== aware-plugin loadability probe (2026-06-27) ===
  ok  live install dir exists
  ok  worktree install dir exists
  ok  smoke-test.js passes 26/26
  ok  AWARE coordinator /health responds
  ok  AWARE /coordinate round-trip returns ok:true
  ok  gateway log shows 'aware' plugin registered

=== Summary: 6/6 checks passed ===
PROBE PASSED — aware plugin loadable + AWARE coordinator live.
```

---

## [Prior] — Original AWARE (Distributed Systems Platform)

Original AWARE was a distributed systems platform using ant colony-inspired algorithms for cluster coordination and resource optimization. This is now archived at `docs/legacy/README-v1.md`.

---

## Phase Status

| Phase | Name | Status |
|-------|------|--------|
| 1.1 | Agent Identity Layer | ✅ Complete |
| 1.2 | Per-Agent Sandbox Policies | ✅ Complete |
| 1.3 | Behavioural Baseline | ✅ Complete |
| 1.4 | Kill Switch | ✅ Complete |
| 2.1 | Pheromone Specialists | 🔄 In Progress |
| 2.2 | Security-Weighted Heuristic | ✅ APPROVED (ADR (internal)) |
| 3.1 | Agent Identity & Authentication | ✅ APPROVED (ADR (internal)) |
| 3.1B | Behavioural Anomaly Detection | ✅ IMPLEMENTED (ADR (internal)) |
| 3.1C | Tool Access Control | ✅ APPROVED + IMPLEMENTED + TESTED (ADR (internal), 40/40 PASS) |
| 3.2 | Compliance Mapping | ✅ APPROVED + IMPLEMENTED + TESTED (ADR (internal), 40/40 PASS) |
| 3.2 | Kill Switch Propagation | ✅ APPROVED (ADR (internal)) |

---

*Generated by Chronicler (Scribe) — 2026-04-01*
