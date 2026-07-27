# ADR-047 — AWARE Coverage of MITRE ATLAS v2026.06

**Status:** Proposed (2026-07-13)
**Author:** Archimedes (architect)
**Reviewers:** Coder, Critic, Sentinel (auditor)
**Supersedes:** nothing — this is a new compliance integration
**Related:** ADR-043 (AST10 mapper, `src/compliance/ast10-mapper.js`); ADR-040
(hook-based auto-interception); decision logger at `src/audit/decision-logger.js`;
tool observation proxy at `src/policies/tool-observation-proxy.js`;
compliance mapper at `src/compliance/framework-mapper.js`.
**Source:** https://github.com/mitre-atlas/atlas-data (releases `v2026.06` —
2026-06-30, verified in window; `v2026.05` — 2026-05-27).

## Context

**MITRE ATLAS** is the AI analog of ATT&CK: a public catalogue of adversary
tactics, techniques, and case studies for attacks against AI systems.
The June 2026 content release (`v2026.06`, tag `651dad9`, 2026-06-30)
added three new techniques and updated one existing technique; the
May 2026 release (`v2026.05`, tag `da9ebf9`, 2026-05-27) introduced
the **format v6.0.0 schema overhaul** and a content/format version
split. Both are in scope for this ADR.

AWARE's existing compliance posture covers four frameworks (CSA AICM v1,
NIST AI RMF 1.0, ISO 27001:2022, DORA) plus OWASP AST10 (added by ADR-043,
shipped 2026-07-13). The `framework-mapper.js` is the single source of
truth for what frameworks AWARE claims coverage against. AST10 is the
**behaviour-layer** catalogue (skills themselves); ATLAS is the
**technique-layer** catalogue (the things an adversary actually does).
Adding ATLAS gives AWARE a third axis alongside AST10 and the LLM Top 10
(LLM01–LLM10): AI-attack-specific technique IDs (e.g. `AML.T0051`
LLM Prompt Injection) rather than risk classes or LLM-app risk categories.

This is the **first MITRE ATLAS candidate** the aware-frameworks daily
cron has surfaced — Source I was added to the scanning roster in the
2026-07-13 v1.2.0 supplemental (see parent task `t_05dfa86e`). The
v2026.06 release is the first time the AWARE repo needs to declare a
position on ATLAS coverage.

### What the source body got wrong

The cron-sourced task body (`t_c30bc1f6`) references `src/guard/classifier.js`
and a "SR²AM guard classifier" that does not exist in this tree:
`src/guard/` is not a directory; the only `classif*` files in
`node_modules/` are upstream library helpers; the search for `SR²AM` /
`SR2AM` returned zero hits. The actual guard/policy surface lives in
`src/policies/` (parameter-validator, permission-model, shadow-detector,
tool-observation-proxy, tool-catalog) and the compliance surface lives in
`src/compliance/` (framework-mapper, ast10-mapper, ast10-catalog, etc.).
This ADR targets the real surface; the task body's path is treated as a
non-authoritative suggestion.

The task body also says "v2026.05 (v6.0.0) added new techniques". This is
**factually wrong** per the upstream CHANGELOG.md (`v2026.05` only added
the `platforms` field to every existing technique and shipped the v6.0.0
format overhaul). The new *technique* content ships in `v2026.06`. The
v2026.05 work is a **schema change**, not a content change — and schema
changes are still in scope, but they affect how AWARE parses the
catalogue, not which technique IDs to support.

## Decision

**Add MITRE ATLAS as a sixth supported framework in
`src/compliance/framework-mapper.js`, ship a dedicated
`src/compliance/atlas-catalog.js` (versioned snapshot of techniques +
mitigations + case studies relevant to AWARE's threat model) and
`src/compliance/atlas-mapper.js` (post-observation annotator that tags
audit events with matched ATLAS technique IDs), mirroring the AST10
mapper shape from ADR-043.** No changes to `src/policies/` modules in
this ADR — they consume compliance annotations via `decision-logger.js`,
not by growing their own ad-hoc ATLAS table.

This is the same architectural shape as the AST10 integration (one
catalog file + one mapper file + one `framework-mapper` block) and
that's deliberate. AST10 and ATLAS are different *taxonomies* (risk
class vs technique), but the *integration surface* — post-observation
annotator on top of `decision-logger` — is identical. The mapper here
emits annotations tagged with **technique IDs** (e.g.
`["AML.T0051.001"]`, `["AML.T0113", "AML.T0091.001"]`) rather than
risk-class names (`["AST03", "AST05"]`). The downstream
`/api/compliance/atlas` route reads these annotations the same way the
`/api/compliance/ast10` route will read AST10 annotations.

