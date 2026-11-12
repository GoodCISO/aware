# ADR-080 — `decisionChainDepth` is a read-time derived metric over the audit chain, not an emitted `MetricType`

**Status:** Accepted (design) · **Date:** 2026-11-12
**Author:** Archimedes (architect)
**Reviewers:** reviewer (sign-off card `t_…` — filed with this commit)
**Task:** `t_49fe6a7e` (design card; filed by scribe from the RLT spike verdict `t_47925aa7`)
**Sibling card:** `t_7101e614` (RLT defer-watch registration) — a watchlist, independent of this record
**Renumbered from:** ADR-079 — the original number was taken by `ADR-079-aware-disclosure-record-generator.md` (Forge, coder, 2026-11-11). Number never reused; the record keeps its content and gains the next free number.
**Related:** `src/audit/decision-logger.js` (chain reader/writer) · `src/monitoring/metrics-collector.js` (metric-type enum) · `src/monitoring/baseline-service.js` (baseline gate) · `src/monitoring/anomaly-detector.js` (consumer) · `src/compliance/atlas-mapper.js`, `src/compliance/ast10-mapper.js`, `src/compliance/llm09-mapper.js`, `src/compliance/mcp-top10-classifier.js` (the only non-null-parent producers) · `src/policies/tool-observation-proxy.js` (the annotation gate)
**Predecessor:** none — this is the first decision on audit-chain depth as an analytics quantity
**Verified against:** AWARE `origin/main` @ `a78bd3d8`

---

## 1. Context

The card asks for one new metric:

> **`decisionChainDepth`** — the number of ancestor hops from a decision record to its chain root, measured along `parentDecisionId`.

The card's own premise (§2, reason 2) claimed *there is no chain to measure depth along*, citing `src/coordinator/http-server.js:925`. That premise was corrected on 2026-11-12 (09:11 card comment): the citation is real, the inference was not — the chain exists in the audit log, `src/audit/decision-logger.js:496` walks it root-first, and several producers set a non-null `parentDecisionId`.

**This record corrects that correction.** The correction established that a *producer exists in source*. It did not establish that the *population exists in production*. Measured live on 2026-11-12, the population does not exist.

## 2. Measurement — the population is EMPTY, not bimodal

Measured inside the running coordinator container (`aware-2-coordinator`), against the live chain file:

| Quantity | Value |
|---|---|
| Chain file | `/data/audit/decision-chain.jsonl` (volume `aware-2-audit-data`) |
| Size / records | 184,918,147 B · **321,587** parseable records |
| File mtime | 2026-11-12T08:30Z |
| Records with `parentDecisionId != null` | **0** |
| Records with a dangling parent | 0 (vacuous — no record has a parent) |
| Depth histogram | `{0: 321,587}` — every record is a root |
| `action.type` distribution | `coordinate` 321,586 · `probe` 1 |

The 09:11 comment predicted a **bimodal** population (0 for coordinator-sourced decisions, >0 for atlas/mcp-sourced ones). The measurement shows a **degenerate** population: the >0 arm does not exist at all. 0.00 % of 321,587 live records are chained.

## 3. Why the population is empty — three deployment facts, each measured

**3.1 The only chained producers are deployed on a read-only audit mount.**

The non-null-parent producers are the four compliance mappers (`atlas-mapper.js:728`, `ast10-mapper.js:651`, `llm09-mapper.js:130/163/266/326/379`, `mcp-top10-classifier.js:558`). The compliance modules exist only in the **gateway** image (`aware-2-gateway`), which mounts the audit volume **`rw=false`**:

```
aware-2-gateway     -> aware-2-audit-data -> /data/audit rw=false
aware-2-coordinator -> aware-2-audit-data -> /data/audit rw=true
```

