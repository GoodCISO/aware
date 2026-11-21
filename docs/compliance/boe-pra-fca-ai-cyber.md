# PRA / FCA / Bank of England — AI cyber risk and resilience (v1, source UNVERIFIED) — AWARE Coverage

**Last updated:** 2026-11-21
**Source spec:** PRA / FCA / Bank of England, *"Effective practices: cyber risk and resilience management relating to AI"*, 19 November 2026 — **NOT RETRIEVED**
**Spec URL (expected):** https://www.bankofengland.co.uk/prudential-regulation/publication/2026/effective-practices-cyber-risk-resilience-management-relating-to-ai
**Threat-model ADR:** `docs/adr/ADR-084-aware-uk-regulator-ai-cyber-catalog.md`
**Framework entry:** `BOE_PRA_FCA_AI_CYBER` in `src/compliance/framework-mapper.js`
(catalogue: `src/compliance/boe-pra-fca-ai-cyber-catalog.js`; evidence:
`src/compliance/boe-pra-fca-ai-cyber-evidence.js`)

---

## Read this before using anything in this document

**The upstream paper was not retrievable when this catalogue was authored
(2026-11-21).** Every avenue was tried and none produced the document. The
exhaustive list is recorded in the catalogue file header.

Consequently:

- **No regulator text is reproduced anywhere in this catalogue.** Every
  entry's `regulatorText` is `null` and every entry carries
  `sourceStatus: 'UNVERIFIED'`.
- **`paragraphTheme` is a hypothesis.** It is AWARE's characterisation of the
  *expected* subject matter of each numbered paragraph, derived from the
  paragraph numbers the workstream brief supplied and from the control surface
  AWARE actually implements. It is **not** a quotation and **not** a paraphrase
  of the paper.
- **The `awareness` values describe AWARE's own controls.** They say what
  AWARE does — which is measurable in this repository. What is unproven is
  **which paragraph** each AWARE control answers.
- **This document does not assert regulatory compliance and does not claim
  certification.** The paper is non-binding supervisory guidance.

A catalogue that paraphrased paragraphs nobody had read would be a
plausible-looking artefact rather than evidence, and a firm's second line of
defence would rely on it. The honest gap is the correct deliverable until the
paper is in hand.

## Coverage summary

| Metric | Value |
|---|---|
| Paragraphs in scope | 12 (2.3, 4.2, 4.4, 6.6, 7.5, 8.2, 8.5, 9.1, 10.2, 10.4, 10.5, 11.1) |
| AWARE components mapped | 10 of 14 |
| Awareness: `mapped` | 6 — 4.2, 4.4, 6.6, 7.5, 8.2, 10.2 |
| Awareness: `partial` | 6 — 2.3, 8.5, 9.1, 10.4, 10.5, 11.1 |
| Awareness: `gap` | 0 |
| Source status | `UNVERIFIED` — no paragraph text read |
| Binding status | Non-binding supervisory guidance |

The breakdown is **computed** from the catalogue at module load
(`BOE_PRA_FCA_AI_CYBER_AWARENESS_BREAKDOWN`), so the framework block and the
catalogue cannot disagree.

## Paragraph → AWARE control

| Paragraph | Theme (hypothesis) | AWARE control | Awareness | Evidence record type |
|---|---|---|---|---|
| 2.3 | Roles and accountability for AI-related cyber risk | `compliance-mapping`, `agent-registry` | partial | `SYSTEM_LOG` |
| 4.2 | Inventory of AI use cases and supporting systems | `agent-registry`, `compliance-mapping` | mapped | `DATABASE_QUERY` |
| 4.4 | Third-party and model supply-chain risk | `tool-observation-proxy`, `credential-classifier` | mapped | `FILE_SCAN` |
| 6.6 | Access control for AI systems | `tool-access-control`, `permission-model` | mapped | `CONFIG_CHECK` |
| 7.5 | Data governance for AI inputs and outputs | `tool-observation-proxy`, `credential-classifier` | mapped | `SYSTEM_LOG` |
| 8.2 | Logging, monitoring and auditability | `anomaly-detection`, `compliance-mapping` | mapped | `SYSTEM_LOG` |
| 8.5 | State rollback and memory integrity | `kill-switch`, `compliance-mapping` | partial | `SYSTEM_LOG` |
| 9.1 | Revocation and credential cascade | `kill-switch`, `agent-registry`, `identity-provider` | partial | `DATABASE_QUERY` |
| 10.2 | Incident response and kill switch | `kill-switch`, `anomaly-detection` | mapped | `CONFIG_CHECK` |
| 10.4 | Testing and assurance of AI systems | `compliance-mapping`, `anomaly-detection` | partial | `SYSTEM_LOG` |
| 10.5 | Third-party assurance and attestation | `compliance-mapping` | partial | `THIRD_PARTY` |
| 11.1 | Scenario exercises and adversarial validation | `compliance-mapping`, `behavioral-baseline` | partial | `SYSTEM_LOG` |