### Release-window delta (verified against upstream)

Verified by curl-fetching
`https://raw.githubusercontent.com/mitre-atlas/atlas-data/v2026.06/dist/v6/ATLAS-2026.06.yaml`
(15,916 lines, format-version 6.0.0) and the repo `CHANGELOG.md` at
the same tag.

**v2026.06 content delta:**

| Type | ID | Name | Maturity | Platforms | Notes |
|---|---|---|---|---|---|
| New technique | `AML.T0113` | Steal Web Session Cookie | Demonstrated | Enterprise | Maps to ATT&CK T1539 (Steal Web Session Cookie). Cited directly in the v2026.06 case study **AML.CS0061** ("AI in the Middle: Web-Based AI Services as C2 Relays"). |
| New technique (sub) | `AML.T0091.001` | Use Alternate Authentication Material: Web Session Cookie | Demonstrated | Predictive AI | Sub-technique of `AML.T0091`. Pairs with T0113: T0113 steals the cookie, T0091.001 uses it. |
| New technique | `AML.T0114` | AI Service Web Interface | Demonstrated | Enterprise | C2 relay through public AI assistant web UIs (no API key needed). |
| Updated technique | `AML.T0054` | LLM Jailbreak | Demonstrated | (all four platforms) | Adds explicit "Multi-turn escalation / Crescendo" strategy. Heavily revised in v2026.06. |
| Updated mitigation | `AML.M0020` | Generative AI Guardrails | — | — | Expanded scope to cover agent-action guardrails (not just input/output). |
| Updated mitigation | `AML.M0021` | Generative AI Guidelines | — | — | New sub-section on tool-call policy. |
| Updated mitigation | `AML.M0024` | AI Telemetry Logging | — | — | New required fields for C2-relay detection. |
| New case studies | `AML.CS0057` … `AML.CS0062` | Storm-2139 / Google Photos extraction / EchoLeak / Lenovo XSS / AI-in-the-Middle / Semantic Kernel RCE | — | — | Six new case studies; EchoLeak (`AML.CS0059`) is the M365 Copilot zero-click prompt-injection that motivated several v2026.06 changes. |

**v2026.05 content/format delta:**

| Type | Change | AWARE implication |
|---|---|---|
| Format | New YAML format v6.0.0 (canonical home: `dist/v6/ATLAS-YYYY.MM.yaml`; `dist/ATLAS.yaml` deprecated) | The `atlas-catalog.js` snapshotter must pin to `dist/v6/ATLAS-2026.06.yaml`, NOT `dist/ATLAS.yaml`. The deprecated file lags — verified that `dist/ATLAS.yaml` at the `v2026.06` tag contains only T0000–T0112 and is missing T0113/T0114. |
| Format | Schema now requires `platforms` field on every technique (enum: Predictive AI / Generative AI / Agentic AI / Enterprise) | The `ATLASCatalogEntry` shape in `atlas-catalog.js` must include `platforms: string[]`. AWARE's threat-model coverage claim can be filtered by platform — e.g. "for the Agentic AI platform, AWARE covers N of M techniques". |
| Format | Standardised top-level model: collection, matrix, keyed maps for tactics/techniques/mitigations/case-studies, centralised relationships map | `atlas-catalog.js` reads the keyed maps, not the legacy YAML list form. The mapper only needs techniques + sub-techniques + mitigations + case-study summaries; tactics are derivable from technique → tactic relationships. |
| Format | Relationship types are first-class: `sequences`, `achieves`, `specializes`, `mitigates`, `employs` | The mapper can optionally expose relationship edges in annotations — e.g. "event matched `AML.T0051.001` Indirect, which achieves tactic `AML.TA0003` Initial Access". Out of scope for v1; flagged in §"Follow-up". |
| Versioning | Content releases use `YYYY.MM.N`; format releases use SemVer; stored in `Collection.version` and `Collection.format-version` | AWARE release notes should reference both: "ships ATLAS catalogue at content v2026.06 / format v6.0.0". |
| Tooling | Pydantic schemas, SQLAlchemy ORM, FastAPI REST API | Out of scope for AWARE — AWARE consumes the YAML artifact, not the API. |
| Migration | Historical releases migrated into v6 structure (`dist/v6/ATLAS-YYYY.MM.yaml`); legacy tree at `dist/legacy/`; deprecated `dist/ATLAS.yaml` | Same implication as the format change — pin to `dist/v6/`. |

