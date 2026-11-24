# ADR-080 — `decisionChainDepth` is a read-time derived metric over the audit chain, not an emitted `MetricType`

**Status:** Accepted (design) · **Date:** 2026-11-12
**Author:** Archimedes (architect)
**Reviewers:** reviewer (sign-off card `t_8ca293fd` — Critic review of ADR-080 + the renumber sweep)
**Task:** `t_49fe6a7e` (design card; filed by scribe from the RLT spike verdict `t_47925aa7`)
**Sibling card:** `t_7101e614` (RLT defer-watch registration) — a watchlist, independent of this record
**Renumbered from:** ADR-079 — the original number was taken by `ADR-079-aware-disclosure-record-generator.md` (Forge, coder, 2026-11-11), which exists only on the **local `main` lineage** (introduced in `a85b0c0b`); `origin/main` carries no ADR-079 at all. Number never reused; the record keeps its content and gains the next free number. On the reconciled lineage both records are present, and the pair is legal: `ADR-079` and `ADR-080` are each unique, so the filename-uniqueness rule in `scripts/pre-commit-check.sh` passes (verified: the gate exits 0 on the reconciled tree, and exits 1 when a second file claims `079`). On `origin/main` the number 079 was in fact free, so the gate's filename-uniqueness rule would not itself have refused the original filename there — the collision exists on the local-main lineage, and reconciling the two lineages brings it into existence.
**Related:** `src/audit/decision-logger.js` (chain reader/writer) · `src/monitoring/metrics-collector.js` (metric-type enum) · `src/monitoring/baseline-service.js` (baseline gate) · `src/monitoring/anomaly-detector.js` (consumer) · `src/compliance/atlas-mapper.js`, `src/compliance/ast10-mapper.js`, `src/compliance/llm09-mapper.js`, `src/compliance/mcp-top10-classifier.js` (the four compliance mappers — the only non-null-parent producers that are *instantiated* in a deployed image) plus `src/coordinator/adapters/mcp.js:410` (producer-capable, not instantiated — see §3.1) · `src/policies/tool-observation-proxy.js` (the annotation gate)
**Predecessor:** none — this is the first decision on audit-chain depth as an analytics quantity
**Verified against:** AWARE `origin/main` @ `a78bd3d8` (measurement base). Re-verified on the reconciled lineage — see §9.1.

---

## 1. Context

The card asks for one new metric:

> **`decisionChainDepth`** — the number of ancestor hops from a decision record to its chain root, measured along `parentDecisionId`.

The card's own premise (§2, reason 2) claimed *there is no chain to measure depth along*, citing `src/coordinator/http-server.js:945`. That premise was corrected on 2026-11-12 (09:11 card comment): the citation is real, the inference was not — the chain exists in the audit log, `src/audit/decision-logger.js:496` walks it root-first, and several producers set a non-null `parentDecisionId`.

**This record corrects that correction.** The correction established that a *producer exists in source*. It did not establish that the *population exists in production*. Measured live on 2026-11-12, the population does not exist.

## 2. Measurement — the population is EMPTY, not bimodal

Measured inside the running coordinator container (`aware-2-coordinator`), against the live chain file:

| Quantity | Value |
|---|---|
| Chain file | `/data/audit/decision-chain.jsonl` (volume `aware-2-audit-data`) |
| Size / records | 184,918,147 B · **321,587** parseable records |
| File mtime | 2026-11-12T08:30Z |
| Measured at | 2026-11-12T08:30Z — the file is **live and growing**, so the record count identifies one snapshot, not a standing fact; re-measure before quoting it |
| Records with `parentDecisionId != null` | **0** |
| Records with a dangling parent | 0 (vacuous — no record has a parent) |
| Depth histogram | `{0: 321,587}` — every record is a root |
| `action.type` distribution | `coordinate` 321,586 · `probe` 1 |

The 09:11 comment predicted a **bimodal** population (0 for coordinator-sourced decisions, >0 for atlas/mcp-sourced ones). The measurement shows a **degenerate** population: the >0 arm does not exist at all. 0.00 % of 321,587 live records are chained.

## 3. Why the population is empty — three deployment facts, each measured

**3.1 The chained producers are deployed on a read-only audit mount — and the one producer-capable site inside the coordinator is unreachable.**

