# ADR-081: AWARE editions and the extension contract

**Status:** Accepted
**Date:** 2026-11-16
**Deciders:** Alvin Chang (owner), Archimedes (architecture), Sterling (proposed)
**Supersedes:** none

---

## Context

AWARE is published under Apache-2.0 at `github.com/GoodCISO/aware` and on npm as `@goodciso/aware`. It is a **public** repository. Verified 2026-11-16 via the GitHub and npm registry APIs.

We want to sell a hosted, operated version of AWARE with evidence features that a customer cannot self-host without our operational custody of keys. Specifically, a signed-receipt and Code Provenance service where:

- the customer can verify a receipt with a public key,
- the customer **cannot** mint a receipt that says they complied,
- the receipt is anchored in the core's tamper-evident audit log.

We also want an extension point that a community integrator can use, so the OSS project has a real integration surface rather than a closed one.

Two constraints follow from the licence and the visibility:

1. **Apache-2.0 grants redistribution rights.** Any code placed in the public repo is licensable by every recipient, forever. Private code cannot live there — not behind a feature flag, not behind an env var, not "we just won't publish it". The separation has to be at the **repository** level.

2. **Authentication is not authorisation, but here it is the other way round: proximity is not ownership.** The core's `identity-provider-v2.js` signs with HS256, a symmetric algorithm (`src/agents/identity-provider-v2.js:161-162`). For a self-hosted single-operator deployment that is *correct*: the operator holds the secret and is therefore the attestor. For a hosted multi-tenant service it is *insufficient*: the operator would hold key material that could mint any tenant's identity.

So the split is not tidy organisation. It is what makes the security model correct for each edition.

---

## Decision

### 1. Three repositories

| Repository | Visibility | Licence | Contents |
|---|---|---|---|
| `GoodCISO/aware` | public | Apache-2.0 | The engine, plus the extension contract |
| `GoodCISO/aware-hosted` | private | Commercial | Tenancy, entitlements, signed receipts, evidence packs, Code Provenance |
| Enterprise | deferred | Commercial | See §6 |

The private repository depends on the OSS core as a **published package**. It does **not** vendor, fork, or copy the core tree. A copy is a copy that drifts, and the dependency direction is what makes the separation structural rather than conventional.

### 2. The seam is a public, versioned extension contract

`src/extension/` ships in the OSS core, Apache-2.0, as a documented and semver-stable interface:

- `contract.js` — `AWARE_EXTENSION_CONTRACT_VERSION`, the promised shapes, and `validateExtension()`
- `registry.js` — `ExtensionRegistry`: registration, validation, delivery
- `index.js` — the public entry point

Required methods: `onDecision(event)`, `onAuditAppend(event)`.
Optional methods: `onEngineReady(engine)`, `onShutdown()`.

The contract version is an integer independent of the package version. It is bumped only on a **breaking** change; a breaking change to the contract is a **major** release of the package.

### 3. The core contains no commercial concepts

No plan, tier, entitlement, licence, subscription, or price appears in the core. This is a review-enforced property, not an aspiration. Rationale: the moment the core carries entitlement logic, it can no longer be read as "just the engine", and every OSS release carries a concept it should not.

The commercial boundary is enforced **mechanically**, not by convention:

| Layer | Control | Existing / new |
|---|---|---|
| 1 | `check-public-boundary.mjs` per-file classification, extended with a `commercial` marker | existing, extended |
| 2 | `publish-guard.mjs` asserts the packed tarball contains no commercial-marked file | existing, extended |
| 3 | Private repo depends on the core as a package; never vendors it | new, structural |
| 4 | Private CI runs a contract test against the **latest** published core | new |
| 5 | Entitlements live only in the private layer, fail-closed | new |
| 6 | Repository-level separation | new |

### 4. The extension is an observer, not a participant

An extension receives decisions. It cannot alter them.

The engine hands the extension a **deep copy** (`structuredClone`) of the decision and the request, and returns the original to the caller. This is not theoretical: the contract test found the defect where the live object reference was passed and an extension could rewrite the verdict in place, turning a `DENY` into an `ALLOW`. That is a policy bypass, and it is now closed and regression-tested.

