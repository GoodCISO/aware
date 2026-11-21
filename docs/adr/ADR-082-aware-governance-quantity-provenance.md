# ADR-082 — AWARE Governance Quantity Provenance: making the declared/implemented gap checkable

**Status:** Proposed (2026-11-19)
**Author:** Chronicler (Scribe)
**Reviewers:** required — Archimedes (architect), Critic (reviewer), Sentinel (auditor)
**Supersedes:** nothing
**Related:** ADR-065 (IETF decoupled agent authorization), ADR-078 (VERA edge-revocation monitor), ADR-080 (`decisionChainDepth` as a read-time derived metric), ADR-081 (editions and extension contract)
**Context:** `src/governance/quantity.js`, `src/governance/registry.js`

---

## 1. Context

AWARE declares a set of governance quantities: a trust score carried in the agent credential, a blast-radius estimate, a revocation trail penalty, an emergency impact estimate, and audit counters. A source-level audit of v2.12.3 (`e9833660`) asked, for each, whether code computes it.

The audit's first pass produced a clean negative result. Two findings emerged that were more specific than "not computed":

1. **A trust-score producer exists and is orphaned.** `computeTrustScore()` at `src/monitoring/anomaly-scorer.js:132` is a real behavioural producer — it derives a score from an anomaly score and a historical trend. But `src/monitoring/anomaly-scorer.js` is imported **nowhere**: the only reference is a comment at `src/api/routes/alerts.js:8`. The value that ships in the JWT claim is `Agent.trustScore` (`src/api/models/Agent.js:88`), which is operator-supplied.

2. **The trust-score consumer is orphaned too.** The routing consumer is `src/routing/heuristic-calculator.js`, whose only importer is `src/routing/pheromone-router.js:28` — and that router is itself imported nowhere. The README already says the router "is built but not yet wired into a runtime path" (`README.md:301`). The calculator's own documentation describes its `trustScore` input as "Anomaly detection trust score from Phase 1.3" (`src/routing/heuristic-calculator.js:29`) — it was written to consume the orphaned producer.

So the entire trust-score chain — producer, carrier and consumer — is orphaned. The quantity is transported and echoed, and read by nobody for a decision.

This is a distinct failure mode from "the feature was never built". It is invisible to a producer-existence check, because a producer exists.

### 1.1 The three defects this ADR remediates

| # | Defect | Where | Consequence |
|---|---|---|---|
| D1 | The shipped quantity is named `trustScore` but is operator-supplied | `src/api/models/Agent.js`, the JWT claim, the API | A reader, a reviewer, or a consuming system reads a derived-sounding name for a configured value |
| D2 | Four mechanisms answer to "blast radius" with four incompatible representations | JWT claim (`[0,1]` default `0.1`), protocol (`'low'`), revocation penalty (`[0,0.5]`), emergency estimate (object) | A consumer cannot tell which it holds; the four paths are statically disconnected so no type checker can catch the collision |
| D3 | The UI treats a `[0,1]` stored value as `0..100` | `src/ui/src/constants/operators.js:97`, `src/ui/src/components/KillSwitchControls.js:60`, `src/ui/src/components/AgentIdentityDashboard.js:66` | A stored `0.85` rendered as "0.85/100" and banded **low**. A fully trusted agent displayed as untrusted |
| D4 | `preview()` is more permissive than `evaluate()` | `src/policies/engine.js:282` | In a default-deny system, an operator reading the preview as the decision believes low-risk tools are allowed when they are denied |
| D5 | The audit chain reports `valid: true` for a log with destroyed records | `src/audit/decision-logger.js:640` | `valid: true` alongside `resyncs: 5` — a caller checking only `valid` reports a damaged log as intact |
| D6 | The credential-rotation guard is unreachable | `src/agents/identity-provider.js:126` | The condition `... && !decoded.rotatedFrom` is unsatisfiable, so a stale token survived a rotation indefinitely |

D6 was found during the same audit and is fixed here because it is a live security defect in the same files.

---

## 2. Decision

We introduce a **governance-quantity provenance** primitive and a registry, and we rename the quantities to match what they actually are.

### 2.1 Three origins, not two

```js
QUANTITY_ORIGIN = { DERIVED: 'derived', DECLARED: 'declared', ORPHANED: 'orphaned' }
```

- **`derived`** — computed from independent evidence by a named producer.
- **`declared`** — supplied by an operator or configuration. No producer exists.
- **`orphaned`** — a producer exists and is implemented, but is **not connected** to this quantity.