The sites that set a non-null `parentDecisionId` are the four compliance mappers (`atlas-mapper.js:728`, `ast10-mapper.js:651`, `llm09-mapper.js:130/163/266/326/379`, `mcp-top10-classifier.js:558`) plus one site in the coordinator itself (`src/coordinator/adapters/mcp.js:410`, see below). The compliance modules exist only in the **gateway** image (`aware-2-gateway`), which mounts the audit volume **`rw=false`**:

```
aware-2-gateway     -> aware-2-audit-data -> /data/audit rw=false
aware-2-coordinator -> aware-2-audit-data -> /data/audit rw=true
```

The **coordinator** — the only service with a writable audit mount, and the writer of all 321,587 records — has **no compliance or monitoring modules at all**: `/app/src` contains `audit, budget, config, coordinator, db, policies, trainer`. So the service that *can* write the chain cannot produce a chained record, and the service that *can* produce a chained record cannot write the chain. The read-only gateway mount is a deliberate containment control (`docker-compose.coordinator.yml:156-160`: *"a compromised gateway can't tamper with the chain"*), not an oversight.

**The one exception, and why it does not chain.** `src/coordinator/adapters/mcp.js:410` sets `parentDecisionId: this.parentDecisionId` and its record is written by the coordinator itself (the adapter resolves `../../audit/decision-logger` at `mcp.js:303`), so this site is inside the writable image. It produces no chained record for two independent reasons, both verified on `origin/main` @ `a78bd3d8`:

1. **No parent is ever supplied.** The adapter's constructor defaults the field to `null` (`mcp.js:285`, `opts.parentDecisionId || null`). The only construction site in `src/` is `src/coordinator/index.js:372`, `new mod.MCPAdapter()`, which passes no options; `getMCPAdapter()` (`index.js:390`) returns the **class**, not an instance, so it cannot carry a parent either.
2. **The emit path has no production caller.** `emitMessage` is reached only through `observeMcpMessage` (`index.js:369`), which is defined and exported but has **no caller in `src/`** — only `test/unit/coordinator/adapters/mcp.test.js` calls it.

So the MCP adapter is a producer-capable site that never produces a chained record. It is recorded here rather than in §9 because it is the counterexample to the "only the gateway can chain" shape above, and because it changes the cost model in §5: a coordinator-native chain for MCP traffic needs **no image change and no mount change** — but it needs two things, not one: a production caller for `observeMcpMessage`, and a parent id supplied at the construction site that caller reaches.

**3.2 The annotation path is gated off and un-instantiated.**

`tool-observation-proxy.js:116` reads `this.enableATLASAnnotation = config.enableATLASAnnotation === true` — **default OFF**. In the deployed gateway, `createToolObservationProxy` has **no call site** outside its own definition and its re-export (`src/policies/tool-observation-proxy.js:1165` defines it; `:1176` is the `new ToolObservationProxy` inside it; `src/policies/index.js:52,109` only re-export it). No proxy instance is constructed at runtime, so the annotation branch is unreachable regardless of the flag.

**3.3 The metric pipeline has no producer either.**

`MetricType` (`metrics-collector.js:10-17`) declares five types. `recordLatency`, `recordTokenCount`, `recordToolCall`, `recordError` have **no call sites outside `src/monitoring/`** in the source tree, and `POST /api/metrics/emit` is defined but never called internally. The metrics store is a JSON file under the container filesystem (`src/monitoring/store.js:9-13` → `src/data/monitoring/`), not a shared volume — so metrics are per-container and ephemeral across restarts.

## 4. Decision

### D1 — `decisionChainDepth` is a **read-time derived metric**, not an emitted `MetricType`

Do **not** add it to `MetricType`, and do not route it through `metrics-collector → store → baseline-service → anomaly-detector`. Reasons, all measured:

1. The pipeline requires a producer. There is none (§3.3).
2. The baseline gate requires **≥ 10 points per agent per 7-day window** (`baseline-service.js:15`, `MIN_DATA_POINTS = 10`) before a baseline exists; `anomaly-detector.js:55` returns `null` without one. A metric whose non-zero arm has no producer has no baseline, and a metric with no baseline has no anomaly detector.
3. Chain depth is **structural**, not per-agent behavioural. The baseline machinery is keyed on `agentId` (`baseline-service.js:26`, `computeBaseline(agentId)`); depth belongs to the chain, not to an agent. Putting it in the agent-scoped store would create a baseline whose population is the wrong one — the same defect class as a trend gate that counts a population it was not derived from.

