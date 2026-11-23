# ACS support in AWARE

AWARE can act as a conformant **Agent Control Specification (ACS)** policy
decision engine, and can emit ACS receipts into its own evidence trail.

ACS separates decisions from enforcement. The engine returns a verdict; the
host enforces it. AWARE already worked that way, so this is an adapter and
conformance job, not a redesign.

- **Pinned upstream:** ACS `v0.4.0-beta.2` @
  `b11ae38b1bd53d299789c1724f4f94f80a0c6540`. See `VERSION`.
- **Design and findings:** `DESIGN.md`.
- **Conformance statement:** `CONFORMANCE.md`.
- **Vendored schema provenance:** `VENDORED.md`.

---

## What is supported

| Area | Status |
| --- | --- |
| Canonical ACS policy input (five members) | Supported, validated against the pinned schema |
| Intervention points `pre_tool_call`, `post_tool_call`, `output` | Enforced |
| The other five intervention points | Accepted; a well-formed verdict is returned and recorded |
| Verdicts `allow`, `deny`, `transform` | Supported |
| `warn` / `escalate` intents | Normalised to `allow` + a warning, and `deny` + an approval block |
| `enforce` and `evaluate_only` modes | Supported |
| Transform (`$target`-rooted) | Supported |
| Human approval seam (request, resolution, echo rule) | Supported |
| Receipts into the AWARE hash chain | Supported |
| ACS manifest import (`extends` chains) | **Not yet** — Phase 3 |
| Export AWARE policies as ACS manifests | **Not yet** — Phase 3 |
| Rego / OPA policy bundles | **Not yet, and optional** — Phase 3 |

---

## The verdict mapping

AWARE's own vocabulary is `ALLOW` / `DENY` / `AUDIT` / `NO_POLICY`. ACS's
normalised verdict set is `allow` / `deny` / `transform`. The mapping is
total and lives in exactly one place, `src/acs/normalize.js`.

| AWARE | ACS verdict | Extra members |
| --- | --- | --- |
| `ALLOW` | `allow` | — |
| `AUDIT` | `allow` | `warnings[]` with one entry (the `warn` intent) |
| `NO_POLICY` | `allow` | `warnings[]` with one entry |
| `DENY` (no approval) | `deny` | — |
| `DENY` (approval required) | `deny` | `approval` block — a **liftable** deny |
| kill switch active | `deny` | `reason: kill_switch_active` |
| a transform was requested | `transform` | `transform: {path, value}` |

**The ACS verdict enum has five values, not three.** `warn` and `escalate`
are *policy-language intents* that the runtime normalises: `warn` becomes
`allow` carrying a warning, and `escalate` becomes `deny` carrying an
approval block (ACS SPEC section 13). A conformant adapter therefore never
emits `warn` or `escalate` as a decision.

---

## Quickstart

### As a library

```js
const { AcsHostSession } = require('@goodciso/aware/src/acs');

const session = new AcsHostSession({ agentId: 'email-agent', sessionId: 's-1' });

const result = await session.preToolCall({
  toolName: 'send_email',
  args: { to: 'customer@example.com', body: 'Status update' },
  callId: 'call-1',
});

if (!result.mayExecute) {
  // The host does NOT carry out the action.
  //
  // Branch on `mayExecute`, NOT on `permits`. `permits` reports what the
  // DECISION was; `mayExecute` reports whether that decision is binding.
  // In `evaluate_only` mode the decision is still computed and recorded,
  // but it is not a permission, so `mayExecute` is false there.
  console.log(result.verdict.decision, result.verdict.reason);
  return;
}

// The host applies the transform, if the verdict carried one.
const enforcedArgs = result.transformedPolicyTarget ?? args;
await sendEmail(enforcedArgs);
```

### Over HTTP

The router is mounted at `/api/acs`, behind the existing `authenticateToken`
middleware.

```bash
curl -X POST http://127.0.0.1:3000/api/acs/evaluate \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $AWARE_TOKEN" \
  -d '{
    "intervention_point": "pre_tool_call",
    "tool_name": "send_email",
    "snapshot": { "tool_call": { "name": "send_email", "args": { "to": "a@b.c" } } },
    "agent_id": "email-agent"
  }'
```

