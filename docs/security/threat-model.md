# AWARE Threat Model

This document extends the in-scope threat model in `SECURITY.md` §"Threat
Model (In Scope)" with side-channels that apply to AWARE's interaction
with external services (third-party LLM providers) and to future
self-hosted inference deployments. It is **additive** to the SECURITY.md
table; the table's out-of-scope list (host kernel compromise, privileged
operator, host side-channels like power/EM) is unchanged.

## Scope

In scope for this document:

- **Remote-API side-channels** against hosted LLM providers that AWARE
  agents call as clients (e.g. Google Gemini, Anthropic Claude, hosted
  Llama endpoints). These channels are observable to an attacker who
  can time AWARE's outbound API calls.
- **Future AWARE-hosted spec-dec deployments.** If AWARE ever ships a
  speculative-decoding serving stack, the same class of attack applies
  to AWARE-as-provider, not just AWARE-as-consumer. Mitigations cited
  below cover this path.

Out of scope (re-stated from `SECURITY.md`):

- Host-side side-channels (power analysis, EM, cache-timing on the
  operator's hardware). The threat model still excludes these.
- Compromise of the underlying host kernel or container runtime.
- Compromise of a privileged operator account.

## Remote-API timing side-channels against hosted LLMs

**Reference:** Majidi, Mireshghallah, Taram, "LeakyLMs: Information
Leakage via Timing Side-Channels in Hosted LLM Inference" (2026),
arXiv:2607.20723v1 (CC BY-NC-ND). Paper PDF and supplementary
artefacts were reviewed at SPIKE time; only a citation is reproduced
here.

### Threat

A remote attacker who can observe the per-token response latency of
LLM API calls issued by an AWARE agent can recover information about
the provider's internal deployment, even though the model weights and
system prompts are not exposed. The paper demonstrates two attacks
against real hosted endpoints:

- **Speculative-decoding fingerprinting.** Per-token timing variance
  reveals whether the provider is running speculative decoding with
  a draft model, and the approximate draft-model context length
  (proved on Google Gemini Flash 2.5; the paper reports a ~128K draft
  window).
- **Architectural fingerprinting.** Aggregate timing patterns across
  many requests recover transformer depth (number of layers), hidden
  dimension, and attention-head count. The paper reports >90% top-10
  accuracy on Llama-class models.

### Applicability to AWARE

AWARE agents call third-party LLM providers through the **RLM
primitive** (see `docs/rlm.md:13-17`). The primitive wraps a remote
inference call (HTTP API) and returns the model output to the AWARE
coordinator; the wire format and per-token streaming behaviour are
inherited from the provider's API.

An attacker positioned to time AWARE's outbound API calls (e.g. a
network observer between AWARE and the provider, or a co-tenant on a
shared inference endpoint) can therefore:

- **Fingerprint the provider's deployment.** This is a confidentiality
  loss against the *provider* (reveals their internal architecture),
  not against AWARE.
- **Distinguish which provider / model is in use.** AWARE may rotate
  across providers (`config/rlm.yaml` allows multiple `forwardedOptions`
  targets); an attacker who can fingerprint a specific provider can
  detect when AWARE's traffic is going to that provider. This is
  relevant if an operator is trying to keep provider selection private
  (e.g. during a staged migration).
- **Potentially correlate across requests.** If an attacker can link
  two AWARE calls to the same provider session (e.g. via shared API
  key or IP), they can build a longer timing trace and improve the
  architectural fingerprint.

AWARE's own self-hosted inference stack (the AWARE coordinator + agent
runtime) is **not** directly fingerprintable by this technique: the
default `config/rlm.yaml` does not deploy speculative decoding, and
AWARE serves through its own HTTP API (`src/coordinator/http-server.js`)
without exposing per-token streaming timing at the granularity the
attack requires. The risk is on the **consumer side** — when AWARE
calls out to a third-party LLM API.

### Mitigations

The paper §6 surveys mitigations. For the AWARE consumer-side use
case, the actionable mitigations are:

- **Bulk-batching + jittered emission.** If the operator's threat
  model includes a network observer, batch LLM calls and emit responses
  with added timing jitter to flatten the per-token latency signal.
  The `rlm.forwardedOptions` surface in `config/rlm.yaml` is the
  natural extension point; this would be a follow-up feature, not a
  fix that ships with this threat-model note.
- **Provider selection privacy.** If provider selection is sensitive,
  route calls through a privacy-preserving proxy that does not expose
  per-token timing (e.g. a constant-rate gateway). Out of scope for the
  AWARE core; documented here so operators know to consider it.
- **Pick a provider that already mitigates.** Several providers have
  shipped timing-constant serving (the paper notes at least one major
  provider rolled out constant-rate streaming in 2026). When the
  operator's threat model is "hostile network observer," provider
  selection itself is a control.

For any **future AWARE-hosted spec-dec deployment**, the paper's §6
mitigations apply directly: constant-rate token emission, disabling
draft-model conditional computation, or moving spec-dec to a
hardware-isolated accelerator. These mitigations would land in
`src/coordinator/` and `config/rlm.yaml` at the time such a feature
is designed; they are not in scope for AWARE today.

## Cross-references

- `SECURITY.md` §"Threat Model (In Scope)" — the in-scope/out-of-scope
  table that this document extends.
- `docs/rlm.md:13-17` — RLM primitive and the third-party LLM call path.
- `docs/adr/ADR-047-aware-atlas-v2026.06-coverage.md` — MITRE ATLAS
  coverage. ATLAS techniques cover other LLM attack classes (prompt
  injection, model theft, etc.); remote-API timing side-channels are
  out of ATLAS's current taxonomy and are tracked here separately.
- `docs/security/branch-discipline.md` — public-release gating; this
  document is public-safe (no operator data, no host paths, no LAN
  IPs).

## Re-evaluation triggers

- The LeakyLMs authors publish a follow-up that lowers the timing
  samples required (currently N=order-of-1e3 requests per target).
- A major LLM provider ships a documented timing-constant serving
  mitigation that AWARE can rely on.
- A sibling paper in the same family surfaces (e.g. a new side-channel
  against a different primitive — retrieval, embedding, tool use).
- AWARE ships a speculative-decoding serving stack; the §"Mitigations"
  guidance then becomes a pre-deployment requirement, not a future
  reference.

---

**Author:** coder profile (INTEGRATE child `t_2d958743`, parent
SPIKE `t_e8f2f0d9`).
**Last updated:** 2026-07-27.
**Status:** Awaiting reviewer attestation under EFC v0.2.0
(`risk_class: low`, docs-only).
