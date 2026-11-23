# ACS conformance statement

**Subject:** the ACS adapter in `src/acs/`, on branch `feat/acs-support`,
based on `github/main` = `df9483f3` (v2.12.2).

**Pinned upstream:** Agent Control Specification `v0.4.0-beta.2` @
`b11ae38b1bd53d299789c1724f4f94f80a0c6540`.
Agent Hooks `7e13a74b34af30f2049d902cc656c247c81d2f95`.

**The claim this document makes:** AWARE acts as a conformant ACS policy
decision engine and emits conformant ACS receipts into its own evidence
trail. Every row below names the test that proves it. A row with no test is
not claimed.

---

## 1. Intervention points

| Intervention point | Supported | Proven by |
| --- | --- | --- |
| `pre_tool_call` | Enforced | `test/unit/acs/decision-engine.test.js` — "an ALLOW decision becomes an allow verdict" |
| `post_tool_call` | Enforced | `test/unit/acs/host-adapter.test.js` — "the post-tool-call point produces a verdict" |
| `output` | Enforced | `test/unit/acs/host-adapter.test.js` — "the output point produces a verdict" |
| `agent_startup` | Accepted, verdict returned, recorded | `test/unit/acs/decision-engine.test.js` — "the other five intervention points return a well-formed verdict" |
| `input` | Accepted, verdict returned, recorded | same |
| `pre_model_call` | Accepted, verdict returned, recorded | same |
| `post_model_call` | Accepted, verdict returned, recorded | same |
| `agent_shutdown` | Accepted, verdict returned, recorded | same |
| An unknown point | Denied | `test/unit/acs/decision-engine.test.js` — "an unknown intervention point denies" |

All eight are the closed enum from the pinned
`interception-point.schema.json`. The adapter reads that enum from
`src/acs/version.js`, which is pinned alongside the schemas.

---

## 2. Verdicts

| Verdict | Supported | Proven by |
| --- | --- | --- |
| `allow` | Yes | `test/unit/acs/decision-engine.test.js` |
| `deny` | Yes | `test/unit/acs/decision-engine.test.js` |
| `transform` | Yes | `test/unit/acs/email-tool.test.js` — "a tracking token is redacted and the tool receives the redacted body" |
| `warn` (intent) | Normalised to `allow` + `warnings[]` | `test/unit/acs/decision-engine.test.js` — "an AUDIT decision becomes an allow carrying a warning" |
| `escalate` (intent) | Normalised to `deny` + an `approval` block | `test/unit/acs/decision-engine.test.js` — "an approval requirement produces a liftable deny" |
| The adapter never emits `warn` or `escalate` as a decision | Yes | `test/unit/acs/decision-engine.test.js` — "the adapter never emits warn or escalate as a decision" |
| Every verdict carries a reason | Yes | `test/unit/acs/decision-engine.test.js` — the reason assertions on each case |

---

## 3. Modes

| Mode | Supported | Proven by |
| --- | --- | --- |
| `enforce` (the default) | Yes | `test/unit/acs/decision-engine.test.js` — "the default mode is enforce" |
| `evaluate_only` computes the same verdict and records it, without blocking | Yes | `test/unit/acs/decision-engine.test.js` — "evaluate_only computes and records the same verdict without blocking" |
| The mode is recorded on the receipt | Yes | same |
| An unknown mode is refused | Yes | `test/unit/acs/decision-engine.test.js` — "an unknown mode denies" |

`evaluate_only` does not change the verdict computation. It changes only
whether the host acts. That is asserted by comparing the two modes'
verdicts and reasons directly.

---

## 4. Fail-closed coverage

**This is the class that ACS issue #83 belongs to.** That issue is titled
"Bundled Cedar dispatcher evaluates with `Context::empty()`, so every
context-gated `forbid` in the shipped cedar-lib silently never fires". A
policy that should have denied returned `allow`, silently.