`GET /api/acs/spec` returns the pinned versions, the accepted intervention
points, the enforcement modes and the registered reserved reasons.

---

## Fail closed

**Every** error path yields a `deny` carrying a registered
`runtime_error:*` reason. There is one constructor for that,
`src/acs/fail-closed.js`, and it refuses a reason that is not registered.

The fail-closed suite drives fault injections (an engine that throws, a
kill-switch probe that throws, an approval seam that throws, malformed
input, an unknown intervention point, an expired or rejected approval, an
identity mismatch, a forbidden transform root, an invalid receipt) and
asserts each one denies with a registered reserved reason. It also scans
the adapter source for any catch block that returns an `allow`, because a
behavioural test cannot see a path that no injection reaches.

This is the **issue-#83 guard**. That upstream issue is titled "Bundled
Cedar dispatcher evaluates with `Context::empty()`, so every context-gated
`forbid` in the shipped cedar-lib silently never fires" — a policy that
should have denied returned `allow`, with no error and no warning.

---

## Receipts and evidence

Every evaluation produces an ACS receipt. A receipt is a **payload-free**
record: it carries the decision, the reason, the intervention point, the
mode and a timestamp, but not the tool arguments and not the transform
payload.

The receipt lands in AWARE's existing hash-chained decision log
(`src/audit/decision-logger.js`), so the trail is tamper-evident with no
new integrity primitive, and the receipt is linked to the eventual
execution outcome through `parentDecisionId`. One trail runs
**policy → decision → action → result**.

The receipt schema is the Agent Hooks *interception record*, because ACS
defines the receipt by reference to AGENT-HOOKS-0.1 section 10.3 rather
than shipping its own copy. It is vendored, with its commit pinned.

---

## Known gaps

1. **ACS manifests are not imported yet.** The adapter consumes a policy
   input, not a manifest. Manifest import, `extends` chains and manifest
   export are Phase 3. Today AWARE's own policy store remains the policy
   source.
2. **Rego and Cedar are not evaluated by the adapter.** The adapter is a
   decision engine over AWARE's existing policy engine, not a policy
   language implementation. Rego evaluation through OPA is Phase 3 and is
   **optional**: a user who does not use Rego does not need OPA.
3. **The identity provider is null.** The receipt schema requires the
   identities to be null when the provider is null, so AWARE declares a
   null provider. AWARE's own crypto identity provider
   (`src/agents/identity-provider-v2.js`) is not yet shown to produce
   ACS content-derived identities.
4. **Policy precedence is undefined.** ACS fixes the evaluation order
   *within* one evaluation. It does not say how an ACS manifest's policies
   combine with AWARE's per-agent policies. The current behaviour is that
   AWARE's policy engine evaluates first and its verdict wins on a deny.
5. **The approval store is in-memory.** The default `ApprovalStore` keeps
   requests in process memory. The audit trail is durable regardless,
   because every approval event is written to the chain.
6. **Streaming is out of scope.** ACS section 18.1's incremental stream
   profile is not adopted. AWARE evaluates whole snapshots.

---

## Layout

```
src/acs/
  version.js         the pinned upstream versions
  schemas.js         loads the vendored schemas
  validator.js       the JSON Schema subset validator (no new dependency)
  fail-closed.js     the single fail-closed verdict constructor
  normalize.js       the total AWARE decision -> ACS verdict mapping
  transform.js       $target-rooted transform path handling
  approval.js        the approval request and resolution seam
  decision-engine.js the ACS decision engine
  receipt.js         the ACS receipt and its chain record
  host-adapter.js    the AGT-shaped host adapter
  index.js           the public surface
src/api/routes/acs.js  the HTTP transport
docs/acs/schemas/       the vendored schemas
```

Nothing outside `src/acs/` and the one mounted router imports an ACS
module. A spec bump touches `src/acs/version.js`, the vendored schemas and
the drift-test hash table — nothing else.
