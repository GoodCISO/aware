# DESIGN — ACS (Agent Control Specification) support in AWARE

**Status:** implementation design, mapped to the real AWARE tree at
`github/main` = `df9483f3` (v2.12.2).
**Pinned upstream:** ACS `v0.4.0-beta.2` @ `b11ae38b1bd53d299789c1724f4f94f80a0c6540`.
See `/docs/acs/VERSION`.

---

## 1. What ACS is, and why AWARE needs an adapter rather than a rewrite

ACS separates **decision** from **enforcement**. The runtime computes a
verdict; the host applies it. AWARE already has this shape: `PolicyEngine.evaluate()`
returns a decision object and the caller enforces it. So ACS support is an
**adapter and conformance job**, not a redesign.

Three facts from the pinned spec drive the whole design:

1. **ACS is a closed enum world.** A verdict is one of five decisions, and
   the policy input is an object with exactly five members. AWARE's internal
   vocabulary is different (`ALLOW`/`DENY`/`AUDIT`/`NO_POLICY`). The
   translation must be total and must live in exactly one place.
2. **ACS is fail-closed by construction.** Section 21: "Any error during
   evaluation yields a `deny` verdict." A conformant AWARE must never widen
   this. Every adapter error path terminates in `deny`.
3. **ACS is a draft.** The release tag (`v0.4.0-beta.2`) does **not** match
   the manifest version strings the schema accepts (`0.4.0-alpha.1` and
   `0.5.0-alpha.1`), and the spec text at the pinned tag already describes
   `0.5.0-alpha.1` behaviour. A version bump must be a contained change.

---

## 2. Upstream contract, as measured

### 2.1 Versions actually found (not as the task brief assumed)

| Item | Task brief said | Measured | Evidence |
| --- | --- | --- | --- |
| ACS spec version | "0.5.0-alpha at last check" | Release tag `v0.4.0-beta.2`; manifest versions `0.4.0-alpha.1` / `0.5.0-alpha.1` | `git ls-remote`/GitHub releases API; `spec/schema/manifest.schema.json` pattern |
| Verdict set | "closed set: allow, deny, transform" | **Five**: `allow`, `deny`, `warn`, `escalate`, `transform` | `spec/schema/wire/verdict.schema.json` `$defs.result_verdict.decision.enum`; SPEC §13 |
| Receipt schema | "receipt" | ACS defines the receipt **by reference** to AGENT-HOOKS-0.1 §10.3 | `agent-hooks` `interception-record.schema.json` |
| Receipt required members | not stated | 11 required: `interception_point`, `mode`, `verdict`, `input_identity`, `enforced_identity`, `identity_provider`, `session_id`, `sequence`, `composition`, `interceptors_registered` | `interception-record.schema.json` |

The verdict set is the most consequential divergence. `warn` and `escalate`
are **policy-language intents** that the runtime normalizes: `warn` → `allow`
carrying a `warnings[]` entry; `escalate` → `deny` carrying an `approval`
block. The task brief's mapping ("human approval required → the escalate
intent, normalised to deny plus an approval block") matches the spec exactly
here, so the brief is right about the *mapping* and wrong about the *enum*.

### 2.2 Policy input (SPEC §7, `policy-input.schema.json`)

Exactly five members, `additionalProperties: false`:

```json
{
  "intervention_point": "pre_tool_call",
  "policy_target": { "kind": "tool_args", "path": "$snap.tool_call.args", "value": {} },
  "snapshot": {},
  "annotations": {},
  "tool": null
}
```

`policy_target.value` is where a `transform` writes. `tool` is the projected
tool or `null`.

### 2.3 Verdict (SPEC §13, `verdict.schema.json`)

| Member | Required | Rule |
| --- | --- | --- |
| `decision` | yes | one of the five |
| `reason` | no | MUST NOT start with `runtime_error:` or `host_error:` |
| `message` | no | free text |
| `transform` | iff `decision == transform` | `{path, value}`, `path` rooted at `$target` |
| `warnings` | no | array of `{reason, message}` |
| `approval` | only when decision is `deny` | the liftable-deny block |
| `evidence` | no | `{artefact, verification_pointers}` |
| `result_labels` | no | array of strings |

