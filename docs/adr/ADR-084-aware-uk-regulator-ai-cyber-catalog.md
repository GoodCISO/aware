# ADR-084 — PRA / FCA / Bank of England AI cyber-risk catalogue (v1, source UNVERIFIED)

**Status:** Proposed (2026-11-21)
**Author:** Alfie (orchestrator)
**Reviewers:** required — Archimedes (architect), Critic (reviewer), Sentinel (auditor)
**Supersedes:** nothing
**Related:** ADR-055 (ISO/IEC 42001 catalogue — the pattern this follows), ADR-078 (edge-revocation monitor — the authority-graph analysis WS2 depends on), ADR-083 (generated compliance matrix), `src/compliance/framework-mapper.js`, `src/compliance/evidence-collector.js`, `src/compliance/boe-pra-fca-ai-cyber-catalog.js`, `src/compliance/boe-pra-fca-ai-cyber-evidence.js`

---

## 1. Context

The workstream this ADR governs is to produce control-level evidence that a UK
financial services firm follows the PRA / FCA / Bank of England paper
*"Effective practices: cyber risk and resilience management relating to AI"*
(19 November 2026, non-binding). The deliverable is a control catalogue that a
firm's second line of defence can rely on.

**The upstream paper could not be retrieved.** As of 2026-11-21 every avenue was
tried and none produced the document. The exhaustive list is recorded in the
catalogue file header (`src/compliance/boe-pra-fca-ai-cyber-catalog.js`) so a
future session does not have to rediscover the failure by repeating it:

| Avenue | Result |
|---|---|
| `bankofengland.co.uk/prad/publication/2026/effective-practices-cyber-risk-resilience-ai` | 404 |
| `bankofengland.co.uk/prudential-regulation/publication/2026/...` | 404 |
| `bankofengland.co.uk/-/media/boe/files/prudential-regulation/publication/2026/...pdf` | 404 |
| `fca.org.uk/publications/corporate-documents/effective-practices-cyber-risk-...-ai` | 404 |
| `fca.org.uk/publications/finalised-guidance/...` | 404 |
| `fca.org.uk/publications/policy-statements/...` | 404 |
| `pra.org.uk` | unreachable |
| `bankofengland.co.uk/search` | 200, JS-driven, no results in raw HTML |
| `bankofengland.co.uk/sitemap.xml` | 500 |
| FCA `p_search_term` search, FCA AI page, FCA AI Lab, "How our rules apply to AI" | loaded; no link to the paper |
| Google, Bing, DuckDuckGo (html + lite), Startpage, Mojeek | no primary document, no secondary quotation |
| Two independent delegated research passes (web + browser) | both NOT FOUND |
| Law-firm and trade commentary (Norton Rose, Latham & Watkins, Addleshaw Goddard, Finextra, Regulation Tomorrow, Lexology) | no document, no paragraph quote |
| Local repository, `docs/`, `research-notes/`, `threats/`, Downloads, Desktop, Documents | no local copy |

### 1.1 The consequence, stated plainly

The ground rule for this workstream is **quote regulator text exactly**. A
catalogue that paraphrased paragraphs the author could not read would be a
plausible-looking artefact rather than evidence, and a firm's second line of
defence would rely on it. That is a worse outcome than an honest gap.

Therefore **this catalogue carries no verbatim regulator text**. Every entry's
`regulatorText` is `null` and every entry carries `sourceStatus: 'UNVERIFIED'`.

What the catalogue *does* assert is **AWARE's own control surface**, which is
measurable in this repository and does not depend on the paper. The `awareness`
value of each entry says what AWARE does, not what the paper says. What is
unproven is **which paragraph** each AWARE control answers.

### 1.2 What this ADR is and is not

This ADR pins the *shape* and the *provenance discipline* of the catalogue. It
does not assert what the paper requires. Any consumer of this catalogue — the
evidence collector, the report generator, the second-line export — must surface
the caveat. The caveat is carried in three places so it cannot be lost by
accident:

1. on every catalogue entry (`sourceStatus`, `regulatorText: null`);
2. on the framework block in `framework-mapper.js` (`sourceVerified`,
   `sourceCaveat`);
3. on the second-line report (`sourceVerified`, `sourceCaveat`,
   `nonBindingNotice`).

---

## 2. Decision

### D1 — A verified paper is a NEW catalogue file, not an edit in place

When the paper is obtained, the upgrade is a new file
(`boe-pra-fca-ai-cyber-catalog-v2.js`), a new framework block version, and a
new AWARE release. This file stays in the repository, marked `UNVERIFIED`, so
the upgrade path is auditable.

**Why:** the same pin discipline as ADR-055 §D1 (an ISO corrigendum is a new
AWARE release, not an in-place edit). It also means the v1 catalogue keeps
honouring the commitment it makes today: it describes exactly what was known
on 2026-11-21.

### D2 — The catalogue holds twelve paragraph entries, in the paper's numeric order

`2.3, 4.2, 4.4, 6.6, 7.5, 8.2, 8.5, 9.1, 10.2, 10.4, 10.5, 11.1` — the twelve
paragraphs the workstream brief specified. The list is frozen and the order is
the paper's own numeric order (not alphabetical), because a reader comparing
against the paper will read them in sequence.

### D3 — Entry shape and awareness classes

Every entry carries:

| Field | Meaning |
|---|---|
| `name` | short AWARE-facing title for the paragraph |
| `description` | what AWARE's control does (≤200 chars, first-party wording) |
| `awareness` | `mapped` \| `partial` \| `gap` — AWARE's coverage of its own surface |
| `awareComponents` | AWARE component IDs from `AWARE_COMPONENT_MAPPINGS` |
| `crosswalkConfidence` | `H` \| `M` \| `L` |
| `paragraph` | the paragraph number, repeated inside the entry |
| `paragraphTheme` | AWARE's characterisation of the paragraph's EXPECTED subject matter — **a hypothesis, not a quotation and not a paraphrase** |
| `regulatorText` | verbatim text from the paper, or `null` while unverified |
| `sourceStatus` | `UNVERIFIED` \| `VERIFIED` |
| `sourceUrl` | the canonical URL the paper is expected at |
| `sourceVerifiedAt` | the fetch date, or `null` while unverified |

#### Awareness classes

`mapped` means AWARE directly emits the evidence for that paragraph's theme.
`partial` means AWARE contributes but is not the primary evidence source.
`gap` means there is no AWARE surface.

**The breakdown is 6 `mapped`, 6 `partial`, 0 `gap`.** There is no `gap`
because every one of the twelve themes has some AWARE surface — but six are
only partially covered, and the test pins the exact membership of each class
so a silent reclassification fails the build.

A `gap` is not a defect in AWARE. It is a statement that a control is not a
software control at all — a governance expectation that belongs to the firm's
policy and board, not to an agent runtime. Marking those as `mapped` on the
strength of a compliance dashboard would be the overclaim this whole ADR
exists to prevent.

### D4 — The caveat travels with the framework

`FRAMEWORKS.BOE_PRA_FCA_AI_CYBER` exposes `sourceVerified` and `sourceCaveat`
alongside `controls` and `controlIds`. A downstream report that renders these
controls MUST surface the caveat; a report that renders the controls without
it would be asserting conformance to a document nobody has read.

`pinDate` is `null` for the same reason there is no verified fetch date.

### D5 — Component mappings

Ten AWARE components map to the framework:

| Component | Paragraphs |
|---|---|
| `agent-registry` | 2.3, 4.2, 9.1 |
| `anomaly-detection` | 8.2, 10.2, 10.4 |
| `kill-switch` | 8.5, 9.1, 10.2 |
| `identity-provider` | 9.1 |
| `tool-access-control` | 6.6 |
| `tool-observation-proxy` | 4.4, 7.5 |
| `compliance-mapping` | 2.3, 4.2, 8.2, 8.5, 10.4, 10.5, 11.1 |
| `credential-classifier` | 4.4, 7.5 |
| `permission-model` | 6.6 |
| `behavioral-baseline` | 11.1 |

