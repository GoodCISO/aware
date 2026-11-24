# AWARE 2.0 — RLM Configuration

**Status:** A1.1 revision. Resolves G1 FINAL findings (12 BLOCKs + 22 FLAGs + 7 ALIGNs) per `~/.openclaw/symphony-v3/workspaces/task-4423/output/findings.json`.
**Owner:** Archimedes (architect).
**Last updated:** 2026-06-28.

This document describes how AWARE 2.0 configures the **RLM (Recursive Language Model)** primitive — the library at `~/src/rlm/` (Zhang, Kraska, Khattab 2026, arXiv:2512.24601) wrapped by the OpenClaw plugin at `~/src/rlm-plugin/`. The primitive is paper-faithful and AWARE-agnostic; AWARE supplies policy.

| File | Purpose |
|---|---|
| `config/rlm.yaml` | Canonical defaults (this file is the source of truth at boot) |
| `config/rlm.schema.json` | JSON Schema draft-07 validation of `rlm.yaml` |
| `docs/rlm.md` (this file) | Prose: rationale, examples, design decisions, cross-refs, findings resolution |

## Layering

```
~/src/rlm/                 ← library (paper-faithful, no AWARE conventions)
~/src/rlm-plugin/          ← OpenClaw plugin wrapping the library
~/src/AWARE/config/rlm.*   ← AWARE policy layer (THIS work)
```

**Per the F-007 / F-011 / F-015 resolution: the primitive owns enforcement, AWARE owns policy.** Concretely: the library ships its REPL subprocess driver with seccomp + forbidden-imports + landlock; AWARE's job is to set the workspaceDir root, the tool whitelist, the audit field names, the redaction list, the forwarded-options surface, and the kill switch.

## Findings resolved in this revision

The G1 FINAL re-review (`task-4423/output/findings.json`) surfaced 12 BLOCKs + 22 FLAGs. This A1.1 revision resolves them as follows.