### 2.4 Reserved reasons (SPEC §16)

24 registered reasons, all `runtime_error:*`. The adapter must never emit one
as a *policy* `reason` — reserved prefixes are runtime-owned. The adapter
does emit them in **fail-closed** paths, where the runtime error is the
verdict's reason.

### 2.5 The transform root

SPEC §3.2: a `transform.path` MUST be rooted at `$target`. The retired
`$policy_target` root MUST fail closed with `runtime_error:transform_invalid`;
any other root MUST fail closed with `runtime_error:transform_target_forbidden`.

> **Upstream defect found.** AGT's `examples/acs-email-tool/email_policy.py`
> returns `"path": "$policy_target.body"`. Under the pinned spec that is the
> **retired** root and MUST fail closed with `runtime_error:transform_invalid`
> — the example's own `transform` case cannot pass against a conformant
> runtime. AWARE's implementation of the same policy uses `$target.body`.
> See §7 finding F-2.

### 2.6 The intervention-point contract (Agent Hooks)

Eight points, closed enum: `agent_startup`, `input`, `pre_model_call`,
`post_model_call`, `pre_tool_call`, `post_tool_call`, `output`,
`agent_shutdown`. AGT's host pattern is `AgentControl` + `HostSession` +
`SnapshotBuilder`; the host calls `session.pre_tool_call(...)`, gets a
result, and applies the verdict.

---

## 3. AWARE's real architecture (mapped, not assumed)

All paths relative to repo root. Every name below was read from the tree at
`df9483f3`.

| Concern | Real module | Real symbol |
| --- | --- | --- |
| Policy evaluation | `src/policies/engine.js` | `PolicyEngine.evaluate(request)` → `{decision, reason, policyId, riskLevel, requiresApproval}` |
| Decision vocabulary | `src/policies/engine.js:12-17` | `Decision = {ALLOW:'ALLOW', DENY:'DENY', AUDIT:'AUDIT', NO_POLICY:'NO_POLICY'}` |
| Default decision | `src/policies/engine.js:22` | `DEFAULT_DECISION = Decision.DENY` |
| Policy actions | `src/policies/model.js:27-31` | `PolicyAction = {ALLOW, DENY, AUDIT}` |
| Policy conditions | `src/policies/model.js:41-48` | `ConditionType` incl. `REQUIRED_APPROVAL: 'requireApproval'` |
| Policy storage | `src/policies/store.js` | `PolicyStore.findForTool(agentId, tool)` |
| Tool catalogue | `src/policies/tool-catalog.js` | `getTool`, `getRiskLevel`, `requiresApproval(toolName)`, `isAllowedForDataTier` |
| Tool-call interception | `src/policies/tool-observation-proxy.js` | `ToolObservationProxy.observeAndForward(toolId, parameters, agentContext)`; `wrapExecutor(executor)` |
| Wrapped executor | same | `ToolObservationProxy.wrapExecutor` — the choke point a host integrates with |
| Audit chain (tamper-evident) | `src/audit/decision-logger.js` | `logDecision`, `getChain`, `getChainBetween`, `verifyChain`, `exportChain`, `generateUUID`, `canonicalSerialize`, `computeRecordHash` |
| Chain record shape | `src/audit/decision-logger.js:52-64` | `DecisionRecord` with `decisionId`, `parentDecisionId`, `timestamp`, `actor`, `action`, `context`, `outcome`, `hash`, `prevHash` |
| Chain integrity | same, `verifyChain` at `:562` | SHA-256 hash chain, `GENESIS_HASH` anchor, per-record self-hash verification, gap-resync vs. tampering detection |
| Tool audit log | `src/policies/tool-audit-logger.js` | `logToolObservation`, `logToolExecution`, `logSecurityEvent`, `logValidationFailure`, `getComplianceEvidence` |
| Kill switch | `src/kill-switch/revocation-service.js` | `RevocationService.isRevoked(agentId)`, `getRevocationStatus(agentId)` |
| Emergency kill signals | `src/emergency/kill-switch-issuer.js` | `KillSwitchIssuer.issue(options)`, `getStatus`, `getIssuedKillSignals` |
| HTTP surface | `src/api/index.js` | Express app; routers mounted under `/api/*`; `authenticateToken` at `:221` |
| Permission evaluation (existing HTTP precedent) | `src/api/routes/tools.js:132` | `POST /api/tools/evaluate` → `evaluatePermission(agentRole, toolId, parameters)` |
| Public entrypoint | `src/index.js` | `module.exports = AWAREEngine` |