### D6 — Evidence collection reads live state, and the second-line report states the source status


`src/compliance/boe-pra-fca-ai-cyber-evidence.js` registers one collector per
paragraph against the existing `EvidenceCollector`. Each collector reads a real
subsystem (agent registry, policy store, observation state, skill scanner,
kill-switch state, audit chain, compliance state, scenario state) and returns
`verified: false` with a reason when the subsystem is not reachable from the
process.

That convention is inherited from the 2026-11-10 rewrite of the default
collectors, which replaced hardcoded `true` values with real reads. A
fabricated `true` is not evidence.

`buildSecondLineReport()` emits one row per paragraph with the evidence
status (`EVIDENCED`, `UNVERIFIED`, `FAILED`, `NO_EVIDENCE`), the source
status, and the caveat repeated on every row — a row extracted from the table
still carries it. The report carries a `nonBindingNotice` because the paper
is supervisory guidance and the report is not a compliance opinion.

---

## 3. Consequences

### 3.1 What this fixes

- AWARE carries a ninth compliance framework, registered in the mapper with
  the same shape as the ISO/IEC 42001 block, with an awareness breakdown that
  is **computed from the catalogue** rather than asserted, so the two cannot
  disagree.
- Every paragraph has a live-state evidence collector, so the dashboard
  reports measured coverage rather than coverage nobody has inspected.
- A second-line export exists that a firm can hand to its assurance function.

### 3.2 What this does NOT do — stated on the artefact itself

- **It does not evidence conformance to the paper.** The paper has never been
  read. The catalogue is a control-surface map with a hypothesis about
  paragraph subject matter.
- **It does not assert regulatory compliance**, and it does not claim
  certification of any kind. The paper is non-binding supervisory guidance.
- **It is not the final deliverable.** It is the part of the deliverable that
  can be built without the paper.

### 3.3 Risks

| Risk | Mitigation |
|---|---|
| A consumer renders the controls as verified evidence | The caveat is on every entry, on the framework block, and on every report row; a test asserts the framework exposes it |
| The `awareness` values are treated as a claim about the paper | The catalogue header states they describe AWARE's own surface; D6 pins the exact membership in a test |
| The paper is never obtained and the catalogue is cited anyway | `sourceStatus: 'UNVERIFIED'` is on every entry and `sourceVerified` is `false` at the framework level |
| The unverified catalogue is edited in place later | D1: a verified paper is a new file and a new release |
| Paragraph subject matter is wrong when the paper arrives | The hypothesis is explicitly labelled, and the awareness values are re-checked against the real text as part of the v2 upgrade |

---

## 4. Verification

```bash
node --test test/unit/compliance/boe-pra-fca-ai-cyber-catalog.test.js
node scripts/generate-compliance-matrix.js --check   # the matrix is current
bash scripts/aware-test-run.sh                        # the whole unit suite
bash scripts/pre-commit-check.sh                      # ADR + privacy gates
```

The catalogue test asserts: the twelve IDs and their order; the entry shape
(§D3); the awareness breakdown and the exact membership of each class (§D6);
that the catalogue is frozen; that the framework block carries the §D4 shape;
that `getFrameworkControls()` enumerates all twelve with the full entry shape;
that every `awareComponents` reference resolves to a real component; that
every component mapping resolves via `componentCoversControl`; that no
component references a paragraph that is not in the catalogue; and that the
catalogue remains marked `UNVERIFIED` while the paper is unretrieved.

---

## 5. Future work

- **Obtain the paper** and land the v2 catalogue (§D1): verbatim `regulatorText`,
  `sourceStatus: 'VERIFIED'`, `sourceVerifiedAt`, a real `pinDate`, and a
  re-check of every `awareness` value against the actual text.
- Replace `paragraphTheme` hypotheses with the paper's own section headings.
- When the paper lands, re-verify that the paragraphs named in the brief are
  the paragraphs the catalogue claims — a paragraph number that does not exist
  in the document is a defect in the brief, not in the code.