| Failure path | Denies | Proven by |
| --- | --- | --- |
| The policy engine throws | Yes | `test/unit/acs/fail-closed.test.js` — "every fault injection denies with a reserved reason" |
| The policy engine returns nothing | Yes | same |
| The policy engine returns a non-object | Yes | same |
| The policy engine returns an unknown decision | Yes | same |
| The kill-switch probe throws | Yes | same |
| The approval seam throws while creating a request | Yes | same |
| The kill switch is active | Yes | `test/unit/acs/decision-engine.test.js` — "a kill switch signal denies before any policy is consulted" |
| No agent identity, so the kill switch cannot be evaluated | Yes | `test/unit/acs/adversarial-review.test.js` — "regression CRITICAL-2: the kill switch must be consulted when no agent id is supplied" |
| A revoked agent at an unenforced intervention point | Yes | `test/unit/acs/adversarial-review.test.js` — "regression HIGH-2: a revoked agent is denied at an UNENFORCED intervention point" |
| A policy `DENY` that also carries a transform | Yes | `test/unit/acs/adversarial-review.test.js` — "regression CRITICAL-1: a DENY carrying a transform must NOT become a permitting transform" |
| A malformed (non-object) transform body | Yes | `test/unit/acs/adversarial-review.test.js` — "regression HIGH-1: a malformed transform body must fail closed, not be dropped" |
| An unknown member on the policy output | Yes | `test/unit/acs/adversarial-review.test.js` — "regression HIGH-3: an unknown member on the policy output must be rejected" |
| A reserved-prefixed `reason` or `warnings[].reason` | Yes | `test/unit/acs/adversarial-review.test.js` — "regression HIGH-4: a reserved-prefixed reason must be rejected" |
| The runtime-owned `evidence_truncated` warning reason | Yes | `test/unit/acs/adversarial-review.test.js` — "regression HIGH-4: a warnings entry may not use the runtime-owned evidence_truncated reason" |
| An unknown member on a `warnings` entry | Yes | `test/unit/acs/adversarial-review.test.js` — "regression HIGH-3: a warnings entry with an unknown member must be rejected" |
| A re-resolution of an already-resolved approval | Yes | `test/unit/acs/adversarial-review.test.js` — "regression MEDIUM-3: a resolved approval must not be re-resolved to an approval" |
| A non-string approval context identity | Yes | `test/unit/acs/adversarial-review.test.js` — "regression MEDIUM-4: a non-string context identity must be rejected" |
| A malformed policy input (7 shapes) | Yes | `test/unit/acs/fail-closed.test.js` — "a malformed policy input denies" |
| An expired approval | Yes | `test/unit/acs/fail-closed.test.js` — "an expired approval denies" |
| A rejected approval | Yes | same suite — "a rejected approval denies" |
| An unresolved approval | Yes | same suite — "an unresolved approval denies" |
| An approval identity mismatch | Yes | same suite — "an approval identity mismatch denies" |
| An unknown approval request | Yes | same suite — "resolving an unknown approval request denies" |
| An unknown intervention point | Yes | `test/unit/acs/decision-engine.test.js` |
| An unknown enforcement mode | Yes | `test/unit/acs/decision-engine.test.js` |
| A forbidden transform root | Yes | `test/unit/acs/transform.test.js` — "any other root fails closed with transform_target_forbidden" |
| The retired transform root | Yes | `test/unit/acs/transform.test.js` — "the RETIRED \$policy_target root fails closed with transform_invalid" |
| A transform path that does not resolve | Yes | `test/unit/acs/transform.test.js` — "a path that does not resolve fails closed" |
| An unknown member on the transform body | Yes | `test/unit/acs/transform.test.js` — "a missing path or value member fails closed with policy_output_invalid" |
| A schema the validator cannot fully implement | Refused | `test/unit/acs/validator.test.js` — "an UNSUPPORTED keyword is refused, not ignored" |
| The fail-closed constructor refuses an unregistered reason | Yes | `test/unit/acs/fail-closed.test.js` — "failClosed rejects an unregistered reason" |

**The source scan.** `test/unit/acs/fail-closed.test.js` — "no adapter
module catches an error and returns an allow". A behavioural test only sees
the fault paths it injects. This scan reads every file in `src/acs/` and
fails if a catch block returns an `allow`. A future edit that adds such a
catch fails the suite even if no test reaches it.

**The reserved-reason guarantee.** Every fail-closed reason comes from the
pinned `reserved-reasons.json`, and the constructor throws on any other
reason, so a fail-closed verdict can never be mistaken for a policy reason.

---

## 5. Schemas