### 1:1 mapping — ATLAS technique → AWARE control (v2026.06 window)

Confidence levels: **H** = direct AWARE control blocks/captures the
technique at the observation layer; **M** = partial coverage that
addresses the technique but requires new mapping rules; **NEW** = no
existing AWARE control, propose a new one; **GAP** = technique is in
AWARE's threat model but no current control addresses it.

| ATLAS ID | Name | Existing AWARE control(s) | Conf. | Notes |
|---|---|---|---|---|
| `AML.T0051` | LLM Prompt Injection | `anomaly-detection` (CSA MDS-09); `behavioral-baseline` (LOG-03, MDS-05) | M | The "pattern" is the indirect / triggered sub-technique. AWARE's hook observes tool calls but doesn't currently parse prompt content for injection. AST10 rule `untrusted-instruction-fetch` (ADR-043) covers the *fetch* leg of T0051.001 Indirect, but not T0051.000 Direct (user-typed prompt) or T0051.002 Triggered. NEW: a content-layer prompt-classifier rule in `atlas-mapper.js`. |
| `AML.T0051.000` | Direct | (none — hook never sees prompts) | GAP | Out of scope for AWARE — AWARE intercepts tool calls, not LLM prompts. The hook lives below the model surface; Direct prompt injection is a *model-platform* concern, not a *tool-call* concern. Document as a known gap; coverage claim is "AWARE catches the downstream effects via AST05 / AML.T0053". |
| `AML.T0051.001` | Indirect | `untrusted-instruction-fetch` (AST10 AST05, H) | H | Direct fit. The AST10 rule fires when a `web_fetch` tool call pulls content from an off-allowlist host; that content is the Indirect injection vector. The new ATLAS annotation can be emitted alongside the AST10 annotation on the same event. |
| `AML.T0051.002` | Triggered | (none — event-driven, not request-driven) | GAP | Out of scope for v1. Triggered injection is a UI/UX concern (clickable links, embedded media) that AWARE doesn't observe. Document as a known gap. |
| `AML.T0054` | LLM Jailbreak | `behavioral-baseline` (LOG-03, MDS-05) | M | AWARE can detect the *downstream* effects of a successful jailbreak — model starts calling tools it never used before, calls to unfamiliar domains, parameter shapes that drift. The v2026.06 Crescendo addition is a multi-turn escalation: the first prompt is benign; the model gradually shifts. `behavioral-baseline` catches the cumulative drift but not the individual turns. NEW: a multi-turn anomaly detector in `atlas-mapper.js` (rule: `multi-turn-baseline-drift`, M). |
| `AML.T0053` | AI Agent Tool Invocation | `tool-access-control` (CSA IAM-08, AIS-07); `permission-model.js` (RBAC) | H | Direct fit. The existing `tool-access-control` denies tool calls that exceed the agent's role. The ATLAS annotation tags the event with `AML.T0053` so the compliance report shows "for ATLAS T0053, AWARE blocked N calls / allowed M calls in the period". |
| `AML.T0113` | Steal Web Session Cookie | `parameter-validator.js` (denies string-shaped `Cookie`/`Set-Cookie` parameters in non-network tools) | M | AWARE can flag tool calls that try to *exfiltrate* a cookie value (parameter named `cookie`, `session_id`, `auth_token` in tools that aren't network-bound). The actual cookie *theft* (browser memory scrape, XSS rendering) is outside AWARE's scope. NEW rule in `atlas-mapper.js`: `exfil-cookie-parameter`, M. |
| `AML.T0091.001` | Web Session Cookie | (same surface as T0113) | M | The "use" side of the cookie theft. AWARE can flag tool calls that present a `Cookie` header to a non-allowlisted host or to a host whose origin doesn't match the agent's session. NEW rule: `cookie-replay-attempt`, M. |
| `AML.T0114` | AI Service Web Interface (C2 relay) | `anomaly-detection` (MDS-09); `behavioral-baseline` (LOG-03) | M | The technique is "tool opened a browser to a public AI assistant and pasted attacker content". AWARE observes tool calls, not browser actions. The detection signature is the *parameter* of the resulting tool call: a request to a public AI host (`chat.openai.com`, `gemini.google.com`, `claude.ai`) from an agent that normally only talks to internal services. NEW rule: `web-ai-c2-relay`, M. |
| `AML.T0108` | AI Agent (C2 channel) | `tool-access-control` (CSA IAM-08); `kill-switch` (SEF-03) | H | Direct fit. AWARE's tool catalog lists known-bad destinations; the kill-switch can sever a session that's been observed exfiltrating via an agent channel. |
| `AML.M0020` | Generative AI Guardrails | (informational — drives the rule table) | n/a | Updated in v2026.06 to cover agent-action guardrails. AWARE's existing guardrail coverage (input moderation via parameter-validator; tool-action moderation via permission-model; output moderation via behavioural-baseline) is the empirical realisation of M0020. The annotation chain should record "rule fired because mitigation M0020 applies here". |
| `AML.M0021` | Generative AI Guidelines | (informational) | n/a | Policy doc; drives AWARE's `policies/` configuration. AWARE already loads policies from `src/policies/*.js`; M0021 says "tool-call policy must be present and reviewed" — that's a compliance-report assertion, not a runtime rule. |
| `AML.M0024` | AI Telemetry Logging | `decision-logger.js` | H | Direct fit. AWARE's append-only decision chain is the telemetry substrate. v2026.06 added "new required fields for C2-relay detection" — these map cleanly onto the `evidence` and `classification` fields of the AST10Annotation / ATLASAnnotation records. NEW: a `c2_relay_indicators` field on the ATLAS annotation. |

**Summary of mapping outcome for v2026.06:**

- **3 risk classes fully addressed** by existing controls with a
  compliance annotation (T0053, T0108, M0024).
- **4 risk classes partially addressed** with new rules in the new
  mapper (T0051 overall, T0054 Crescendo, T0113, T0091.001, T0114).
- **2 risk classes documented as known gaps** (T0051.000 Direct and
  T0051.002 Triggered prompt injection — both above the AWARE
  observation layer).
- **3 case studies from v2026.06 are test-vector candidates** for
  AWARE's compliance report (EchoLeak CS0059, AI-in-the-Middle CS0061,
  Semantic Kernel RCE CS0062 — all are agent-action observations).