### D2 — Definition

For a decision record `d` in the chain:

```
depth(d) = |ancestors(d)|  along parentDecisionId,  0 for a root
depth(d) = undefined      if any ancestor id is absent from the chain
```

Computed by **one forward pass** over the JSONL, maintaining `id → depth`:

- `parent` precedes `child` in append order (an annotation's parent is the source event, logged earlier), so a single pass suffices and no recursion is needed.
- If `parent(d)` is not in the map when `d` is reached → `depth(d) = undefined` and the record is counted as **dangling**. A dangling record must **not** be treated as a root: that would understate the chained share and hide a chain gap.

### D3 — Reporting shape — three numbers, never one

| Field | Definition |
|---|---|
| `chainedShare` | share of records with `depth > 0` |
| `depthP95`, `depthMax` | percentiles over the resolved (`depth != undefined`) set |
| `danglingCount` | records whose parent id is absent |

A bare mean is prohibited in the first cut. With today's population the mean is `0.0` — a number that reads like a measurement and is really an artefact of an empty arm. The share, the tail, and the dangling count are each interpretable when the arm is empty; the mean is not.

### D4 — First cut is a script, not a service

`scripts/chain-depth-census.js` in the AWARE repo: read-only over the chain file, emits a JSON report to stdout. **No** new endpoint, **no** new service, **no** new volume, **no** schema change, **no** baseline. The script is the consumer named on the card; nothing else is required for the metric to exist.

## 5. Enabling the population (the actual blocker — separate work)

The metric's value is bounded by the population, and the population is empty because of §3.1. Options, costed:

| Option | Change | Cost | Verdict |
|---|---|---|---|
| (a) Make the gateway's audit mount `rw=true` | one compose line | trivial | **Rejected** — deletes a deliberate containment control (a compromised gateway could rewrite the audit trail). Violates the ADR-047/ADR-050 threat model. |
| (b) Move the compliance mappers into the coordinator image | coordinator image gains `compliance/` | build + image change | Viable; keeps a single writer, but the coordinator then gains a large surface it currently does not carry. |
| (c) Route annotation writes to the coordinator's existing audit-log endpoint over HTTP | mappers POST instead of writing the file | mapper-level change + auth on the internal path | **Preferred** for the full annotation population — the coordinator is already the chain's sole writer; `POST /api/audit/log` already exists (`src/api/routes/audit.js:21`, `src/coordinator/http-server.js:714` `handleAuditLog`). The gateway keeps its read-only mount; the annotation becomes an authenticated write request to the writer. |
| (d) Chain MCP traffic natively in the coordinator | **(d1)** give `observeMcpMessage` a production caller, and **(d2)** supply a parent id to the adapter it constructs | **two** changes, **no** mount change, **no** image change | **Cheapest first step** — per §3.1 the adapter already sits inside the writable coordinator image and already writes through the coordinator's own decision-logger. But the adapter is not constructed in production today: the sole `src/` construction site (`src/coordinator/index.js:372`) sits inside `observeMcpMessage`, which itself has no caller in `src/` (§3.1). A parent id plumbed to that site would therefore reach code that never executes. (d) needs both halves or neither: (d1) an MCP path that actually calls the shell, and (d2) a parent id reaching the constructed adapter. Narrower than (c) (it does not populate the ATLAS/AST10 annotation arm), but it is the only option that needs **no** change to the audit write boundary, so it needs no security review of that boundary. |

The metric cannot be specified into existence; it must be *populated* first. That is why D1–D4 are a read-time metric and not a producer. If the population must be non-empty, **(d) then (c)** is the recommended order: (d) is two changes — an MCP path that actually calls `observeMcpMessage`, plus a parent id reaching the adapter it constructs — and touches no control; (c) is the durable fix for the annotation arm but changes the audit write boundary and therefore carries the security review.

## 6. Failure modes

1. **Chain growth.** 184,918,147 B / 321,587 records at the 2026-11-12T08:30Z measurement (§2); `AWARE_AUDIT_RETENTION_DAYS=2555` (≈7 years). A full-file census is O(n) per run. At the current size that is seconds; at retention scale it is multi-GB per run. Mitigation: the census persists `id → depth` so subsequent runs are incremental, or it runs over a bounded trailing window. *Detection:* census wall-clock and records-read counters reported in the JSON output.
2. **Torn writes.** The chain file contains **5 malformed lines** (`malformedLines: 5` in the census, stable across repeated runs). The gateway's decision-logger reports `skipped 5 malformed line(s)` **once per read** of the file — measured on `aware-2-gateway`: **89 warning events over the container's 43.3 h log span** (2026-11-10T18:26Z → 2026-11-12T13:42Z), of which **66 fall in the trailing 24 h window**; every warning carries the same count of 5, because it is the same 5 torn lines being re-read. *A ratio of warning events to log lines is not a damage measure* — it moves with log verbosity, not with corruption; an earlier draft of this record carried such a ratio ("57 of 104 log lines in 24 h") and it is withdrawn. The durable facts are the **5 malformed lines** and the fact that the damage does **not** grow: every one of the 89 warnings — across all 6 gateway boots in that span — carries the same count of 5, so no new torn writes occurred in 43.3 h. A census that silently skips unparseable lines **under-reports the population** and therefore under-reports the chained share. Mitigation: the census counts and reports `malformedLines` explicitly; skipping is never silent. *Detection:* `malformedLines` in the report; a non-zero value is expected and must be published, not swallowed. A **rising** `malformedLines` is the signal — a flat 5 with a growing `records` is benign.
3. **Dangling parents.** Retention pruning, gaps, or a torn write can orphan children. A dangling child counted as a root turns a chain gap into a depth of 0. Mitigation: D2's `undefined` + `danglingCount`. *Detection:* `danglingCount > 0` is a chain-health signal in its own right and is reported separately from depth statistics.
4. **The census mutates its own inputs.** A census that writes into the audit volume (or into the metrics store it is measuring) is a probe that changes what it observes. Mitigation: read-only opens; the report is written to stdout only. *Detection:* the census asserts it never opens the chain file for writing.

## 7. Reversibility

Delete `scripts/chain-depth-census.js` **and** `test/unit/scripts/chain-depth-census.test.js` (321 lines), and remove the census's `COPY` line(s) from `Dockerfile.coordinator` — one line at this commit (`COPY scripts/chain-depth-census.js ./scripts/chain-depth-census.js`, build stage), two once `0c4eed67` (branch `fix/adr-080-census-in-runtime-image-t_28717dec`) lands, which adds the runtime-stage `COPY --from=build ... /build/scripts/chain-depth-census.js`. Leaving the test file behind does not fail cleanly: ablation at `c09bbddd` (script deleted, test kept) gives `ℹ tests 10 / ℹ pass 0 / ℹ fail 10`.

Nothing else in AWARE changes: no schema, no config, no volume, no endpoint. The census is a pure function of the chain file, so it can be re-derived at any time from a chain file that still exists.

**This PR does change the coordinator image.** The `COPY` bakes the census into the coordinator image, so removing it requires rebuilding that image — the same deploy-shaped action that needed operator sign-off on card `t_28717dec`. The honest reversibility statement is therefore: **no image rebuild is needed to *add* the census to the running system** (the census reads a volume path and needs no image at all), **but one IS needed to remove it**.

## 8. Sequencing

1. Land `scripts/chain-depth-census.js` (coder) — emits the §4 D3 report; publishes `records`, `chainedShare`, `depthP95`, `depthMax`, `danglingCount`, `malformedLines`.
2. Run it against the live volume; publish today's numbers as the population baseline: `chainedShare = 0.0` over 321,587 records, `danglingCount = 0`, `malformedLines = 5` — measured 2026-11-12T08:30Z against a 184,918,147 B chain file. The chain file grows continuously, so a baseline is only meaningful **with its measurement timestamp and file size attached**; the record count alone does not identify which snapshot it denotes.
3. Decide and implement the writer-side enabling — option (d) first, then option (c) — as separate work. Option (d) is two changes, not one: a production caller for `observeMcpMessage` and a parent id supplied to the adapter it constructs (§5). Option (c) carries the security review it deserves, because it changes the audit write boundary; option (d) does not.
4. Re-run the census after the first chained records exist; the share moves off 0.00 % only then.

The census's own numbers are **a population baseline, not a proof of emptiness**. `chainedShare = 0.0` over 321,587 records says the *arm does not exist yet*; it is the expected reading of a system where §3.1's conditions hold, and it is falsified the moment the first chained record lands. A later cycle that reads `chainedShare = 0.0` must re-check §3.1 before concluding the metric is broken — the more likely explanation is that the enabling work has not landed yet.

## 9. Open items / not verified here

- **Not verified:** that the gateway can reach the coordinator's `POST /api/audit/log` in the deployed compose network, and what auth that internal path carries. Option (c)'s cost in §5 assumes a reachable, authenticated path; that must be checked before (c) is committed to.
- **Not verified:** that the `ATLAS`/`AST10` catalogues would produce annotations on the live traffic mix. Enabling the path may still yield a very small chained population, and the census will say so — that is a finding, not a defect of the metric.
- **Not verified:** that the MCP adapter's *emit path* has a production caller. `src/coordinator/adapters/mcp.js:410` sets `parentDecisionId: this.parentDecisionId`, but no parent is ever supplied (`mcp.js:285` defaults it to `null`; the only `src/` construction site `src/coordinator/index.js:372` passes no options) and `observeMcpMessage` (`index.js:369`) has no caller outside `test/`. The full reasoning is in §3.1. This is the cheapest known route to a non-empty population — it needs two changes (a production caller for `observeMcpMessage`, and a parent id supplied to the adapter it constructs), not a mount or image change.
- **Out of scope here:** the RLT framing this metric was derived from. This record deliberately carries no RLT claim.

## 9.1 Re-verification on the reconciled lineage

**Measured 2026-11-12.** The local `main` lineage and `origin/main` were reconciled (the local `main` 10-commit merge). This section records what the reconciliation changed in this record and what it did not.

**The citation audit.** This record cites 23 source locations. The reconciliation shifts 2 of them, because the local `main` lineage adds 20 lines to `src/coordinator/http-server.js`:

| Citation | Before | After | Cited content |
|---|---|---|---|
| `src/coordinator/http-server.js` | line 694 | line 714 | `async function handleAuditLog(req, res, requestId) {` |
| `src/coordinator/http-server.js` | line 925 | line 945 | `parentDecisionId: null,  // root of a chain per request; ...` |

The other 21 citations resolve to identical content after the reconciliation. Each cited line was compared by content, not by line number, and the 2 shifted citations were re-pointed to the lines that now hold the cited content. The table above names the two sites by file and line WITHOUT the `file:line` form, so that the only `file:line` tokens in this record are the live citations.

**§3.1 still holds.** The reconciliation adds `src/disclosure` to the repository, and it adds `src/config/rlm.cjs`. The coordinator image copies `src/coordinator`, `src/config`, `src/db`, `src/budget`, `src/trainer`, `src/audit` and `src/policies` only. The coordinator image therefore still carries no `compliance` module and no `monitoring` module, and the directory set that §3.1 names is unchanged.

**The measurement is unchanged.** The census reads the volume path `/data/audit/decision-chain.jsonl`, not repository-relative source. The reconciliation changes no file that the census reads, so the §2 measurement stands.

**The ADR number pair is legal on the reconciled lineage.** The reconciliation brings `ADR-079-aware-disclosure-record-generator.md` (the disclosure record generator) and this record (`ADR-080`) onto the same branch. The two numbers are distinct. The `scripts/pre-commit-check.sh` filename-uniqueness rule requires each `ADR-NNN` prefix to be unique; `079` and `080` are each unique. The gate exits 0 on the reconciled tree, and it still fails when a second file claims `079`, so the pass is a live pass and not a disabled check.

**What the reconciliation does change.** The reconciled `Dockerfile.coordinator` copies `config/rlm.yaml`, `config/rlm.schema.json` and `src/config/rlm.cjs` into the coordinator image. The running coordinator image does not carry these files today. A rebuild is therefore required for the reconciled lineage, and the rebuild must happen before the RLM configuration takes effect.