| Artefact | Validated against | Proven by |
| --- | --- | --- |
| The policy input | `policy-input.schema.json` | `test/unit/acs/decision-engine.test.js`; the malformed-input suite |
| The verdict | `verdict.schema.json` | `test/unit/acs/validator.test.js` — "every pinned ACS schema is fully supported" |
| The receipt | `interception-record.schema.json` | `test/unit/acs/receipt.test.js` — "the receipt validates against the pinned receipt schema" |
| The result envelope | `result.schema.json` | `test/unit/acs/validator.test.js` |
| The request envelope | `request.schema.json` | `test/unit/acs/validator.test.js` |
| The snapshot | `snapshot.schema.json` | `test/unit/acs/validator.test.js` |
| The manifest | `manifest.schema.json` | `test/unit/acs/validator.test.js` |
| The approval seam | `approval.schema.json` | `test/unit/acs/validator.test.js` |

**The drift test.** `test/unit/acs/schema-drift.test.js` recomputes the
SHA-256 of every vendored schema and compares it against a pinned table.
The table is the authority — it is NOT read from `docs/acs/VERSION`,
because a test that reads its expectation from the file it is checking
proves nothing. `docs/acs/VERSION` is checked separately, so a version
bump that forgets to update the hashes is caught.

**The unsupported-keyword guard.** `test/unit/acs/validator.test.js`
proves the validator REFUSES a schema it cannot fully implement, rather
than ignoring the keyword. A validator that ignores a keyword passes
documents it never really checked.

---

## 6. Receipts in the evidence trail

| Property | Proven by |
| --- | --- |
| Every evaluation produces a receipt | `test/unit/acs/receipt.test.js` — "the engine writes a receipt through the onReceipt hook" |
| The receipt lands in the existing hash-chained decision log | same suite — "the receipt lands in the hash-chained decision log" |
| The chain still verifies afterwards | same suite — the `verifyChain()` assertion |
| The receipt is linked to the execution outcome | same suite — "the receipt links to the execution outcome" |
| The receipt identifies the policy, version, point, verdict, mode and timestamp | same suite — "the receipt identifies the policy, version, point, verdict, mode and timestamp" |
| The receipt is payload-free (no transform body) | same suite — "the receipt is payload-free" |
| The approval block is stripped to presence only | same suite — "the approval block is stripped to presence only" |
| A receipt-write failure does not change the verdict | same suite — "a receipt write failure does not change the verdict" |

The tamper-evidence mechanism is AWARE's **existing** one: the SHA-256
hash chain in `src/audit/decision-logger.js`, with a genesis anchor and a
`verifyChain()` routine. No new integrity primitive was introduced.

---

## 7. Transforms

| Property | Proven by |
| --- | --- |
| A `$target` path is accepted | `test/unit/acs/transform.test.js` |
| The retired `$policy_target` root fails closed with `transform_invalid` | same suite |
| Any other root fails closed with `transform_target_forbidden` | same suite |
| A path that does not resolve fails closed | same suite |
| The original target is never mutated | same suite — "applying a transform does NOT mutate the original target" |
| The runtime returns the transform UNAPPLIED; the host applies it | `test/unit/acs/email-tool.test.js` — "the transform path is rooted at \$target, not the retired \$policy_target" |
| The host receives the transformed target | same suite — "a tracking token is redacted and the tool receives the redacted body" |

---

## 8. Approvals

| Property | Proven by |
| --- | --- |
| A request carries an identity, a status and an expiry | `test/unit/acs/approval.test.js` |
| Approving lifts the deny | same suite — "approving lifts the deny" |
| Rejecting leaves the deny standing | same suite |
| An unresolved approval leaves the deny standing | same suite |
| The identity mismatch is rejected (the echo rule) | same suite |
| An expired request cannot be approved | same suite |
| The identity is content-derived, covering nested content | same suite — "the context identity is content-derived" |
| A null identity echoes as null | same suite |
| An event-listener failure does not break the verdict | same suite |

---

## 9. The reference example

Microsoft's `examples/acs-email-tool` is reproduced end to end with AWARE
as the engine, covering all three outcomes.

| Outcome | Proven by |
| --- | --- |
| `allow` — an internal recipient, the body unchanged | `test/unit/acs/email-tool.test.js` — "an internal recipient is allowed and the body is unchanged" |
| `transform` — a tracking token is redacted before the tool runs | same suite — "a tracking token is redacted and the tool receives the redacted body" |
| `deny` — an external recipient, and the tool never runs | same suite — "an external recipient is denied and the tool never runs" |
| The external-domain check is case-insensitive | same suite |
| Every outcome produces a validating receipt | same suite |