`orphaned` is the load-bearing addition. A producer-existence check cannot distinguish it from `derived`, and it is the state AWARE's trust score is actually in. The primitive encodes the distinction so that it cannot be lost again.

### 2.2 The provenance test

For each governance quantity:

| | Question |
|---|---|
| **P1** | Typed — does it have a declared type or schema field? |
| **P2** | Transported — does it cross a serialisation boundary? |
| **P3** | Displayed — does it appear in a user-facing surface? |
| **P4** | Produced — does a function compute it from evidence *independent of the value itself*? |
| **P4b** | **Wired** — is that producer connected to the quantity that ships? |
| **P5** | Consumed — does a decision depend on it? |

**Declared-quantity drift** is `P1 ∧ P2 ∧ (P3 ∨ P5) ∧ ¬P4`. A quantity that is typed, transported and consumed but has no producer is a number that exists only as a number.

P4 has three near-misses that a naive audit accepts, and that this ADR excludes explicitly:

1. **The setter is not the producer.** `updateTrustScore(id, score)` moves a number; it does not derive one.
2. **The echo is not the producer.** Copying a stored field into a JWT claim transports a value; it does not create one.
3. **The default is not a producer.** `agent.metadata.blastRadius || 0.1` is a read with a fallback. A constant is not a function of evidence.

### 2.3 Renames

| Before | After | Rationale |
|---|---|---|
| `trustScore` (the shipped quantity) | `declaredTrustScore` | It is operator-set. The name now says so at every consumption site. |
| `blastRadius` (JWT claim) | `declaredBlastRadiusEstimate` | A supplied estimate in `[0,1]`, not a computed radius. |
| `blastRadius` (kill-signal payload) | `emergencyImpactEstimate` | It **is** a radius-shaped quantity (agents affected, tasks affected). The name now distinguishes it from the numeric forms. |
| `blastRadius` (protocol payload) | `protocolBlastRadiusSeverity` | A severity label, not a number. |
| `blastRadiusPenalty` | unchanged | Already correctly named. |

The four mechanisms are now distinguishable by name, which is the whole point of D2. We chose **distinct names over one unified type** because the four are genuinely different quantities — unifying them behind one type would imply a comparability that does not exist.

### 2.4 Back-compat

The JWT claim rename is wire-visible. Tokens issued before the change carry `trustScore`; tokens issued after carry `declaredTrustScore`. Both identity providers therefore read the new claim and fall back to the legacy one:

```js
declaredTrustScore: decoded.declaredTrustScore !== undefined
  ? decoded.declaredTrustScore
  : decoded.trustScore
```

Token lifetimes are short (v1: 1 h; v2 session: 15 min), so the fallback window is bounded — but it is required for correctness during a rolling restart, where old and new gateways overlap.

### 2.5 The unit fix

The canonical stored unit is the **fraction `[0,1]`** — that is the unit in `src/api/models/Agent.js:88` and `:135`, in the JWT claim, in `src/data/agents.json` (0.5, 0.85, 0.7), and in the routing consumer.

The UI was the sole outlier. We introduce `normaliseTrustScore` / `formatTrustScore` / `bandTrustScore` in `src/governance/quantity.js`, mirrored in `src/ui/src/constants/trust-score.js` for the separate webpack build. The display thresholds are **unchanged** (>80 high, >50 medium, else low) — they are now applied to the percent scale, which is what they always meant.

`normaliseTrustScore` accepts either unit: a value strictly greater than 1 is read as a percent value. This matters because the UI's mock fixtures still carry `92`/`88`/`45` while the real data carries `0.92`/`0.88`/`0.45`.

### 2.6 preview() delegates to evaluate()

`evaluate()` has no side effects — it reads the policy store and the tool catalogue and returns a decision. `preview()` now calls it and derives `wouldBeAllowed` from the returned decision, so the two cannot drift apart.

The preview additionally returns `decision` (the delegated value), so a consumer that wants the reason can read it without a second call.

### 2.7 The chain's integrity summary

`verifyChain()` now returns an `integrity` value:

| Value | Meaning |
|---|---|
| `unbroken` | Every record verified, none lost. |
| `gapped` | The chain verified over what remains, but records were lost. `valid` is still true; the log is not a complete record. |
| `broken` | Hash mismatch or linkage break. |

`valid` is retained for compatibility, but `integrity` is the field a caller should read.

### 2.8 The registry is enforced by tests

`src/governance/registry.js` records the provenance of every governance quantity. `test/unit/governance/registry.test.js` asserts the registry's **claims against the source**:

- `computeTrustScore` exists, and `anomaly-scorer` is imported nowhere → `trustScore` is `orphaned`.
- `pheromone-router` is imported nowhere → the routing consumer is orphaned.
- No writer for `metadata.blastRadius` → the declared estimate is always the `0.1` fallback.
- `_applyBlastRadius` computes a factor → the revocation penalty is `derived`.
- `BlastRadiusEstimator.estimate` counts agents and tasks → the emergency estimate is `derived`.

If someone wires the anomaly scorer in, or adds a writer for `metadata.blastRadius`, **these tests fail and the registry must be corrected.** A provenance claim that nothing checks is worth nothing — this is the "test for producer absence" recommendation from the audit that motivated this work.

---

## 3. Consequences

### Positive

- A reader of any consumption site now sees a name that matches the value's origin.
- The four blast-radius mechanisms are distinguishable by name and by unit.
- The UI shows a fully trusted agent as fully trusted.
- The preview can no longer disagree with the enforcement decision.
- A damaged audit log is no longer reported as intact by `valid: true` alone.
- A stale token no longer survives a credential rotation.
- The provenance of every governance quantity is in one file, and checked against the source.

### Negative / accepted

- **The rename is wire-visible.** Clients reading `trustScore` from the attestation result, the identity-v2 route, or a JWT claim directly must be updated. The back-compat fallback covers *reads of old tokens*; it does not cover *consumers of a renamed response field*. `src/api/routes/identity-v2.js` now emits `declaredTrustScore` and `declaredBlastRadiusEstimate`.
- **The UI duplicates the normalisation helpers.** `src/ui/` is a separate webpack build that cannot import CommonJS from outside `src/ui/`. The duplication is bounded and asserted equal by a parity test.
- **`orphaned` is a new vocabulary term.** It is a third state where most codebases have two. It is justified by the finding: two states cannot express "the producer is real but disconnected", and that is the state this system was in.
- **The `metadata.blastRadius` writer still does not exist.** The rename makes the fallback visible; it does not create a producer. If a real estimate is wanted, that is separate work.

### Not addressed here

- **The anomaly scorer remains orphaned.** This ADR records that fact and tests it. Wiring it to the shipped quantity — and thereby giving `trustScore` a real producer — is a behavioural change to the identity path and needs its own decision.
- **The routing consumer remains orphaned.** `pheromone-router.js` is still not wired into a runtime path, as the README already states.
- **`protocol.calculateBlastRadius()` still returns the literal `'low'`.** It is now named as a severity label and documented as deferred.

---

## 4. Verification

| Check | Result |
|---|---|
| New unit tests | 52, all passing (`test/unit/governance/`) |
| Each new test verified to FAIL against pre-fix code | Yes — 15 of 17 fail at `e9833660`; the 2 that pass are the primitive's own invariants |
| Full unit suite | 1324 tests, 1229 pass, 95 fail |
| Baseline (same tree, peers' untracked files copied in, at `e9833660`) | 1232 tests, 1127 pass, 105 fail |
| New failures attributable to this ADR | **0** |
| Files changed | 20 source files modified; 5 new (`src/governance/quantity.js`, `src/governance/registry.js`, 3 test files, this ADR) |

The 7 names that differ between the baseline and the final run are the sub-test
breakdown of one pre-existing peer failure
(`test/unit/trainer/security-sensitive-diff.test.js`, a peer's untracked file
whose `security_sensitive_diff` rule is not registered in `outcome-filter`).
The failure count is identical in both runs; only the reporting granularity
differs. No file in `src/trainer/` was touched by this ADR.

---

## 5. Alternatives considered

**A. Leave the names, document the gaps.** Rejected: the gap is invisible at
the point of use, which is where it causes harm. A consumer reads
`trustScore` and infers a measurement.

**B. Unify the four blast-radius mechanisms under one type.** Rejected: they
are genuinely different quantities — a supplied estimate, an erosion factor,
an impact record and a severity label. One type would imply a comparability
that does not exist, and would force a lossy conversion.

**C. Implement a trust-score producer and wire it up.** Deferred to its own
ADR. This ADR's scope is making the current state legible and checkable; the
behavioural change to the identity path deserves separate review.

**D. Two origins only (`derived` / `declared`).** Rejected: it cannot
express "the producer exists and is disconnected", which is the finding that
motivated the whole exercise. With two origins, an auditor checking for a
producer would find one and record the quantity as computed.

**E. A linter that infers producers.** Sketched in the audit's §8.6; not
implemented here. The registry tests are a manual version of the same idea,
covering the quantities we know about. A general linter remains worth doing.
