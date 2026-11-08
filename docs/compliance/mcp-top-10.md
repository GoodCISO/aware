# OWASP Top 10 for Model Context Protocol (2025) — AWARE Coverage

**Last updated:** 2026-07-22
**Source spec:** OWASP MCP Top 10 (2025), 10 risks (MCP01–MCP10), pinned commit
`1b369f3270be0fc09f8d406537ec9a2195ca2e6a` (2026-07-19 fetch).
**Spec URL:** https://github.com/OWASP/www-project-mcp-top-10
**Threat-model ADR:** `docs/adr/ADR-051-aware-mcp-top-10-2025-coverage.md`
**Framework entry:** `OWASP_MCP_TOP_10` in `src/compliance/framework-mapper.js`
(control block + 9 component mappings per ADR-051 §2.2)

## Why this document exists

This document is the human-readable expansion of the per-risk coverage table
in ADR-051 §6. The framework-mapper registers `OWASP_MCP_TOP_10` as AWARE's
protocol-layer threat model — alongside CSA AICM, NIST AI RMF, ISO 27001,
DORA, OWASP LLM Top 10, and OWASP AST10 — but the catalog + per-component
mapping is the only thing the framework-mapper holds in-tree. The per-risk
classification rules (the file that produces annotations when a tool call
hits an MCP surface) live in `src/compliance/mcp-top10-classifier.js` and
land in a separate kanban card.

This document records:

1. AWARE component → MCP control coverage (the cross-walk table).
2. The 9 component mappings per ADR-051 §2.2 (and the rationale for each).
3. The `pheromone-specialists` exclusion (heuristic-only per ADR-043 §1;
   no `OWASP_MCP_TOP_10` row by design).
4. The follow-up cards that close the gap between "framework entry wired"
   and "active annotations."

## Coverage summary

| Metric | Value |
|---|---|
| 2025 risks | 10 |
| AWARE risks with framework enumeration | 10 — all 10 controls (MCP01..MCP10) listed in `getFrameworkControls('OWASP_MCP_TOP_10')` |
| AWARE components mapped to MCP Top 10 | 9 — sandbox-policies, identity-provider, anomaly-detection, tool-access-control, compliance-mapping, tool-observation-proxy, permission-model, shadow-detector, credential-classifier |
| AWARE components intentionally absent | 1 — `pheromone-specialists` (heuristic-only; consistent with the AST10 mapping exclusion documented in ADR-043 §1) |
| Classifier-side annotations | deferred — see `src/compliance/mcp-top10-classifier.js` (separate kanban card) |
| `mcp-coordinator-adapter` mapping | deferred — adapter does not exist yet; its own kanban card adds the mapping when it lands |

**Headline:** The framework entry is now wired. The catalog file is
`src/compliance/mcp-top10-catalog.js` (frozen, first-party characterizations
per AGENTS.md §2). The 9 component mappings land in `framework-mapper.js`'s
`AWARE_COMPONENT_MAPPINGS`. What is NOT yet wired is the classification
rules that turn an MCP source event into an `OWASP_MCP_TOP_10` annotation —
that is a separate card and a separate reviewer lane.

## AWARE component → MCP Top 10 cross-walk

This is the cross-walk table from ADR-051 §2.2, expanded with the AWARE
source files each mapping corresponds to. The IDs are the upstream MCP Top 10
(2025) IDs (`MCP01`..`MCP10`).