**One deliberate divergence from upstream.** AGT's example returns the
transform path `"$policy_target.body"`. Under the pinned spec that is the
**retired** root and MUST fail closed with `runtime_error:transform_invalid`
(ACS SPEC section 3.2), so the upstream example's transform case cannot
pass against a conformant runtime. AWARE uses `"$target.body"`. See
`DESIGN.md` finding F-2.

---

## 10. Transports

| Transport | Proven by |
| --- | --- |
| The canonical input is assembled from a host-shaped body | `test/unit/acs/http-route.test.js` |
| A canonical five-member body passes through unchanged | same suite |
| The public library surface is the AGT-shaped host adapter | `test/unit/acs/email-tool.test.js` (the session is the adapter) |

---

## 10a. The adapter against the REAL AWARE policy engine

Every other ACS suite uses a stub policy engine. A stub proves the
adapter's own logic; it cannot prove the adapter works with the engine it
actually ships against. `test/unit/acs/real-engine.test.js` closes that
gap.

| Property | Proven by |
| --- | --- |
| The adapter evaluates a real AWARE decision and yields a conformant verdict | `test/unit/acs/real-engine.test.js` — "the adapter evaluates a REAL AWARE policy decision" |
| The real engine's default deny is preserved, not softened into an allow | same suite — "the real engine default is a DENY, and the adapter preserves it" |
| Every member the real engine returns passes the normaliser's member check | same suite — "the real decision shape passes the member check" |

This suite exists because the adversarial review found a case the stub
suites could not: the real engine returns `{decision, reason, policyId,
riskLevel, requiresApproval}`. When the normaliser was taught to reject
unknown policy-output members, those AWARE-internal members had to be
allowed explicitly, or the adapter would have rejected every REAL
decision while every stub test still passed.

---

## 10b. Policy interoperability (Phase 3)

| Property | Proven by |
| --- | --- |
| The exported manifest validates against the PINNED manifest schema | `test/unit/acs/manifest.test.js` — "the exported manifest validates against the PINNED manifest schema" |
| The exported manifest passes the adapter rules | same suite |
| AWARE binds through the `custom` policy branch and its own adapter name | same suite — "the exported manifest binds AWARE through the custom adapter" |
| The exported manifest binds the three enforced intervention points | same suite |
| The exported manifest survives a YAML round trip unchanged | same suite — "the exported manifest renders as YAML and reparses to the same value" |
| The upstream `acs-email-tool` manifest parses | same suite — "the upstream acs-email-tool manifest parses" |
| A manifest naming an unknown adapter is REFUSED | same suite |
| A manifest binding an undefined policy is REFUSED | same suite |
| A manifest with a disallowed path root is REFUSED | same suite |
| A manifest with an unsupported spec version is REFUSED | same suite |
| A child manifest merges over a parent | same suite — "a child manifest merges over a parent" |
| A conflicting intervention point is a MERGE CONFLICT | same suite — "a conflicting intervention point is a MERGE CONFLICT" |
| A local `extends` chain resolves | same suite — "a local extends chain resolves" |
| An UNPINNED remote parent is REFUSED | same suite |
| A remote parent with no fetcher is REFUSED | same suite |
| An unreadable local parent is REFUSED | same suite |
| An `extends` chain deeper than the limit is REFUSED | same suite |
| **ROUND TRIP: AWARE → manifest → AWARE gives IDENTICAL verdicts on the corpus** | same suite — "ROUND TRIP: AWARE -> manifest -> AWARE gives IDENTICAL verdicts on the corpus" |
| The bridge REFUSES a manifest binding an unenforced point | same suite |
| The bridge FAILS CLOSED when the manifest target does not resolve | same suite |
| The manifest routes work over real HTTP | `test/unit/acs/http-manifest.test.js` |

**The round-trip corpus.** A round trip over one case proves nothing, so
the corpus covers six cases: `allow`, `deny`, `audit`, `no_policy`,
`transform`, and `deny` with an approval requirement. Each is evaluated
directly and then through the exported-and-reimported manifest, and the
decision and the reason must match.

**The YAML subset.** `src/acs/yaml.js` refuses anchors, aliases, tags, block
scalars, multi-document streams and tab indentation. A parser that guesses
at those can change the meaning of a policy document, so guessing is not an
option. JSON is a subset of YAML and loads unchanged.

---

## 11. What is NOT claimed

These are **not** implemented and are **not** claimed:

1. **Evaluating Rego or Cedar policy bundles.** The adapter is a decision
   engine over AWARE's existing policy engine, not a policy language
   implementation. A manifest may DECLARE a rego or cedar policy, and the
   adapter refuses such a manifest, because it cannot evaluate it. OPA
   stays optional and this is deferred.
2. **Fetching a remote `extends` parent over the network.** The resolution
   path accepts a pinned remote parent through an injected fetcher, and it
   REFUSES an unpinned one. The adapter does not ship a network client for
   this, so a host must supply the fetcher.
3. **The incremental stream profile** (ACS section 18.1).
4. **A non-null identity provider.**
5. **A durable approval store.** The default is in-memory; the audit trail
   is durable regardless.
6. **A CI job.** The repository has no test-running CI on the public tree:
   its CI surface is the four-layer PRIVACY filter (the pre-commit and
   pre-push hooks, the gitea pre-receive, and the gitea
   lint-private-data workflow), not a test runner. This branch therefore
   ships `scripts/verify-acs-conformance.sh`, the single command that
   proves the ACS conformance claims, designed to be callable FROM a CI
   job when one is added. Wiring it into the gitea pipeline is the one
   remaining operational step, and it is not done here.
7. **Interoperation with a live Microsoft Foundry or AGT deployment.** The
   conformance claim is against the pinned specification schemas and the
   upstream reference example, not against a running hosted service.
8. **Defined precedence** between ACS manifest policies and AWARE's own
   per-agent policies. The manifest selects and configures AWARE's policy
   engine; it does not add a second evaluator.

---

## 12. How to run these tests

```bash
# The ACS suites. 186 tests.
node --test 'test/unit/acs/*.test.js'

# The whole unit suite.
npm test

# The ACS conformance gate: the single command that proves every claim in
# this document.
npm run verify:acs
```

**The conformance gate.** `scripts/verify-acs-conformance.sh` runs six
checks: the vendored schemas match the pinned SHA-256 table; the pinned
commit is recorded; every artefact validates against the pinned schema;
the vendored MIT notice is present; the ACS suites pass; and no adapter
path catches an error and returns an `allow`.

The last check is the issue-#83 guard at the SOURCE level, complementing
the behavioural suite: a behavioural test only sees the paths it injects,
while the scan sees the code.

The gate was checked for meaningfulness by planting a fail-open catch
block in the decision engine. It failed with exit 1, on both the source
scan and the behavioural suites. The mutation was reverted and the gate
returned to exit 0.

It also has a `--json` mode for a CI job:

```bash
bash scripts/verify-acs-conformance.sh --json
```

**Measured results on this branch** (`df9483f3` base, Node v26.13.0, macOS):

| Suite | Tests | Pass | Fail |
| --- | --- | --- | --- |
| `test/unit/acs/` | 186 | 186 | 0 |
| `test/unit/**` (whole) | 1063 | 1049 | 14 |
| `test/integration/**` | 28 | 21-22 | 5-6 |

**No regressions.** The base commit `df9483f3`, measured in a separate
worktree in the same environment, gives **877 tests / 863 pass / 14 fail**.
This branch gives **1063 / 1049 / 14**. The failing set is **identical** —
the failing lines were diffed in both directions and the set difference is
empty. All 186 new ACS tests pass, and nothing that passed before fails
now.

> The original baseline (877 / 840 / 37) was taken before the out-of-tree
> `rl-pipeline` sibling checkout existed at `/tmp/rl-pipeline`. The
> coordinator resolves that sibling by a relative path, so 23 of its tests
> were failing for want of it and now pass. That is an environment change,
> not an ACS change, and it affects the base commit equally — which is why
> the comparison above is a like-for-like measurement of the base commit
> taken in the current environment. `BASELINE.md` records both.

The remaining 14 unit failures and the integration failures are
pre-existing and environmental: missing optional dependencies
(`src/ui/node_modules`) and missing deploy fixtures. They fail identically
on `df9483f3` without any ACS code. `BASELINE.md` records the full
baseline.

---

## 13. A note on the runtime

The adapter materialises each receipt through
`JSON.parse(JSON.stringify(receipt))`. That is right on its own merits — a
receipt is a JSON wire artefact, so the JSON data model is its canonical
form — and it also avoids a runtime defect measured on this host under
Node v26.13.0, where a plain property read of a freshly constructed object
can intermittently return `undefined`. `DESIGN.md` section 11 records the
measurement, and the receipt tests read members through the same JSON model
so they stay consistent with the production path.