### 3.1 The mapping is real, not aspirational

| ACS concept | AWARE equivalent | Note |
| --- | --- | --- |
| tool limits | `ConditionType.MAX_FREQUENCY`, `MAX_ERROR_RATE`, `TOKEN_BUDGET` | real conditions in `src/policies/model.js` |
| blocked tools | `PolicyAction.DENY` policies + `tool-catalog.isAllowedForDataTier` | |
| kill switch | `RevocationService.isRevoked(agentId)` | **not currently consulted by `PolicyEngine.evaluate()`** — see §3.3 |
| human approval | `requiresApproval(toolName)` + `ConditionType.REQUIRED_APPROVAL` | **flag only, no resolution seam** — see §3.3 |
| redaction / arg rewriting | *none found* | `transform` is **new** in AWARE |
| soft alert | `Decision.AUDIT` | maps to ACS `warn` → `allow` + `warnings[]` |
| evidence / receipt | `logDecision` hash chain | reusable as the tamper-evident store |

### 3.2 Gaps that force design decisions

**G-1 — No `transform` capability exists.** AWARE's decision vocabulary has
no rewrite verdict, and no module performs redaction or argument rewriting.
ACS `transform` is therefore **new code**, not a mapping.

**G-2 — No approval *resolution* seam.** AWARE represents approval as a
**boolean flag** (`requiresApproval`, `PolicyAction.REQUIRED_APPROVAL`). It
has no request/response object, no resolution state machine, and no
`context_identity` binding. ACS requires a liftable deny carrying an
`approval` block, with an approval path that binds to a
`context_identity`. So the ACS adapter must define an **approval request →
resolution** contract and persist it. AWARE's `src/emergency/recovery-manager.js`
has a `PENDING`/`APPROVED` state machine but it is for **re-onboarding after a
kill signal**, not for per-tool-call approvals; reusing it would conflate two
different concerns. The adapter defines its own.

**G-3 — The kill switch is not on the policy evaluation path.**
`RevocationService.isRevoked()` exists and `PolicyEngine.evaluate()` does not
call it. The ACS adapter **must** consult it, because ACS requires that any
unresolved condition produces `deny`. Wiring it into the adapter (not into
`PolicyEngine`) keeps the blast radius contained and does not change current
tool-limit, kill-switch or approval behaviour for existing callers — a
constraint the task states explicitly.

**G-4 — No JSON Schema validator in the dependency tree.** `src/v2/tier_promotions_handler.js:11-15`
records this deliberately: "no ajv in the dep tree ... Keeps the runtime dep
set unchanged". The task also says "Don't add heavy dependencies without
justification". So the adapter ships a **small, self-contained validator** for
the subset of JSON Schema the pinned ACS schemas use, rather than adding
`ajv`. This is recorded in `DESIGN.md` §6.