| AWARE component | MCP IDs | Source file(s) | ADR-051 rationale |
|---|---|---|---|
| `sandbox-policies` | `MCP05` | `src/policies/sandbox-decision-emitter.js` | sandbox denies `shell=True` / `eval` / `exec`; runtime defence for command injection regardless of MCP origin |
| `identity-provider` | `MCP01`, `MCP04`, `MCP07` | `src/identity-provider/*` | signing-key machinery is shape-compatible with MCP-server signing (JWS / COSE); publisher-key surface covers token/secret exposure, supply-chain, and mTLS |
| `anomaly-detection` | `MCP03`, `MCP06` | `src/policies/anomaly-detection/*` | fires on tool/schema poisoning attempts and intent-flow subversion once the new MCP adapter emits `mcp_message` source events |
| `tool-access-control` | `MCP02`, `MCP03`, `MCP05`, `MCP07` | `src/policies/tool-access-control.js` | central runtime gate for the MCP-protocol surface — scope creep, schema poisoning, parameter validation, per-call authorization |
| `compliance-mapping` | `MCP08`, `MCP09` | `src/compliance/framework-mapper.js` | compliance-report output is part of the audit evidence chain; the report answers "which MCP servers are we compliant against?" |
| `tool-observation-proxy` | `MCP03`, `MCP06`, `MCP08`, `MCP10` | `src/policies/tool-observation-proxy.js` | observes every tool call regardless of MCP origin; covers schema/description poisoning, intent-flow subversion, audit/telemetry, cross-session context |
| `permission-model` | `MCP02`, `MCP07` | `src/policies/permission-model.js` | deny-by-default per-request RBAC; static enforcement for scope creep; per-call authorization |
| `shadow-detector` | `MCP09` | `src/policies/shadow-detector.js` | flags unregistered tool calls after 3 in a 5-min window; partial mitigation; protocol-level MCP-server-instance allowlist is a follow-up |
| `credential-classifier` | `MCP01` | `src/policies/credential-classifier.js` | scans every tool-output payload for known credential patterns (APTS-MR-019); the only MCP01 surface wired today |
| `pheromone-specialists` | — | — | Heuristic-only per ADR-043 §1; no `OWASP_MCP_TOP_10` row, consistent with the AST10 mapping exclusion |

## Per-control catalog cross-walk

MCP ID, risk class, and severity exactly as pinned in
`src/compliance/mcp-top10-catalog.js` (source of truth per ADR-051). Severities are
the upstream MCP Top 10 (2025) risk-class strings; the per-control narratives below
are the AWARE coverage notes.

| MCP ID | Risk class | Severity |
|---|---|---|
| `MCP01` | Token Mismanagement & Secret Exposure | Critical |
| `MCP02` | Tool / Function Misuse | High |
| `MCP03` | Excessive Agency & Privilege | High |
| `MCP04` | Indirect Prompt Injection | Critical |
| `MCP05` | Command Injection & Execution | High |
| `MCP06` | Context Window & Memory Poisoning | High |
| `MCP07` | Supply Chain (Servers / Plugins) | High |
| `MCP08` | Authentication & Identity | High |
| `MCP09` | Shadow MCP Servers | Medium |
| `MCP10` | Untrusted / Cross-Session Context | Medium |

## Per-risk coverage notes

The 10 MCP risk classes, with the AWARE component(s) that cover each. The
coverage tiers are: **H** (direct fit, same surface), **M** (partial,
sub-feature of a broader coverage), **L** (observation only, no active
intervention).

### MCP01 — Token Mismanagement & Secret Exposure

**Coverage: M — tool-output layer only.** `credential-classifier` scans
every tool-output payload for known credential patterns; this is the only
MCP01 surface wired. Env-var / MCP-config / prompt-template secret coverage
requires the new MCP adapter and is deferred.

### MCP02 — Tool / Function Misuse

**Coverage: M — static enforcement only.** `permission-model` enforces
deny-by-default per-request RBAC (static); `tool-access-control` enforces
per-call authorization. Drift detection (catching a tool that grew scope at
runtime) is deferred to AWARE 2.2.

### MCP03 — Excessive Agency & Privilege

**Coverage: H.** `tool-access-control` is the central runtime gate for
over-privilege. `anomaly-detection` (LLM-side) and `tool-observation-proxy`
(MCP-side) flag scope escalation attempts. The AST10 over-privilege-write
rule (sensitive target → AST03 H) is fed from the same pipeline.

### MCP04 — Indirect Prompt Injection

