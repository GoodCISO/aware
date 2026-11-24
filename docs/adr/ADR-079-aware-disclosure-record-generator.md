# ADR-079 — AWARE Disclosure Record Generator (C1)

**Status:** Accepted
**Date:** 2026-11-11
**Author:** Forge (coder)
**Reviewers:** architect, reviewer
**Task:** `t_01a3dc7e` (AWARE C1 — disclosure record generator), parent `t_13195acc` (Nadella coverage audit)
**Sibling:** `t_3831b5f4` (SPIKE C2 — runtime-behaviour diff; reviewed APPROVED WITH WARNINGS, comment #28597 on `t_306474d9`)
**Verified against:** AWARE `f3cbf486` (main)

---

## 1. Context

`SECURITY.md:55` defines the publication gate — *"Public advisory — after a fix is available
and operators have had ≥14 days to update (HIGH/CRITICAL: ≥7 days)"*. Nothing binds the
hash-chained audit log to that SLA text. The chain is written; the policy is prose; the two
never meet. That is the incident-disclosure half of the coverage audit's *"❌ ABSENT"* marking.

The audit proposed three components (C1 disclosure record generator, C2 runtime-behaviour diff,
C3 destination). C2 was spiked and reviewed; C1 is this ADR.

C1's job: bind `src/compliance/gap-tracker.js` gaps and `src/compliance/framework-mapper.js`
control IDs to an `exportChain(fromId, toId)` window, so the output carries the `prevHash` chain
and a recipient can recompute the hashes rather than trust AWARE's assertion.

## 2. Decision

Ship `src/disclosure/disclosure-record.js`.

### 2.1 The record carries the chain window verbatim

`buildDisclosureRecord({gap, fromDecisionId, toDecisionId, granularity})` returns a record whose
`chain.records` is the exported window, unmodified — including each record's `prevHash` and
`hash`. The record also carries `verification.canonicalisation` (the exact serialisation contract
a verifier must reproduce) and `verification.recompute` (the algorithm).

`verifyChainWindow(record)` recomputes every hash from the carried records. It trusts nothing
the record asserts — not `chain.anchorVerified`, not any hash value. Two failure modes are
distinguished, because they are different defects:

- **Hash mismatch** — a record's own hash does not match its content. The record was altered.
- **Chain break** — a record's `prevHash` does not equal the previous record's hash. A record was
  removed or reordered.

The shipped `verifyChain()` reads the whole on-disk log, not a window, so a window-scoped
verifier is genuinely needed; `verifyFullChain()` is re-exported for the recipient who has the log
file.

### 2.2 Canonicalisation is delegated, not re-implemented

`computeWindowRecordHash()` calls the shipped `canonicalSerialize()` rather than re-deriving it.
This is deliberate and is the one non-obvious implementation choice in the module.

`canonicalSerialize()` serialises a **fixed** field order and **drops** any key outside that set.
A generic "sort the keys" re-implementation would include an extra field and silently disagree
with the stored hash. A verifier that fails on perfectly good records is worse than no verifier:
it trains the recipient to ignore the check. The contract a third party must reproduce is
documented on every record under `verification.canonicalisation`.

The independent stdlib verifier already in the repo (`scripts/verify_chain.py`, from `32081af9`)
mirrors the same rules and is the tool an auditor with only Python should run.

### 2.3 The window anchor is declared, not verified

The first record's `prevHash` points at a record *outside* the window. It cannot be verified from
the window alone — except when it is the genesis hash, which is a known constant rather than a
claim. `chain.anchorVerified` is `true` only in that case. A recipient who needs the anchor
verified runs `verifyFullChain()` against the whole log.

### 2.4 Control IDs are resolved by inversion

A gap carries `frameworkId` + `controlId` — the control that failed. To name a *class* rather
than a bare ID, the module inverts the framework mapper: the components whose mapping covers the
failed control are the components that implement it, and their full control coverage is the class
of control affected. The record carries both `controls` (flat, each with a `source` of `gap` or
`framework-mapper`) and `components`.

This is the class-level mechanism the audit asked for, and it is the reason a P-1 record says
something a P-0 record cannot.

## 3. Publication granularity — the binding constraint

The publication-granularity ladder is **P-0 (existence) / P-1 (class) / P-2 (specific)**. The
state-layer axis is **L-A (baseline) / L-B (operator overlay) / L-C (live state)**. The two axes
are distinct and must never be conflated; the collision was a documented amendment in the C2
spike (`c2-runtime-behaviour-diff-spike-2026-10-12.md` §4.1, amendment m2). The implementation
cards (`t_01a3dc7e`, `t_8a316d11`) reference the legacy names `L-0/L-1/L-2`, so every record
also carries `publication.granularityLegacy` mapping `P-0→L-0`, `P-1→L-1`. Same ladder, two
labels — a rename, not a new axis.

**This module renders P-0 and P-1 only.** `P-2` is refused at the API boundary with an error
naming the three snapshots that would make it truthful (`S-POLICY` / `S-TOOLS` / `S-KILL`).

The refusal is an **error, not a downgrade**. A silent downgrade would let a caller believe it
holds a specific diff while holding a class-level one — the exact failure mode the whole
publication-granularity ladder exists to prevent.

## 4. What this ADR does NOT do

**C1 does not close the incident-disclosure gap.** It mechanises the gap at class granularity.

The C2 spike is explicit: P-1 *"is genuinely weaker than Nadella's ask, and the audit's '❌ ABSENT'
marking should stay until P-2 is reachable — publishing P-1 does not close the gap, it only stops
it from being silent."*

Therefore:

- The audit's *"❌ ABSENT"* marking **stays in every external description** until P-2 is reachable.
- Nothing in the code, the docs, the changelog, or the pitch describes C1 (or C3) as closing the
  incident-disclosure gap.
- Every record carries `publication.statement` asserting non-closure on its face. This is not
  decoration: it is the guarantee that a record forwarded without its surrounding context still
  says what it is.
- C1's existence does not relax the retro-fit urgency. The snapshot window closes with the first
  incident after the C2 spike; the retro-fit window is 27+ days old as of this ADR.

## 5. Failure modes

| # | Failure mode | Handling |
|---|---|---|
| F1 | A caller requests P-2 | Throws, naming the three snapshots. No downgrade. |
| F2 | The chain window is empty | Throws. A record with no window is not verifiable, so it is not a disclosure record. |
| F3 | A record in the window is altered | `verifyChainWindow()` reports a hash mismatch with the offending `decisionId`. |
| F4 | A record is removed or reordered | `verifyChainWindow()` reports a chain break — distinct from F3, because a per-record hash check alone would not catch it. |
| F5 | The anchor is forged | `chain.anchorVerified` is `false` unless the anchor is the genesis hash. The window's internal links still verify; the anchor needs the whole log. |
| F6 | A gap is still open | The prose says so (`"The gap is currently OPEN"`). The record never assumes a remediation the gap tracker does not record. |
| F7 | The failed control maps to no component | The record still binds the gap's own control; `components` is empty. The class is empty, not invented. |

## 6. Consequences

**Positive.** The chain is now quotable as a disclosure record. A recipient recomputes the hashes
instead of trusting an assertion — the property that makes this disclosure rather than a press
release. The gap stops being silent.

**Negative.** The record is weaker than the ask it answers. It says a class failed; it does not
say what changed at runtime. The gap is mechanised, not closed.

**Neutral.** `src/audit/decision-logger.js` is untouched. `action.type` remains a free string; no
enum was added. `SECURITY.md` is untouched — policy text follows the design, and the design is
not finished until P-2 is reachable.

## 7. Alternatives considered

| # | Alternative | Why rejected |
|---|---|---|
| A1 | Render P-2 by best-effort diffing | The snapshots do not exist. The diff would be fabricated — the worst outcome for a disclosure record. |
| A2 | Silently downgrade a P-2 request to P-1 | The caller would believe it holds a specific diff. The error is the safe behaviour. |
| A3 | Re-implement canonicalisation in the disclosure module | Would drift from `canonicalSerialize()`'s fixed-field-set behaviour and fail on valid records. See §2.2. |
| A4 | Extend `verifyChain()` to take a window | `src/audit/decision-logger.js` is explicitly read-only for this card, and its schema is frozen. A window verifier beside it avoids the change. |
| A5 | Modify `SECURITY.md` to describe the mechanism | Forbidden by the card and by the C2 spike's hard constraint. Policy text follows the design. |

## 8. References

- `t_13195acc` — parent: Nadella "Models as Insider Risks" AWARE coverage audit.
- `t_3831b5f4` — sibling: SPIKE C2 runtime-behaviour diff; review verdict on `t_306474d9`
  (comment #28597) — APPROVED WITH WARNINGS, gating answer: proceed to C1/C3 at P-0/P-1 only.
- `src/audit/decision-logger.js` — `exportChain()` `:638`, `verifyChain()` `:562`,
  `canonicalSerialize()` `:77`, `logDecision()` `:401`.
- `scripts/verify_chain.py` — independent stdlib verifier (`32081af9`).
- `tests/audit/fixtures/aware_chain_1k.jsonl` — the 1k-record fixture.
- `src/compliance/gap-tracker.js`, `src/compliance/framework-mapper.js` — the bound sources.
- `SECURITY.md:55` — the publication gate this record is eventually measured against.