### Module shape — `src/compliance/atlas-mapper.js`

Mirrors `ast10-mapper.js` (ADR-043 §"API surface"). Read-only on the
input event; write-only on the annotation chain via
`decision-logger.logDecision`; never blocks the originating tool call
(ADR-040 fail-open contract).

```js
// src/compliance/atlas-mapper.js
'use strict';

/**
 * ATLAS Technique Mapper (per ADR-047).
 *
 * Consumes audit events emitted by src/audit/decision-logger.js and
 * emits annotations tagged with matched MITRE ATLAS technique IDs
 * (e.g. ['AML.T0051.001', 'AML.T0113']).
 *
 * Reads the versioned catalogue from src/compliance/atlas-catalog.js.
 * Catalogue is pinned to ATLAS content v2026.06 / format v6.0.0; a
 * new release is a new AWARE release per §"Failure modes".
 *
 * NOT a scanner, NOT a policy decision point.
 *
 * @module compliance/atlas-mapper
 * @license Apache-2.0
 */

const { ATLAS_CATALOG, ATLAS_TECHNIQUE_IDS } = require('./atlas-catalog');

/**
 * @typedef {Object} ATLASAnnotation
 * @property {string} sourceDecisionId  decisionId of the input event
 * @property {string} eventType         'tool_dispatch' | 'tool_observation' |
 *                                       'memory_write' | 'identity_signing' |
 *                                       'skill_load' | ...
 * @property {string[]} matchedTechniques ATLAS technique IDs
 *                                       (e.g. ['AML.T0051.001','AML.T0113'])
 * @property {Object}  evidence         subset of the source event that
 *                                       triggered the match: { toolId?, target?,
 *                                       parametersHash?, agentId?, role?,
 *                                       parameterKeys? }
 * @property {Object}  classification   { rule: 'indirect-injection-fetch'|'c2-relay-via-web-ai'|'...',
 *                                       confidence: 'H'|'M'|'L',
 *                                       reference: 'AML.T0051.001#mitigation-AML.M0020' }
 * @property {Object[]}  c2RelayIndicators  v2026.06 addition per AML.M0024 update:
 *                                       [{ kind: 'public-ai-host', host: 'chat.openai.com', ... }]
 * @property {string}  timestamp         ISO 8601
 */

function createATLASMapper(opts = {}) { /* ... */ }
function classify(mapper, event) { /* ... */ }
async function classifyAndLog(mapper, event) { /* ... */ }
async function classifyChainSegment(mapper, fromDecisionId, toDecisionId) { /* ... */ }

module.exports = { createATLASMapper, classify, classifyAndLog, classifyChainSegment };
```