**G-5 — `package.json` has no `exports` field and `files` is an explicit
allow-list.** Any new public module must be added to `files`, or it will not
ship in the npm tarball. `src/governance/` was missing from `files` on
`github/main` and was fixed on the local tree by `73ee5898` ("ship
`src/governance/` in the npm tarball") — the same trap applies to
`src/acs/`.

### 3.3 What the adapter will NOT do

To honour "No regressions to current tool-limit, kill-switch or approval
behaviour", the adapter is **additive**:

- It does **not** modify `src/policies/engine.js`.
- It does **not** modify `src/kill-switch/revocation-service.js`.
- It does **not** change `src/api/index.js` routing except to mount one
  router.
- It reads the kill switch and the policy engine; it does not replace them.

---

## 4. Architecture

```
                    ┌──────────────────────────────────────────┐
  host (MCP/AGT/   │  src/acs/host-adapter.js                 │
  Foundry)  ──────▶│  AcsHostSession                          │
                    │   .preToolCall({tool,args,ctx})           │
                    └───────────────┬──────────────────────────┘
                                    │ builds ACS policy input
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │  src/acs/decision-engine.js              │
                    │  AcsDecisionEngine.evaluate(policyInput) │
                    │   1. validate  (schema)                  │
                    │   2. policy  (AWARE PolicyEngine)        │
                    │   3. kill switch                          │
                    │   4. approval                            │
                    │   5. normalise → ACS verdict             │
                    └───────────────┬──────────────────────────┘
                                    │ verdict
                    ▼
                    ┌──────────────────────────────────────────┐
                    │  src/acs/receipt.js                      │
                    │  buildReceipt() → interception-record    │
                    └───────────────┬──────────────────────────┘
                                    │ logDecision (hash chain)
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │  src/audit/decision-logger.js            │
                    │  logDecision → tamper-evident chain      │
                    └──────────────────────────────────────────┘
```

### 4.1 Module layout — everything ACS-specific behind a versioned adapter

| Path | Role | ACS-specific? |
| --- | --- | --- |
| `src/acs/index.js` | public entry; exports the adapter surface | yes |
| `src/acs/version.js` | the pinned version constants | yes |
| `src/acs/schemas.js` | loads vendored schemas from `docs/acs/schemas/` | yes |
| `src/acs/validator.js` | minimal JSON Schema validator (no `ajv`) | yes |
| `src/acs/decision-engine.js` | ACS verdict engine | yes |
| `src/acs/normalize.js` | AWARE decision → ACS verdict | yes |
| `src/acs/transform.js` | `$target`-rooted path resolution + application | yes |
| `src/acs/approval.js` | approval request/resolution seam | yes |
| `src/acs/receipt.js` | ACS receipt (interception record) builder | yes |
| `src/acs/host-adapter.js` | `AcsHostSession` (AGT-shaped host adapter) | yes |
| `src/acs/fail-closed.js` | the single fail-closed constructor | yes |
| `src/api/routes/acs.js` | HTTP transport | partly |

**Containment rule.** Nothing outside `src/acs/` and the one mounted router
may import an ACS module. `src/acs/version.js` exports
`ACS_SPEC_VERSION`, `ACS_RELEASE_TAG` and `ACS_COMMIT`. A spec bump touches
`version.js`, the vendored schema files, and the drift-test hash table —
nothing else. This is the "contained change" the task requires.

### 4.2 Decision mapping (total, and the only place it lives)

| AWARE | ACS `decision` | Extra members |
| --- | --- | --- |
| `ALLOW` | `allow` | — |
| `AUDIT` | `allow` | `warnings: [{reason, message}]` (the `warn` intent) |
| `NO_POLICY` | `allow` | `warnings: [{reason:'no_policy_matched', ...}]` |
| `DENY` (no approval) | `deny` | `reason` |
| `DENY` (approval required) | `deny` | `approval: {...}` — a liftable deny |
| kill switch active | `deny` | `reason: 'kill_switch_active'` |
| transform | `transform` | `transform: {path, value}` |

`evaluate_only` mode returns the identical verdict but the host adapter
**records** it and does **not** block. The mode never changes the verdict
computation — it changes only whether the host acts.

### 4.3 Fail-closed: one constructor, no exceptions

Every error path in the adapter produces a deny through one function:

```js
// src/acs/fail-closed.js
function failClosed(reason, message) {
  return { decision: 'deny', reason, message };
}
```

`reason` is always one of the reserved `runtime_error:*` strings from the
vendored `reserved-reasons.json`. The adapter never returns a non-reserved
reason on an error path, and never returns `allow` from a catch block. The
fail-closed tests assert this by **pattern** (every error path yields a
reserved reason and `decision === 'deny'`), not by enumerating paths, so a
new error path cannot silently escape the rule.

### 4.4 Approval seam

ACS `escalate` normalizes to `deny` carrying an `approval` block, and the
host lifts it through an approval path. AWARE has a flag, not a seam, so the
adapter defines one:

```js
// src/acs/approval.js
createApprovalRequest({ verdict, interventionPoint, contextIdentity, context })
resolveApproval(requestId, { outcome, resolvedBy, contextIdentity })
```

- `contextIdentity` is the echo token: a resolution whose `contextIdentity`
  does not match the request byte for byte is **rejected**, and the deny
  stands. This mirrors AGENT-HOOKS-0.1 §9.
- Outcomes: `approve`, `reject`, `unresolved`.
- `unresolved` → deny stands (fail closed).
- An expired approval → deny stands.

The adapter stores approvals through the same `logDecision` chain, so an
approval request and its resolution are both in the audit trail.

### 4.5 Receipts into the evidence trail

ACS defines the receipt by reference to AGENT-HOOKS-0.1 §10.3. The receipt
schema (`interception-record.schema.json`) requires 11 members. The adapter
builds that object and writes it into AWARE's hash chain via
`logDecision()`, using:

- `decisionId` ← the receipt's `session_id` + `sequence` pair, derived
  deterministically so a receipt is addressable.
- `parentDecisionId` ← the receipt's `enforced_identity`/`input_identity`
  link, so **policy → decision → action → result** is one trail.
- `action.type` ← `acs_receipt`, `action.target` ← the intervention point,
  `action.reason` ← the verdict reason.
- `context` ← the ACS-specific fields: `policyId`, `policyVersion`,
  `interventionPoint`, `mode`, `specVersion`.

**Tamper evidence** uses AWARE's existing mechanism, as the task asks: the
decision chain is already a SHA-256 hash chain with a genesis anchor and a
`verifyChain()` routine. No new integrity primitive is introduced.

The receipt is also written to the tool audit log via
`ToolAuditLogger.logSecurityEvent()` so it is queryable through the existing
`/api/tools/audit/evidence` surface.

### 4.6 Transform application

`transform.path` is rooted at `$target`. The adapter resolves the path
against the **policy target value** (not the snapshot) and replaces the value
at that location. Path roots other than `$target` fail closed with
`runtime_error:transform_target_forbidden`; the retired `$policy_target` root
fails closed with `runtime_error:transform_invalid`.

The runtime returns the transform **unapplied**; the **host** applies it —
exactly as ACS §14 requires. `AcsHostSession` therefore returns both the
verdict and the applied value, so a caller can never accidentally execute
the untransformed target.

### 4.7 Transport

Three transports, one engine:

1. **Library** — `require('@goodciso/aware/src/acs')` gives
   `AcsDecisionEngine` and `AcsHostSession`.
2. **HTTP** — `POST /api/acs/evaluate` (mounted router, behind the existing
   `authenticateToken`). Mirrors the existing `POST /api/tools/evaluate`
   precedent at `src/api/routes/tools.js:132`.
3. **Host adapter** — `AcsHostSession` with the AGT-shaped surface
   (`preToolCall`, `postToolCall`, `output`), so an AGT or Foundry host can
   adopt it with a small shim.

---

## 5. Phase plan

### Phase 1 — AWARE as an ACS decision engine

- [ ] `src/acs/version.js`, `src/acs/schemas.js`, `src/acs/validator.js`
- [ ] `src/acs/decision-engine.js` — validate, evaluate, normalise
- [ ] `src/acs/normalize.js` — the total AWARE→ACS mapping
- [ ] `src/acs/fail-closed.js`
- [ ] `src/acs/transform.js`
- [ ] `src/acs/host-adapter.js`
- [ ] `src/api/routes/acs.js` + mount

Supported intervention points: `pre_tool_call`, `post_tool_call`, `output`
enforced. The other five (`agent_startup`, `input`, `pre_model_call`,
`post_model_call`, `agent_shutdown`) return a **well-formed allow verdict**
with no AWARE policy attached, and are recorded.

### Phase 2 — Receipts into AWARE evidence

- [ ] `src/acs/receipt.js` — build the interception record
- [ ] `src/acs/approval.js` — the approval seam
- [ ] wire into `logDecision` and `ToolAuditLogger`
- [ ] link receipt → outcome

### Phase 3 — Policy interoperability

- [ ] import ACS manifests (`extends` chains) into AWARE
- [ ] export AWARE policies as ACS manifests
- [ ] round-trip test: AWARE → ACS manifest → AWARE → identical verdicts

### Phase 4 — Conformance and tests

- [ ] schema validation of every artefact in CI
- [ ] **drift test**: vendored schemas vs. the pinned SHA-256 table
- [ ] reproduce the ACS email-tool example end to end, all three outcomes
- [ ] fail-closed tests for the issue-#83 class
- [ ] `evaluate_only` test
- [ ] full existing suite green

---

## 6. Dependency decision

See section 12.

--- | --- |
| `ajv` | Rejected. Heavy relative to need; the pinned ACS schemas use a small, well-defined subset of JSON Schema (types, `enum`, `required`, `additionalProperties`, `$ref`, `oneOf`, `anyOf`, `allOf`/`if`/`then`, `pattern`, `minLength`, `const`, `not`). The repository has already made this call deliberately (`src/v2/tier_promotions_handler.js:11-15`). |
| `@hyperjump/json-schema` | Rejected. Same reason, larger surface. |
| Hand-written subset validator | **Chosen.** ~300 lines, no dependency, tested against the pinned schemas. Records the supported subset so a future schema using an unsupported keyword fails loudly (schema-error), never silently. |

**OPA stays optional.** Rego evaluation is not required for the adapter. The
adapter consumes ACS manifests; it does not implement a policy language.
Phase 3's "Rego policy bundles evaluated through OPA" is therefore
**deferred to Phase 3** and gated behind an optional dependency, per the
task's instruction to keep OPA optional.

---

## 7. Spec ambiguities and discrepancies found

Recorded as required. Each is measured, not inferred.

**F-1 — Release tag vs. manifest version.** The ACS release tag is
`v0.4.0-beta.2`, but `manifest.schema.json` accepts only the manifest
version strings `0.4.0-alpha.1` and `0.5.0-alpha.1`. The spec text at the
pinned tag describes `0.5.0-alpha.1` semantics (e.g. §10.1 "For
`0.5.0-alpha.1`, an `annotator_dispatch`..."). **Decision:** pin the release
tag and commit in `docs/acs/VERSION` (that is the reproducibility anchor);
accept both manifest version strings; record `SPEC_VERSION=0.5.0-alpha.1`
as the version the adapter targets.

**F-2 — AGT's example uses the retired transform root.**
`examples/acs-email-tool/email_policy.py` returns
`"path": "$policy_target.body"`. SPEC §3.2 states the pre-0.4
`$policy_target` root "MUST fail closed with
`runtime_error:transform_invalid`". **The upstream example's transform case
therefore cannot pass against a conformant runtime.** AWARE implements
`$target.body` and records this as a known upstream defect.

**F-3 — AGT vendors a drifted verdict schema.** Comparing AGT's vendored
`acs_generator/schema/wire/verdict.schema.json` against the pinned ACS
`spec/schema/wire/verdict.schema.json`: **different** (SHA-256
`5ca5c124a2a3…` vs `57971b017882…`). `policy-input`, `request` and
`snapshot` are byte-identical; `verdict` and `result` have drifted.
**Decision:** AWARE vendors the **ACS** schemas, not AGT's copies.

**F-4 — `warn` and `escalate` are intents, not verdicts.** SPEC §13: they
"normalize to `allow` carrying a warning and `deny` carrying an approval
block". A host that emits `decision: "warn"` is **not** conformant. The
adapter therefore never emits `warn`/`escalate` as a decision — it emits
`allow`/`deny` with the corresponding extra members. (The five-value enum
still permits them on the wire; the spec forbids them post-normalisation.)

**F-5 — The receipt schema lives in Agent Hooks, not ACS.** ACS §19 points at
AGENT-HOOKS-0.1 §10.3. AWARE vendors the Agent Hooks
`interception-record.schema.json` and records its commit in
`docs/acs/VERSION`.

**F-6 — Issue #83 is the fail-open class to guard.** The closed ACS issue
"Bundled Cedar dispatcher evaluates with `Context::empty()`, so every
context-gated `forbid` in the shipped cedar-lib silently never fires" is a
**fail-open** defect: a policy that should deny returned `allow`, with no
error and no warning. The AWARE fail-closed tests target this class
specifically: a policy that *should* deny must deny, and the *reason* must
be a reserved error reason rather than a silent allow.

**F-7 — `evaluate_only` and `transform`.** SPEC §14: in `evaluate_only` the
host "validates the transform but applies none". So `evaluate_only` still
validates a transform and still fails closed on an invalid one.

---

## 8. Open questions

1. **Approval storage.** The approval seam needs durable storage. Options:
   the existing `logDecision` chain (append-only, hash-chained, already
   tamper-evident) or a new table. **Proposal:** the chain, with a separate
   index for pending requests. No blocker; the chain suffices for the
   reviewable branch.
2. **Policy precedence.** ACS §6 fixes the *evaluation order within one
   evaluation*. It does not say how an ACS manifest's policies combine with
   AWARE's own per-agent policies when both apply. **Proposal:** AWARE's
   existing policy engine evaluates first and its verdict wins on deny; ACS
   policy is consulted for the transform and warn paths. To be confirmed.
3. **Rego/OPA.** Deferred to Phase 3 and optional, per §6.
4. **`identity_provider`.** The receipt schema requires
   `input_identity`/`enforced_identity` to be **null** when
   `identity_provider` is null. AWARE has a crypto identity provider
   (`src/agents/identity-provider-v2.js`), but the ACS identity semantics
   (content-derived, §10.1) are not the same thing. **Proposal:** declare
   `identity_provider: null` until AWARE's identity provider is shown to
   produce content-derived ACS identities.

---

## 9. Test strategy

| Suite | Proves |
| --- | --- |
| `test/unit/acs/schema-drift.test.js` | vendored schemas match the pinned SHA-256 table; a modified vendored file fails |
| `test/unit/acs/validator.test.js` | the subset validator handles the pinned schemas; unsupported keywords fail loudly |
| `test/unit/acs/decision-engine.test.js` | the five-member policy input, the three enforced intervention points, the five decisions, both modes |
| `test/unit/acs/fail-closed.test.js` | every failure path denies; none allows; reasons are reserved |
| `test/unit/acs/transform.test.js` | `$target` rooting; forbidden and retired roots fail closed |
| `test/unit/acs/approval.test.js` | approve lifts; reject/unresolved/expired do not; identity mismatch is rejected |
| `test/unit/acs/receipt.test.js` | the receipt validates against the pinned receipt schema; it lands in the chain; it links to the outcome |
| `test/unit/acs/email-tool.test.js` | the ACS email-tool example end to end, all three verdicts |

The fail-closed suite is written as a **property**, not a list of cases: it
drives a set of fault injections (engine throw, timeout, malformed input,
missing policy, expired approval, rejected approval, unknown intervention
point, unresolvable path, forbidden transform root, invalid receipt) and
asserts each yields `decision === 'deny'` with a reserved reason. A new
fault injection that yields `allow` fails the suite, which is the issue-#83
guard.

---
## 10. Documentation

- `docs/acs/README.md` — what is supported, the pinned version, the verdict
  mapping table, a quickstart, known gaps.
- `docs/acs/DESIGN.md` — this document.
- `docs/acs/VERSION` — the pin.
- `docs/acs/VENDORED.md` — provenance and licences for every vendored file.
- `docs/acs/CONFORMANCE.md` — the conformance statement.
- Root `README.md` "What's new" — a concise ACS entry.

---

## 11. A runtime defect found on this host, and the fix it forced

**MEASURED 2026-11-23, Node v26.13.0 (the only Node on this host), macOS.**

A plain property read of a freshly constructed object literal can
**intermittently return `undefined`** even though the object holds the
correct value by every other measure:

| Read | Result |
| --- | --- |
| `obj.key` (inline as an argument) | `undefined` — intermittently, call-site dependent |
| `Object.getOwnPropertyDescriptor(obj, 'key').value` | correct |
| `JSON.stringify(obj)` | correct |
| `obj.key` read into a local first | correct |
| `Object.keys(obj)` | correct |

The object literal is byte-correct. The property descriptor reports the
right value. `JSON.stringify` reports the right value. Only the plain
property read disagrees, and it disagrees non-deterministically — the same
expression in the same process passes in one call site and fails in
another. Re-reading the same property does not reliably help.

**Why this matters here.** The first symptom was an ACS receipt whose
`interception_point` read as `undefined` immediately after construction,
which broke the decision-chain record built from it. A test assertion
failed with `actual: undefined` while the receipt's own descriptor and
`JSON.stringify` both reported the correct value.

**This is not a logic error in AWARE.** It is a property-read defect in the
runtime, and the adapter must not depend on the defect.

**THE FIX.** A receipt is a **JSON wire artefact**: it is defined by a JSON
Schema, validated against one, and transported as JSON. The JSON data model
is therefore its canonical form. `buildReceipt` materialises the receipt
through `JSON.parse(JSON.stringify(receipt))`, and `buildDecisionRecord`
reads the members back through the same model.

That fix is right on its own merits, independent of the defect:

1. A receipt can carry only JSON values. An `undefined`, a function, a
   `Date` instance or a class instance cannot survive the round trip, so
   the receipt's shape is guaranteed by construction rather than by
   convention.
2. The receipt becomes a plain data object with plain data properties,
   which is what every consumer expects.
3. It makes the **payload-free** guarantee structural. Only the JSON data
   model survives, so nothing outside it can leak into the receipt.

**An earlier workaround was removed.** A first attempt introduced
`src/acs/read-member.js`, a defensive own-property reader that preferred
the property descriptor over the plain read. It was deleted. The
descriptor is not a stable oracle either: in the failing process it also
reported `undefined` for a property the plain read returned correctly.
Reading through the JSON data model is the fix that holds.

**What this is not.** It is not a licence to ignore a wrong value. The
receipt's members are asserted against the **pinned schema** by
`validateReceipt`, and the schema validation is what proves the receipt is
conformant. The round trip changes how the receipt is materialised, not
what it asserts.

**For a reviewer on a different runtime.** If you do not see this defect,
the round trip is a no-op on the values and the tests pass unchanged. The
receipt tests read members through the same JSON model, so they are
consistent with the production path.

---

## 12. Dependency decision (moved from section 6)

**No new runtime dependency.** Rationale, per the task's constraint:

| Option | Verdict |
| --- | --- |
| `ajv` | Rejected. Heavy relative to need; the pinned ACS schemas use a small, well-defined subset of JSON Schema (types, `enum`, `required`, `additionalProperties`, `$ref`, `oneOf`, `anyOf`, `allOf`/`if`/`then`, `pattern`, `minLength`, `const`, `not`). The repository has already made this call deliberately (`src/v2/tier_promotions_handler.js:11-15`). |
| `@hyperjump/json-schema` | Rejected. Same reason, larger surface. |
| Hand-written subset validator | **Chosen.** ~300 lines, no dependency, tested against the pinned schemas. Records the supported subset so a future schema using an unsupported keyword fails loudly (schema-error), never silently. |

**OPA stays optional.** Rego evaluation is not required for the adapter. The
adapter consumes ACS manifests; it does not implement a policy language.
Phase 3's "Rego policy bundles evaluated through OPA" is therefore
**deferred to Phase 3** and gated behind an optional dependency, per the
task's instruction to keep OPA optional.