**Coverage: M.** `identity-provider` publisher-key surface reduces the
untrusted-instruction-fetch surface; `tool-access-control` enforces
`input_allowlist` (per the AST10 `untrusted-instruction-fetch` rule documented
in ADR-043 §"Classification rules"). Direct MCP04 classification rules are
deferred to the classifier card.

### MCP05 — Command Injection & Execution

**Coverage: H.** `sandbox-policies` denies `shell=True` / `eval` / `exec`
on the parameter path; `tool-access-control` validates parameter values
against the declared schema. This is the runtime defence regardless of
whether the call originated from an MCP-derived tool call.

### MCP06 — Context Window & Memory Poisoning

**Coverage: L — observation only.** `anomaly-detection` and
`tool-observation-proxy` observe MCP resources/read and sampling traffic
once the new MCP adapter starts emitting `mcp_message` source events.
Active intervention (blocking a poisoned read) is deferred.

### MCP07 — Supply Chain (Servers / Plugins)

**Coverage: M.** `identity-provider` signing-key machinery covers
publisher-key verification (MCP-server signing, JWS / COSE); `tool-access-control`
provides per-call authorization. Content-hash pinning for plugins is a
follow-up (architect spike, out of scope for this card).

### MCP08 — Authentication & Identity

**Coverage: L (via audit chain).** `compliance-mapping` surfaces the audit/
telemetry output; `tool-observation-proxy` participates in the audit chain.
mTLS / audience-binding for MCP session establishment is a follow-up.

### MCP09 — Shadow MCP Servers

**Coverage: M — tool-level only.** `shadow-detector` flags unregistered
tool calls after 3 in a 5-min window. `compliance-mapping` answers "which
MCP servers are we compliant against?" Protocol-level allowlist is a
follow-up.

### MCP10 — Untrusted / Cross-Session Context

**Coverage: L — observation only.** `tool-observation-proxy` observes
every tool call and writes to the audit chain; cross-session context
trust boundaries are a follow-up (architect decision required).

## How to verify

```bash
# 1. Catalog file exists and exports the named constants
node -e "const c = require('./src/compliance/mcp-top10-catalog'); console.log(c.MCP_TOP_10_CONTROL_IDS.length);"
# → 10

# 2. Framework registration
node -e "const fm = require('./src/compliance/framework-mapper'); console.log(Object.keys(fm.FRAMEWORKS));"
# → [ 'CSA_AI_CM', 'NIST_AI_RMF', 'ISO_27001', 'DORA', 'OWASP_LLM_TOP_10', 'OWASP_AST10', 'OWASP_MCP_TOP_10' ]

# 3. Component → control round-trip
node -e "const fm = require('./src/compliance/framework-mapper').getFrameworkMapper(); console.log(fm.componentCoversControl('credential-classifier', 'OWASP_MCP_TOP_10', 'MCP01'));"
# → true

# 4. pheromone-specialists has no OWASP_MCP_TOP_10 row
node -e "const m = require('./src/compliance/framework-mapper').AWARE_COMPONENT_MAPPINGS['pheromone-specialists']; console.log(Object.prototype.hasOwnProperty.call(m, 'OWASP_MCP_TOP_10'));"
# → false

# 5. Run the dedicated test suite
node --test test/unit/compliance/framework-mapper-mcp-top10.test.js
# → 16/16 pass
```

## Drift detection

The regeneration script at `scripts/regenerate-mcp-top10-catalog.js` fetches
the 10 per-class .md files from the upstream pinned SHA, paraphrases
according to AGENTS.md §2 (first-party characterization, not verbatim
upstream prose), and rewrites the catalog file. The script accepts
`--dry-run` for CI use as a drift detector:

```bash
node scripts/regenerate-mcp-top10-catalog.js --dry-run
# exit 0 if catalog file matches upstream
# exit 1 if drift detected (catalog file out of sync with upstream)
```

If the upstream project renumbers a class or bumps the version, the script
will surface the drift on the next CI run. The pinned SHA in the script
matches the pinned SHA in `mcp-top10-catalog.js` (single source of truth).