An extension that throws is **contained**: the failure is recorded on the registry and exposed via `getFailures()`, but never propagates into the policy path. A broken extension must never break the engine.

### 5. Signing: HS256 in the core, Ed25519 in the hosted tier

The core keeps HS256 and documents what it means: *the holder of the secret is the attestor.* That is true and appropriate for a self-hosted operator.

The hosted tier uses **Ed25519** with the private key in a KMS/HSM. The customer holds the public key and can verify; Good CISO holds the private key and therefore cannot be impersonated by the customer, and the customer cannot mint a receipt that says they complied. The verifier and the receipt **schema** stay in the OSS core; only the **key custody** is commercial.

### 6. Enterprise is deferred

Enterprise differs from Pro in configuration and deployment (dedicated instance, on-prem, customer-held keys, custom rule sets, retention, SLA), not in code. It ships as a deployment profile over Pro until it needs code the Pro codebase must not contain — the likely triggers are air-gapped packaging, a bespoke SIEM connector set, or customer-held key custody.

### 7. Engine capabilities stay OSS

The policy engine, the full `Decision` enum (including the five-decision expansion that closes the AARM R4 gap), the compliance framework catalogs, the audit hash chain, and the intent-alignment primitive (AARM R3) are **all** Apache-2.0 and ship free.

Pro sells *operations and evidence*, not locked features. A paywalled decision enum or a paywalled framework catalog would make the project a bait-and-switch, which is the failure mode the whole separation design exists to prevent.

---

## Consequences

**Positive**

- The OSS project keeps the engine, the ecosystem, and the credibility. A community integrator has exactly the same surface the commercial tier uses.
- The hosted tier is small (tenancy, entitlements, receipts, evidence), so two repositories do not double the maintenance burden.
- The security model is correct per edition: symmetric for self-hosted, asymmetric for hosted.
- A competitor forking the core gets the engine and none of the evidence service, the key custody, or the UK regulatory positioning.

**Negative**

- Two repositories, two CI pipelines, two release rhythms.
- The private repo cannot use internal core APIs. If the contract proves insufficient, the contract changes and the core releases a new major version.
- Pro cannot ship an engine feature before the core does, or it would be selling something the OSS tier will have for free shortly.

**Neutral / accepted**

- A customer who self-hosts and does not need attestable evidence pays nothing and gets the whole engine. That is correct: they were never a Pro customer.

---

## Alternatives considered

**A. Pro imports private internals from the core.** Rejected. Breaks on every public release; couples the private CI to the core's internals. A public refactor with no semantic change becomes a Pro outage.

**B. The core calls out to a Pro plugin at runtime.** Rejected. Puts the concept of "Pro" inside the OSS core, couples the core to the commercial product, and makes the core impossible to read without commercial knowledge.

**C. One repository, with a `pro/` directory.** Rejected. Apache-2.0 and a public repository mean `pro/` is published and licensable. The separation would be a convention, and conventions do not survive a rushed release.

**D. A separate `aware-enterprise` repository now.** Rejected as premature. Enterprise is configuration and deployment over Pro. A third repo triples the maintenance surface for a difference that is currently one config file. Revisit on the trigger in §6.

**E. Feature flags in the core.** Rejected. Requires the core to contain tier concepts, which is precisely what §3 forbids.

---

## Compliance notes

- This ADR is public. The boundary is public information, and that is what makes the OSS story credible.
- It cites the AARM R1–R6 gap analysis (`AARM-R1-R6-GAP-ANALYSIS.md`) for the R3/R4/R5 gaps it sequences.
- The separation design and roadmap are at `awareness-integration/docs/aware-editions-separation-architecture-2026-11-16.md` and `aware-editions-roadmap-2026-11-16.md`.

## Verification

- `test/unit/extension/extension-contract.test.js` — 21 tests, including the mutation guard and the containment guard.
- `src/extension/` is exercised by a test that drives the real `PolicyEngine`, not a stub.