**Before** this workstream every paragraph was `gap` — the catalogue did not
exist. The "before" column is therefore `gap` for all twelve.

## Why there is no `gap` in the "after" column

A `gap` would mean AWARE has no surface at all for a paragraph. Every one of
the twelve themes has some AWARE surface, so none is a `gap`.

**A `gap` is not a defect in AWARE.** It is a statement that a control is not
a software control — a governance expectation that belongs to the firm's
policy and board rather than to an agent runtime. Marking such expectations
`mapped` on the strength of a compliance dashboard would be the overclaim this
whole workstream exists to prevent. Six of the twelve are `partial` for
exactly that reason: AWARE contributes to the evidence but is not the primary
source of an assurance answer.

## Evidence collection

`src/compliance/boe-pra-fca-ai-cyber-evidence.js` registers one collector per
paragraph against the existing `EvidenceCollector`. Each collector reads a real
subsystem — the agent registry, the policy store, observation state, the skill
scanner, kill-switch state, the audit chain, compliance state and scenario
state — and returns `verified: false` with a reason when the subsystem is not
reachable from the process.

That is the convention the 2026-11-10 collector rewrite established: a
fabricated `true` is not evidence. An honest "not verified" is the point.

## The second-line report

`buildSecondLineReport()` produces a per-paragraph table for a firm's second
line of defence:

| Field | Meaning |
|---|---|
| `paragraph`, `name`, `theme` | the paragraph and its hypothesised subject |
| `awareness`, `crosswalkConfidence` | AWARE's own coverage classification |
| `awareComponents` | the AWARE components that evidence it |
| `evidenceStatus` | `EVIDENCED`, `UNVERIFIED`, `FAILED`, `NO_EVIDENCE` |
| `evidenceRecordCount`, `latestEvidenceId`, `latestCollectedAt` | provenance |
| `reason` | why a collection failed or could not be verified |
| `sourceStatus`, `regulatorText` | the caveat, repeated on every row |

The caveat is repeated per row **on purpose**: a row lifted out of the table
still carries it. The report also carries `sourceVerified`, `sourceCaveat` and
a `nonBindingNotice`.

## When the paper is obtained

Per ADR-084 §D1, a verified paper is a **new catalogue file** and a **new
AWARE release** — not an in-place edit. The v1 file stays in the repository
marked `UNVERIFIED`, so the upgrade path is auditable.

The upgrade replaces `regulatorText: null` with the verbatim first sentence,
sets `sourceStatus: 'VERIFIED'` and `sourceVerifiedAt`, sets a real `pinDate`,
and re-checks every `awareness` value against the paragraph's actual text.
It also replaces the `paragraphTheme` hypotheses with the paper's own section
headings — and re-verifies that the paragraph numbers the brief named are
paragraphs the document actually contains. A paragraph number that does not
exist in the paper is a defect in the brief, not in the code.

## See also

- `src/compliance/boe-pra-fca-ai-cyber-catalog.js` — the catalogue.
- `src/compliance/boe-pra-fca-ai-cyber-evidence.js` — collectors and the second-line report.
- `src/compliance/framework-mapper.js` — the framework block and component mappings.
- `test/unit/compliance/boe-pra-fca-ai-cyber-catalog.test.js` — the pinned contract.
- `docs/adr/ADR-084-aware-uk-regulator-ai-cyber-catalog.md` — the decision record.