| Finding | Severity | Status | YAML field |
|---|---|---|---|
| BLOCK-1: Context schema conflict (SPEC+API vs ARCH) | BLOCK | RESOLVED | `rlm.context.allowedTypes`, `fieldName: type` |
| BLOCK-2: Decomposition prompt style (zero-shot vs 3-shot) | BLOCK | RESOLVED | `rlm.fewShotExamples: 0`, `rlm.decompositionFormat: plain-text` |
| BLOCK-3: Verification forwarding (NOT vs forwarded) | BLOCK | RESOLVED | `rlm.forwardedOptions.verification` |
| BLOCK-4: Decomposition scope (root-only vs every non-leaf) | BLOCK | RESOLVED (A1.1.1) | `rlm.decompositionScope: every-non-leaf` (matches `~/src/rlm/src/rlm/tree.js:63`; original A1 prose misread `SPEC §6.4` as root-only) |
| BLOCK-5: PRM weighting in aggregation | BLOCK | RESOLVED | `rlm.forwardedOptions.prm.enabled: true` |
| BLOCK-6: RlmContextTooLargeError missing | BLOCK | RESOLVED | `errors.contextTooLargeThresholdBytes` |
| BLOCK-7: Sandbox tool divergence (ARCH sub_lm vs SPEC §11) | BLOCK | RESOLVED | `rlm.tools.allowed` (7-tool union, sub_lm dropped) |
| BLOCK-8: rlm() missing forwarded options (`verification`, `prm`) | BLOCK | RESOLVED | `rlm.forwardedOptions` |
| BLOCK-9: Root preference pair schema divergence from HeavySkill | BLOCK | RESOLVED | `rlm.audit.preferencePair` |
| BLOCK-10: Two incompatible schemas for same JSONL (ARCH §9 vs SPEC §8.1) | BLOCK | RESOLVED | `rlm.audit.preferencePair.perCallOnly: true` |
| BLOCK-11: SPEC §3.2 'sqlite' context type requires sqlite-vec | BLOCK | RESOLVED | `sqlite` dropped from `rlm.context.allowedTypes` (deferred v1.1) |
| BLOCK-12: SPEC §9.2 sub_calls assertion mathematically wrong | BLOCK | REOPENED then RESOLVED (A1.1.1) | `sub_calls = 2 × N_non_leaf + N_leaves` (every-non-leaf decomposition; verified against `~/src/rlm/src/rlm/tree.js:63` and `countCalls()` JSDoc which states "default tree shape (max_depth=2, branching=3) this is 17"). Round-1 close (root-only formula, works only at depth=2) and round-2 G2 closed-form geometric series (also root-only) both invalidated — see `SPEC.md §3.3` BLOCK-12 history for full audit trail. |
| F-001 budget default | BLOCK | RESOLVED | `rlm.budgetUsd: null` |
| F-003 / F-004 workspaceDir | BLOCK | RESOLVED | `rlm.workspaceDir` + canonicalization rules |
| F-005 decomp format | BLOCK | RESOLVED | `rlm.decompositionFormat: plain-text` |
| F-007 / F-011 / F-015 sandbox | BLOCK | RESOLVED | `rlm.sandbox` |
| F-008 audit field names | BLOCK | RESOLVED | `rlm.audit.component: rlm`, `kindNode: rlm_node` |
| F-016 redaction | BLOCK | RESOLVED | `rlm.audit.redactFields` (Sentinel audit pending) |
| F-023 tool whitelist | BLOCK | RESOLVED | `rlm.tools.allowed` (7 tools) |
| F-024 default-budget unworkable | BLOCK | DISSOLVED | `budgetUsd: null` removes the failure mode |
| F-012 budget cap too tight | BLOCK | DISSOLVED | Same as F-024 |
| F-010 macOS landlock | FLAG | DOCUMENTED | `rlm.sandbox.landlock: linux-only`, caveat in this doc |
| F-013 preferencePairPath | FLAG | OOS FOR V1 | rl-pipeline-bridge README disclaims HeavySkill integration |
| F-014 preferParallel | FLAG | OOS FOR V1 | `rlm.tree.preferParallel: false`, ARCH §4 stale |
| F-018 envMode (SPEC §11 vs ARCH §5) | FLAG | RESOLVED | `rlm.sandbox.envMode: cleared` (env -i wins) |
| F-019 onBudgetExhausted='return-partial' (non-existent option) | FLAG | RESOLVED | Not in YAML; if API.md §7.2 illustrates it, that doc is stale |
| F-15..17 (file layout, leaf_K, RlmNode.cost) | MEDIUM | SPEC FOLLOW-UP | Prose issues, not config |
| F-20..22 (remaining FLAGs) | MEDIUM/LOW | Per-finding | See verdict.json close-out |

## Configuration fields

Every field below corresponds to a key in `config/rlm.yaml`. Env-var overrides follow the `AWARE_RLM_<FIELD>` pattern.

### `rlm.enabled` (boolean, default `true`)

Master switch. When `false`, the adapter short-circuits and never invokes `rlm()`. Audit logs the disablement.

### `rlm.budgetUsd` (number | null, default `null`)

Per-call USD cap. `null` means no cap; cost is always recorded in the audit log but never enforced. Set to a number to opt in to enforcement.

**Design decision (F-024 / F-012):** AWARE has no product-level budget limit. v1 ships with `null` and records cost for observability. Callers who want enforcement set `budgetUsd` themselves. This dissolves the F-024 finding — the default-budget-100%-failure mode cannot exist when enforcement is opt-in.

### `rlm.tree.*` (numbers)

| Field | Default | Meaning |
|---|---|---|
| `maxDepth` | `2` | Tree depth. min 1, max 5 (schema cap). |
| `branching` | `3` | Children per non-leaf. min 1, max 5. |
| `K` | `4` | HeavySkill K-parallel attempts per leaf. min 1, max 8. |
| `preferParallel` | `false` | OOS for v1. ARCHITECTURE §4 reference is the stale doc. |