### `framework-mapper.js` block (additive)

```js
// In src/compliance/framework-mapper.js, alongside the existing
// OWASP_AST10 block (lines 116-138). Per ADR-047.
MITRE_ATLAS: {
  id: 'MITRE_ATLAS',
  name: 'MITRE ATLAS (Adversarial Threat Landscape for AI Systems)',
  version: 'content-v2026.06-format-v6.0.0',
  source: 'https://github.com/mitre-atlas/atlas-data',
  catalogRef: './atlas-catalog',
  // Pinned to dist/v6/ATLAS-2026.06.yaml (NOT dist/ATLAS.yaml —
  // the deprecated file lags and was missing T0113/T0114 at the
  // v2026.06 tag). Schema change tracking: format v6.0.0 added
  // the platforms field; content versions follow YYYY.MM.N.
  controls: ATLAS_TECHNIQUE_BLOCK,  // generated from atlas-catalog.js
  controlIds: ATLAS_TECHNIQUE_IDS,
  // Sub-techniques tracked via parent.sub (e.g. AML.T0051.001).
  // The compliance report renders the parent ID with its children
  // grouped beneath, mirroring the upstream display.
  relationships: ATLAS_RELATIONSHIP_BLOCK  // tactics + mitigations
}
```

### Initial classification rules (v1 set)

Each rule is a function `(event) => { matched, confidence }`. Set is
deliberately small — false positives are worse than false negatives
for compliance annotation.

| Rule ID | ATLAS ID | Trigger | Conf. | Notes |
|---|---|---|---|---|
| `indirect-injection-fetch` | `AML.T0051.001` | `event.action.type === 'tool_dispatch'` AND toolId is `web_fetch` / `http_get` AND parameters contain `url` field with a host not in the agent's allowlist | H | Twin of the AST10 `untrusted-instruction-fetch` rule. Same event triggers both; AST10 and ATLAS annotations are written to the chain alongside each other, both pointing at the same `parentDecisionId`. |
| `multi-turn-baseline-drift` | `AML.T0054` | `event.action.type === 'tool_dispatch'` AND the dispatched tool/parameters drift more than N standard deviations from the agent's `behavioral-baseline` window AND the drift trend is monotonic over the last K tool calls | M | The Crescendo shape is gradual, so the rule is "drift + monotonic trend" rather than "any single drift event". Tuning K (default 5) and the drift threshold (default 2σ) is a v1.1 concern. |
| `exfil-cookie-parameter` | `AML.T0113` | `event.action.type === 'tool_dispatch'` AND parameters contain a key matching `/^(cookie\|set-cookie\|session_?id\|auth_?token)$/i` AND toolId is NOT in the `network` capability set | M | Tool-call surface only — actual cookie theft (browser memory scrape, XSS) is above the observation layer. |
| `cookie-replay-attempt` | `AML.T0091.001` | `event.action.type === 'tool_dispatch'` AND parameters contain a `Cookie` or `Authorization` header AND the request host is not in the agent's origin set | M | Same shape as the untrusted-instruction rule but on a different field. |
| `web-ai-c2-relay` | `AML.T0114` | `event.action.type === 'tool_dispatch'` AND target host matches the public-AI-host list (`chat.openai.com`, `gemini.google.com`, `claude.ai`, `copilot.microsoft.com`, ...) AND the calling agent is not on the policy allowlist for that host | M | The public-AI-host list is configurable; default ships with the four above plus `perplexity.ai` and `you.com`. Operators override in `src/policies/atlas-host-policy.js`. |
| `tool-catalog-known-bad-destination` | `AML.T0108` | `event.action.type === 'tool_dispatch'` AND target is on the `tool-catalog.js` known-bad destination list | H | Re-uses the existing tool-catalog machinery; the new rule is just the annotation emitter. |
| `telemetry-c2-relay-indicator` | `AML.M0024` | `event.action.type === 'tool_dispatch'` AND ANY of the other rules fires | H | This is not a detector — it's a "annotate the M0024 telemetry provenance on every other detection" rule, satisfying the v2026.06 M0024 update requirement that C2-relay detections carry the telemetry context. |