The **coordinator** — the only service with a writable audit mount, and the writer of all 321,587 records — has **no compliance or monitoring modules at all**: `/app/src` contains `audit, budget, config, coordinator, db, policies, trainer`. So the service that *can* write the chain cannot produce a chained record, and the service that *can* produce a chained record cannot write the chain. The read-only gateway mount is a deliberate containment control (`docker-compose.coordinator.yml:156-160`: *"a compromised gateway can't tamper with the chain"*), not an oversight.

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
| (c) Route annotation writes to the coordinator's existing audit-log endpoint over HTTP | mappers POST instead of writing the file | mapper-level change + auth on the internal path | **Preferred** — the coordinator is already the chain's sole writer; `POST /api/audit/log` already exists (`src/api/routes/audit.js:21`, `src/coordinator/http-server.js:694` `handleAuditLog`). The gateway keeps its read-only mount; the annotation becomes an authenticated write request to the writer. |

The metric cannot be specified into existence; it must be *populated* first. That is why D1–D4 are a read-time metric and not a producer.

## 6. Failure modes

1. **Chain growth.** 184 MB / 321,587 records today; `AWARE_AUDIT_RETENTION_DAYS=2555` (≈7 years). A full-file census is O(n) per run. At the current size that is seconds; at retention scale it is multi-GB per run. Mitigation: the census persists `id → depth` so subsequent runs are incremental, or it runs over a bounded trailing window. *Detection:* census wall-clock and records-read counters reported in the JSON output.
2. **Torn writes.** The gateway's decision-logger reports `skipped 5 malformed line(s)` on **57 of 104 log lines in 24 h** (measured on `aware-2-gateway`, 2026-11-12). A census that silently skips unparseable lines **under-reports the population** and therefore under-reports the chained share. Mitigation: the census counts and reports `malformedLines` explicitly; skipping is never silent. *Detection:* `malformedLines` in the report; a non-zero value is expected and must be published, not swallowed.
3. **Dangling parents.** Retention pruning, gaps, or a torn write can orphan children. A dangling child counted as a root turns a chain gap into a depth of 0. Mitigation: D2's `undefined` + `danglingCount`. *Detection:* `danglingCount > 0` is a chain-health signal in its own right and is reported separately from depth statistics.
4. **The census mutates its own inputs.** A census that writes into the audit volume (or into the metrics store it is measuring) is a probe that changes what it observes. Mitigation: read-only opens; the report is written to stdout only. *Detection:* the census asserts it never opens the chain file for writing.

## 7. Reversibility

Delete `scripts/chain-depth-census.js` and remove its one `COPY` line from `Dockerfile.coordinator`. Nothing else in AWARE changes: no schema, no config, no volume, no endpoint, no image. The census is a pure function of the chain file, so it can be re-derived at any time from a chain file that still exists.

## 8. Sequencing

1. Land `scripts/chain-depth-census.js` (coder) — emits the §4 D3 report; publishes `records`, `chainedShare`, `depthP95`, `depthMax`, `danglingCount`, `malformedLines`.
2. Run it against the live volume; publish today's numbers as the population baseline: `chainedShare = 0.0` over 321,587 records, `danglingCount = 0`, `malformedLines = 5`.
3. Decide and implement the writer-side enabling — option (c), §5 — as separate work, with the security review it deserves (it changes the audit write boundary).
4. Re-run the census after the first chained records exist; the share moves off 0.00 % only then.

## 9. Open items / not verified here

- **Not verified:** that the gateway can reach the coordinator's `POST /api/audit/log` in the deployed compose network, and what auth that internal path carries. Option (c)'s cost in §5 assumes a reachable, authenticated path; that must be checked before (c) is committed to.
- **Not verified:** that the `ATLAS`/`AST10` catalogues would produce annotations on the live traffic mix. Enabling the path may still yield a very small chained population, and the census will say so — that is a finding, not a defect of the metric.
- **Not verified:** that the MCP adapter ever chains. `src/coordinator/adapters/mcp.js:410` sets `parentDecisionId: this.parentDecisionId`, but the only construction site (`src/coordinator/index.js:372`, `new mod.MCPAdapter()`) passes no options, so the field is always `null`. It is listed in §3.1 as a *capable* producer, not an active one.
- **Out of scope here:** the RLT framing this metric was derived from. This record deliberately carries no RLT claim.