Default tree at depth=2, branching=3 → 9 leaves.

### `rlm.context.*` (BLOCK-1, BLOCK-11 resolution)

| Field | Value | Meaning |
|---|---|---|
| `allowedTypes` | `[directory, pdf, log]` | v1 enum. SPEC §3.2 wins; ARCH §5 alternatives dropped. |
| `fieldName` | `type` | Field name is `type`, NOT `kind` (per SPEC §3.2). |
| `defaultKind` | `directory` | When no `type` is specified. |
| `maxBytes` | `10485760` (10 MiB) | Hard cap; raises `RlmContextTooLargeError`. |

**Deferred to v1.1** (per ARCHITECTURE §10): `repo`, `buffer`, `sqlite`. `sqlite` deferred because v1 IngestIndex=none and sqlite requires sqlite-vec (BLOCK-11).

### `rlm.forwardedOptions.*` (BLOCK-3, BLOCK-8 resolution)

| Field | Value | Meaning |
|---|---|---|
| `verification.enabled` | `true` | `verification` forwarded to leaves (matches ARCHITECTURE §4 + HeavySkill's verify.js signature). |
| `verification.allowedMethods` | `[exec, llm-judge]` | `exec` is a code-execution vector; documented security consideration. |
| `verification.defaultMethod` | `llm-judge` | Safer default; callers opt into `exec` explicitly. |
| `prm.enabled` | `true` | `prm` forwarded; PRM-weighted aggregation (BLOCK-5). |

### `rlm.tools.allowed` (array of 7 strings)

The 7-tool whitelist: `read, grep, slice, vec_search, len, keys, print`.

**Resolution (BLOCK-7):** union of ARCHITECTURE §5 + SPEC §11, with `sub_lm` dropped (paper §7 marks async sub-calls as future work; `sub_lm` was a v2 feature accidentally listed in v1 docs).

`vec_search` is only meaningful when `IngestIndex != none`; v1 is none, so `vec_search` is a no-op in v1 (no error, just returns empty).

REPL op enforcement is **AST-based** for both Python (stdlib `ast`) and JS (`acorn`). The REPL driver rejects any leaf-emitted code containing disallowed operations, in addition to the library's existing forbidden-imports list.

### `rlm.workspaceDir` (absolute path)

All REPL path operations are confined to this directory. The adapter:

- **Rejects absolute paths outside this root** (F-003).
- **Rejects `..`** in any path component (F-003).
- **Rejects symlinks pointing outside this root** (G1 symlink-traversal finding).
- **Canonicalizes** all paths before comparison.

The default `/var/aware/rlm/workspace` is a placeholder — deployments must set this to a real path (e.g. `${AWARE_DATA_DIR}/rlm/workspace`).

### `rlm.decompositionFormat` (`plain-text`) and `rlm.decompositionScope` (`every-non-leaf`)

- **Format:** plain-text with structured delimiters (matches `~/src/rlm-plugin/src/rootPrompt.js`). JSON-shaped decomposition was the stale doc.
- **Scope (BLOCK-4, A1.1.1):** `every-non-leaf` for v1. The actual implementation in `~/src/rlm/src/rlm/tree.js:63` decomposes at every non-leaf node (`Decompose (EVERY non-leaf node per SPEC §6.4 / ARCH §3)`); the "root-only" interpretation in the original A1 prose was a misread of `SPEC §6.4`. The YAML default was updated from `root-only` to `every-non-leaf` at 2026-06-28 ~12:48 UTC to match the implementation. This change also invalidates the round-1 and round-2 BLOCK-12 formula corrections — see `SPEC.md §3.3` for the corrected `sub_calls = 2 × N_non_leaf + N_leaves` formula and the BLOCK-12 history.

### `rlm.sandbox.*`

| Field | Default | Meaning |
|---|---|---|
| `enforcement` | `required` | Adapter refuses `rlm()` calls without sandbox. |
| `privilegeDrop` | `required` | REPL spawns with `setuid`/`setgid` drop. |
| `opFilter` | `ast-whitelist` | Python `ast` + JS `acorn` AST filter on leaf-emitted code. |
| `seccomp` | `true` | Library's existing seccomp profile (blocks socket/connect/accept/recv/send). |
| `landlock` | `linux-only` | macOS has no landlock; v1 documented as supported-with-caveats. |
| `envMode` | `cleared` | `env -i` (FLAG-18 resolution). SPEC §11 wins over ARCHITECTURE §5's "PATH + LANG only." |
| `rlimitAsMb` | `512` | Per-REPL address-space cap. |
| `rlimitCpuSeconds` | `30` | Per-op CPU cap. |
| `wallClockSeconds` | `2` | Per round-trip wall-clock cap. |

### `rlm.audit.*` (F-008, BLOCK-9, BLOCK-10)

| Field | Value | Meaning |
|---|---|---|
| `component` | `rlm` | Canonical field name; no override. |
| `kindNode` | `rlm_node` | Canonical field name; no override. |
| `costRecorded` | `always` | Cost recorded whether or not budget enforcement is on. |
| `redactFields` | `[userPrompt, contextPayload]` | Stripped before audit-log persistence (F-016). **Sentinel audits before C1 lands.** |
| `preferencePair.discriminatorField` | `component` | `component: 'rlm'` for root-level pair; `component: 'heavy_think'` for leaves. |
| `preferencePair.rootComponentValue` | `rlm` | See above. |
| `preferencePair.leafComponentValue` | `heavy_think` | HeavySkill's existing value; preserved. |
| `preferencePair.schema` | `heavy-skill` | Root pair uses HeavySkill's exact shape (BLOCK-9): `{ts, problem, task_type, chosen: {reasoning, prm_score}, rejected: {reasoning, prm_score}, all_attempts, verification, cost, _content_hash}`. |
| `preferencePair.perCallOnly` | `true` | ONE pair per `rlm()` call (BLOCK-10). The per-internal-node claim in ARCHITECTURE §9 is dropped. |
| `preferencePair.treeSubfield` | `tree` | rlm-specific extension; null for leaves. |

### `rlm.fewShotExamples` (number, default `0`)

v1 ships with zero in-context examples (BLOCK-2 resolution). Matches the `rlm-plugin` README's paper-faithful discipline: no async sub-calls, no guardrails, no HeavySkill integration. Deferred to v1.1 after observing real decompositions.

### `rlm.killSwitch` (boolean, default `false`)

When `true`, the adapter refuses to invoke `rlm()` and audit-logs the refusal. Mirrors the existing `AWARE_KILL_SWITCH` and `AWARE_GATEWAY_KILL_SWITCH` patterns. Env-var override: `AWARE_RLM_KILL_SWITCH`. Lazy getter — takes effect on the next request, no restart.

### `errors.contextTooLargeThresholdBytes` (BLOCK-6)

Threshold for `RlmContextTooLargeError` (which was missing from the v1 error hierarchy). Default 10 MiB. Adapter raises this error when `context.bytes` exceeds the threshold, before invoking the REPL.

## Design decisions (no ADR dir exists in AWARE)

The AWARE repo does not currently have a `docs/adr/` directory; this section captures the load-bearing decisions inline. If/when ADR infrastructure is added, these four decisions should be lifted into numbered ADRs.

### Sandbox boundary

**Decision:** The RLM primitive owns *enforcement* (REPL subprocess isolation, seccomp, forbidden imports); AWARE owns *policy* (workspaceDir root, tool whitelist, redaction, kill switch, forwarded-options surface).

**Rationale:** This is the architectural call that determines who fixes what when something breaks. Future RLM maintainers working on `~/src/rlm/` should not need to know about AWARE conventions; future AWARE security reviewers should not need to read Python lib code to audit the boundary. The two layers are independently auditable.

**Trade-off:** The adapter has to re-implement some validation that the library could (path canonicalization, symlink rejection). This is intentional duplication for boundary clarity.

### Budget posture

**Decision:** Default `rlm.budgetUsd=null` (no cap). Cost always recorded. Enforcement is opt-in per call.

**Rationale:** AWARE has no product-level cost cap (Alvin directive 2026-06-27). Defaulting to null avoids the F-024 failure mode. Recording cost always gives AWARE operators the data they need to set their own cap when they want one.

**Trade-off:** A misconfigured caller could rack up unbounded cost. Mitigated by: (a) audit log always records cost, (b) tree-shape defaults are conservative (depth=2, branching=3, K=4 → 9 leaves), (c) the `rlm.killSwitch` is always available.

### Verification forwarding with code-execution risk

**Decision:** Forward `verification` from `rlm()` to leaves (matches HeavySkill's `verify.js`). Default method `llm-judge`. `exec` method is opt-in and documented as a code-execution vector.

**Rationale:** Block-3 / Block-8 finding. HeavySkill's reality is that leaves can run `verify.js`, which has an `exec` method (runs shell commands). The original SPEC §5.1 was wrong to say verification is "NOT forwarded." Forwarding it is correct, but the security implication needs to be visible at the AWARE layer because the adapter's `workspaceDir` confinement is what makes `exec` safe — without it, `exec` is unbounded host access.

**Trade-off:** Documentation burden is higher; new AWARE operators need to understand that `verification.method: 'exec'` is privileged.

### Context shape (kind vs type)

**Decision:** Field name is `type`, value set is `[directory, pdf, log]`.

**Rationale:** BLOCK-1 / BLOCK-11 resolution. SPEC §3.2 is the more recent doc and the more conservative enum. ARCHITECTURE §5's `kind` field with `[file, dir, repo, buffer]` was either an early draft or a v2 design. Picking the SPEC enum keeps v1 minimal: 3 types, no `sqlite` (which requires sqlite-vec), no `repo` / `buffer` (deferred).

**Trade-off:** If a downstream consumer needs `buffer` (in-memory contexts), they have to wait for v1.1.

## Examples

### Read the configured value at runtime (planned)

The runtime hook for these settings is not yet wired (see "Open work" below). The intended shape:

```javascript
import rlmConfig from '../config/rlm.cjs';
console.log(rlmConfig.budgetUsd);                // null
console.log(rlmConfig.context.allowedTypes);     // ['directory', 'pdf', 'log']
console.log(rlmConfig.tools.allowed);            // ['read', 'grep', 'slice', 'vec_search', 'len', 'keys', 'print']
console.log(rlmConfig.sandbox.enforcement);      // 'required'
console.log(rlmConfig.audit.preferencePair.schema); // 'heavy-skill'
```

### Override via env var (planned)

```bash
export AWARE_RLM_BUDGET_USD=5.00                # opt into $5/call enforcement
export AWARE_RLM_KILL_SWITCH=1                  # disable rlm() entirely
export AWARE_RLM_FORWARDED_OPTIONS_VERIFICATION_ALLOWED_METHODS=exec,llm-judge  # opt into exec verification
```

## Open work

These items are explicitly out of scope for the A1.1 revision. They're called out so the next pass (C1 implementation + G2 re-review) doesn't miss them.

- ~~**Runtime config hook** (`src/config/rlm.cjs`)~~ — **RESOLVED (t_0ff3a7b9, 2026-11-11).** `src/config/rlm.cjs` now exists: it loads `config/rlm.yaml`, validates it against `config/rlm.schema.json` with ajv, exposes the namespace via `rlmConfig.<field>` and the standard `validate()` / `warnings()` / `snapshot()` API, and enforces the **verification-method guard** — a configured `defaultMethod` / `allowedMethods` entry with no implementation behind it is rejected at LOAD time, naming the offending method and the implemented set. The guard reads the live registry exported by `backend/heavy-think/src/verify.js` (`VERIFICATION_METHOD_NAMES`), so it cannot drift from the implementation. `llm-judge` — the previously unimplemented configured default — is now implemented in `verify.js`.
- **Sentinel audit of `rlm.audit.redactFields`** — current list (`userPrompt`, `contextPayload`) is best-effort. Sentinel reviews before C1 lands.
- **`workspaceDir` deployment default** — placeholder `/var/aware/rlm/workspace` must be replaced with a deployment-specific value. Possibly `${AWARE_DATA_DIR}/rlm/workspace` once `AWARE_DATA_DIR` convention is settled.
- **macOS landlock follow-up** — v1 documents this as supported-with-caveats; a future version may add a macOS-specific sandbox profile (sandbox-exec profile, gVisor, or similar).
- **BLOCK-12 SPEC.md prose revision** — `sub_calls` formula was round-1-closed (`1 + branching^(max_depth - 1) + branching^max_depth`, root-only, correct only at max_depth=2), then round-2 G2 generalized to closed-form geometric series (`1 + Σ_{i=1}^{max_depth-1} branching^i + branching^max_depth`, still root-only). Both formulas assumed root-only decomposition, which contradicted the actual implementation at `~/src/rlm/src/rlm/tree.js:63` (`Decompose (EVERY non-leaf node per SPEC §6.4 / ARCH §3)`). The canonical formula is now `sub_calls = 2 × N_non_leaf + N_leaves`, verified against `tree.js:countCalls()` JSDoc which explicitly states "default tree shape (max_depth=2, branching=3) this is 17". SPEC §3.3 (formula + JSDoc), §8.1 (worked example: sub_calls 7→10, decomposition_usd 0.002→0.006, total_usd 0.21→0.218), and §9.2 (assertion formula) updated. config/rlm.yaml:decompositionScope updated to `every-non-leaf`. T1 unblocked.
- **`preferParallel`** — explicitly OOS for v1; ARCHITECTURE.md reference is the stale doc.
- **`Few-shot examples`** — explicitly deferred to v1.1; SPEC §6.5 mandate is the stale doc.
- **Deferred context types** — `repo`, `buffer`, `sqlite` deferred to v1.1 per ARCHITECTURE §10.
- **Verification.exec safety profile** — `verification.allowedMethods` includes `exec`. The sandbox policy already constrains what `exec` can do (workspaceDir, seccomp, etc.), but a future version may want an additional allowlist of executables.

## See also

- `~/src/rlm/` — the RLM library (paper-faithful).
- `~/src/rlm-plugin/` — the OpenClaw plugin wrapping the library.
- `~/src/heavy-think/src/preference-pair.js` — HeavySkill's preference-pair writer (the schema `rlm.audit.preferencePair.schema: heavy-skill` defers to).
- `~/src/heavy-think/src/dpo-format.js` — DPO format converter (read alongside `preference-pair.js` for the full schema).
- `~/src/AWARE/config/rlm.yaml` — defaults (canonical).
- `~/src/AWARE/config/rlm.schema.json` — JSON Schema validation.
- `~/src/AWARE/config/modal-training.schema.json` — sibling schema for style.
- `~/src/AWARE/config/pheromone-rates.yaml` — sibling YAML for style.
- `~/src/AWARE/docs/config.md` — sibling prose for env-var override conventions.
- G1 INBOX notes (2026-06-25) — `~/.openclaw/workspace-architect/INBOX/2026-06-25-aware-rlm-*.md`.
- G1 FINAL findings.json — `~/.openclaw/symphony-v3/workspaces/task-4423/output/findings.json`.
- Verdict close-out — `~/.openclaw/symphony-v3/workspaces/task-4423/verdict.json`.