The v1 rule set covers the v2026.06 technique delta plus the existing
T0053 / T0108 controls. Additional rules (T0056, T0059, T0100, T0102,
etc.) are v1.1 work and out of scope for this ADR.

### Integration points

Same three integration points as AST10 (ADR-043 §"Integration points"):

1. **Tool-observation proxy** (`src/policies/tool-observation-proxy.js`,
   `observeAndForward`): every tool call gets a pre-decision observation;
   the ATLAS mapper annotates it alongside the AST10 mapper. The chain
   carries both annotations on the same `parentDecisionId`.
2. **Memory-write path** (when an agent writes `MEMORY.md`, `AGENTS.md`,
   `SOUL.md`): tagged with `AML.T0053` (tool invocation used to persist
   attacker-controlled content into the agent's identity stack).
3. **Skill-load events** (when the agent registry loads a new skill):
   tagged with `AML.T0029` (Supply Chain Compromise) plus the new
   `transitive-dependency-hash` check from the AST02 follow-up.

## Consequences

### Positive

- AWARE's compliance posture now references **technique IDs**, not just
  risk classes. A auditor can ask "how many `AML.T0051.001` Indirect
  prompt injection attempts did AWARE observe in Q3?" and the decision
  chain answers with annotated events, not hand-curated summaries.
- The **schema-change discipline** (pin to `dist/v6/`, track content vs
  format versions) is documented and reproducible. A future ATLAS
  release (v2026.07, v2026.08, …) is a catalogue-version bump, not a
  re-architecture.
- The **EchoLeak (`AML.CS0059`) and AI-in-the-Middle (`AML.CS0061`)
  case studies** become test vectors for the new rules. Coder can
  write golden-event fixtures from the upstream case-study text and
  validate that the mapper fires with the expected confidence.
- The v2026.06 **`platforms` field** lets AWARE make per-platform
  coverage claims in the compliance report ("for Agentic AI platform,
  AWARE covers 41 of 49 mapped techniques; gap on 8 techniques in the
  Predictive AI platform").

### Negative / costs

- The mapper is **not a content-layer scanner**. It will not detect
  Direct (`AML.T0051.000`) or Triggered (`AML.T0051.002`) prompt
  injection because those happen above AWARE's tool-call observation
  surface. The compliance report must say "AWARE covers Indirect
  prompt injection at the tool-call layer; Direct and Triggered are
  platform concerns" rather than "AWARE covers all prompt injection".
- **Catalogue volume.** ATLAS v2026.06 has 170 techniques + 69
  sub-techniques + 35 mitigations + 63 case studies. The catalogue
  module ships only the subset AWARE has a control claim for (~30
  techniques + ~10 mitigations + the 6 new case studies as test
  vectors) — not the full corpus. Full coverage is a future ADR.
- **Schema coupling.** Format v6.0.0's centralised relationships map
  is rich (typed edges with metadata) but AWARE's v1 mapper doesn't
  consume it. A future ADR can add relationship-edge emission; v1
  keeps the surface narrow.
- **Two compliance mappers in parallel.** `ast10-mapper.js` and
  `atlas-mapper.js` are independent modules with separate rule
  tables. Some events fire both (Indirect injection fires AST05 +
  AML.T0051.001). The mapper correctly emits both annotations; the
  compliance report deduplicates. There is no shared rule registry —
  that consolidation is a future ADR if rule count grows past ~30 total.

### Failure modes (mandatory section)

- **The catalogue can't be loaded.** Surface as `ATLAS_CATALOG_UNAVAILABLE`
  in `/health`; refuse to start the hook. **Why:** the annotation chain
  is meaningless without a pinned catalogue; fail closed beats fail
  silent (same posture as AST10).
- **The decision-logger is unavailable.** The mapper catches the error
  from `logDecision`, surfaces `ATLAS_ANNOTATION_WRITE_FAILED` in the
  response body, but does NOT block the originating tool call. **Why:**
  ADR-040 hook contract — never blocks, never throws.
- **Rule fires with confidence 'H' but is a false positive.** Annotation
  is written; `/api/compliance/atlas` exposes a `confidence` field so
  a human can filter. The mapper never deletes a previously-emitted
  annotation. **Why:** chain is append-only and tamper-evident.
- **ATLAS upstream renumbers a technique ID.** `atlas-catalog.js` is
  pinned to content v2026.06; an upstream rename → new AWARE release →
  new catalogue version (e.g. `atlas-catalog-v2026.07.js`). **Why:**
  the rule table and the framework-mapper crosswalk are co-versioned.
  Mid-cycle upstream changes are a coordinated update, not an in-place fix.
- **`dist/ATLAS.yaml` (deprecated) is fetched instead of `dist/v6/ATLAS-2026.06.yaml`.**
  Snapshot script (`scripts/snapshot-atlas-catalog.js`, see acceptance
  criteria) must hard-code the `dist/v6/` path. The deprecated file
  was verified at the v2026.06 tag to be missing T0113/T0114; an
  accidental fetch from the deprecated path produces a catalog that
  silently drops the v2026.06 delta. **Why:** the format v6.0.0 release
  notes explicitly call out that `dist/ATLAS.yaml` is deprecated.

## Acceptance criteria

- [ ] `src/compliance/atlas-catalog.js` ships a static catalogue pinned
      to ATLAS content v2026.06 / format v6.0.0, with the shape defined
      in §"Module shape". Subset only — the techniques + mitigations
      + case studies AWARE has a control claim for. Full corpus is a
      future ADR.
- [ ] `src/compliance/atlas-mapper.js` implements `createATLASMapper`,
      `classify`, `classifyAndLog`, and `classifyChainSegment` per §.
- [ ] `src/compliance/framework-mapper.js` gains a `MITRE_ATLAS` block
      with the version pinned to `content-v2026.06-format-v6.0.0`, and
      each existing `AWARE_COMPONENT_MAPPINGS` row gains a
      `MITRE_ATLAS: [...]` array populated from the §"1:1 mapping"
      table.
- [ ] `src/policies/tool-observation-proxy.js` calls
      `atlas-mapper.classifyAndLog` on every observation (configurable;
      default off until tests pass).
- [ ] `src/api/routes/compliance.js` exposes
      `GET /api/compliance/atlas?fromDecisionId=&toDecisionId=` returning
      the ATLAS annotations in the range.
- [ ] `scripts/snapshot-atlas-catalog.js` fetches from
      `dist/v6/ATLAS-2026.06.yaml` (NOT `dist/ATLAS.yaml`), validates
      against the format v6.0.0 schema, and emits a frozen JS module
      for the subset. Invoked by the build, not at runtime.
- [ ] Unit tests in `test/unit/compliance/atlas-mapper.test.js` cover:
      each rule's true-positive case (using EchoLeak CS0059 + AI-in-the-
      Middle CS0061 + Semantic Kernel RCE CS0062 as fixtures), each
      rule's obvious false-positive case, catalogue-load failure,
      decision-logger write failure, and chain-integrity preservation
      when ATLAS annotations are interleaved with AST10 annotations on
      the same source event.
- [ ] `docs/compliance/atlas.md` follows the pattern of
      `docs/compliance/aicm-v1.md` — one section per technique AWARE
      covers, the control claim, and the confidence-rating rationale.
      Known gaps (T0051.000 Direct, T0051.002 Triggered) are explicitly
      listed as out-of-scope.

## Follow-up work (out of scope for this ADR)

- **Full corpus.** The v1 catalog is a subset (~30 techniques);
  expanding to the full 170 + 69 + 35 + 63 catalogue is a future ADR.
  The acceptance criterion is "ship the subset; the build script
  generates it from the upstream YAML; expanding is a catalogue
  refresh, not a code change".
- **Relationship edges.** Format v6.0.0's first-class relationships
  (`sequences`, `achieves`, `specializes`, `mitigates`, `employs`)
  aren't surfaced in v1 annotations. Adding them is a follow-up that
  lets the compliance report show "this event matches T0051.001
  Indirect, which achieves tactic TA0003 Initial Access, which is
  mitigated by M0020 Generative AI Guardrails".
- **Multi-turn baseline drift tuning.** The Crescendo detector
  (K=5, threshold=2σ) needs labelled data to calibrate. Until then,
  ship with default thresholds and document them as untuned.
- **Per-platform coverage report.** The `platforms` field is captured
  in the catalogue but not yet surfaced in `/api/compliance/atlas`.
  Trivial to add — out of scope for v1 because no operator has
  requested it yet.

## Open questions for reviewer

1. **Catalogue subset scope.** ADR proposes ~30 techniques. Is the
   right subset (a) the techniques AWARE has a direct control for
   today, (b) the techniques AWARE has any annotation rule for
   (Direct + Indirect + Triggered), or (c) the full corpus with
   most entries marked "no AWARE control, informational only"?
   ADR recommends (a) for v1; (c) for the future full-corpus ADR.
2. **Public release gating.** The mapper touches the public-published
   audit interface. Should the `MITRE_ATLAS` framework entry ship on
   `main` first and cherry-pick to `public/v2.8.x` after the next
   ATLAS release stabilises, or should the public branch wait for
   v2026.07? ADR recommends ship on main, cherry-pick to public per
   `docs/security/branch-discipline.md` after the first v2026.07
   patch lands and we have signal that the schema hasn't churned
   again.
3. **Crescendo detector false-positive rate.** Multi-turn baseline
   drift is inherently noisier than single-event detectors. Should
   the rule ship with confidence 'L' until labelled test data
   exists, or stay out of v1 entirely? ADR recommends 'M' with
   K=5, threshold=2σ defaults and an explicit "untuned" note in
   the rule table.

## References

- MITRE ATLAS data repo: https://github.com/mitre-atlas/atlas-data
- ATLAS v2026.06 release: https://github.com/mitre-atlas/atlas-data/releases/tag/v2026.06
- ATLAS v2026.06 canonical YAML (pinned):
  https://raw.githubusercontent.com/mitre-atlas/atlas-data/v2026.06/dist/v6/ATLAS-2026.06.yaml
- ATLAS v2026.05 release (format v6.0.0 + content/format version split):
  https://github.com/mitre-atlas/atlas-data/releases/tag/v2026.05
- ATT&CK T1539 (Steal Web Session Cookie, the cross-reference for
  AML.T0113): https://attack.mitre.org/techniques/T1539/
- AWARE AST10 mapper (sibling pattern): `src/compliance/ast10-mapper.js`,
  ADR-043
- AWARE decision chain: `src/audit/decision-logger.js`
- AWARE tool observation: `src/policies/tool-observation-proxy.js`
- AWARE hook interception (fail-open contract): ADR-040
- Branch discipline (public release): `docs/security/branch-discipline.md`
- EchoLeak (AML.CS0059): zero-click prompt injection in M365 Copilot
- AI in the Middle (AML.CS0061): web AI services as C2 relays
- Semantic Kernel RCE (AML.CS0062): single prompt → host-level RCE
- LeakyLMs (arXiv:2607.20723v1, 2026): remote-API timing side-channels
  against hosted LLMs. Out of ATLAS's current taxonomy; tracked
  separately in `docs/security/threat-model.md` (consumer-side risk
  for AWARE agents calling third-party LLM APIs via the RLM primitive).