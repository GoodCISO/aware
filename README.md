# AWARE — Autonomous Compliance Infrastructure for AI Agents

**Project Key:** `aware`
**Source:** https://github.com/GoodCISO/aware
**License:** Apache-2.0

> AWARE v2.0 — Compliance infrastructure for autonomous AI agents, with a
> self-improving feedback loop. The v2 pipeline (Phase 1 → 5) is in active
> development. v1.0.0 (the bio-inspired routing + compliance layer) is
> shipped to GitHub and continues to run on its own port set (3000, 3001).
> v2 lives in the 18xxx port range and is the focus of this README.

---

## What AWARE Is

AWARE is **open-source autonomous compliance infrastructure for AI agents**.

Autonomous AI agents operate across organisational boundaries, spawn child agents, and make independent decisions. Existing compliance frameworks — SOC 2 checklists, ISO 27001 templates, periodic audits — assume human oversight at every step. They don't apply to systems that act autonomously.

AWARE is different. It's infrastructure that makes compliance happen on its own:

- Every agent gets a **cryptographic identity** it can't fake
- Every action is **evaluated against policy before it executes**
- **Revocation invalidates credentials** — the agent's state flips, its credentials stop verifying, and the decision is written to the audit trail. (Revocation applies to the named agent; cascade to derived agents is specified but not yet implemented.)
- **Full audit trails build themselves** — every decision, every context access, every escalation
- **(v2)** Every preference-pair disagreement becomes **DPO training data** — the system improves itself from real production traffic

AWARE implements **T0–T4 constraint levels** — five enforcement tiers every agent is defined on before it's allowed to act. Agents self-enforce the constraint level you assign. **Enforcement is implemented in `src/policies/engine.js`** (per-tool-call evaluation, `ALLOW`/`DENY`/`AUDIT`/`NO_POLICY`, `DEFAULT_DECISION = DENY`) and is wired into the running server at `/api/policies` and `/api/policies/hot` (`src/api/index.js`, the `npm start` entrypoint). The tiers are surfaced in `src/ui/src/components/ConstraintEnforcementView.js`.

> ⚠️ **`src/server.js` is a demo fixture, not the product.** It injects `mockAgents` ("Add mock agents to make the demo richer") and hardcodes the tier table with `enforced: true` literals. It is not the `npm start` entrypoint and nothing requires it. **Do not use it to verify the T0–T4 claim** — read `src/policies/engine.js`.

- **T0 — Audit Trail.** Every action is logged. Foundational, always on.
- **T1 — Crypto Identity.** Every agent gets a non-human identity it can't fake. Foundational, always on.
- **T2 — Guardrailed.** Operational policies constrain what the agent can do.
- **T3 — Policy-Driven.** Advanced governance — full policy enforcement, including rate limits and decision routing.
- **T4 — Autonomous.** Full self-operation under declared constraints.

**Core thesis:** Bio-inspired coordination algorithms are the right primitive for autonomous agent orchestration and compliance. Pheromone-trail scoring and distributed consensus translate directly to agent governance. The pheromone trail is implemented — revoking an agent applies a blast-radius penalty to its trail; the pheromone router that would steer work by trail strength is built but not yet wired into a runtime path.

---

## Compliance Frameworks

AWARE ships with built-in mapping to **eight** AI and security compliance frameworks. The mapper (`src/compliance/framework-mapper.js`) is the source of truth — every AWARE control is registered against the relevant control IDs in each framework.

| Framework | Version | Coverage |
|---|---|---|
| **CSA AI Controls Matrix (AICM)** | v1 | All 18 domains / 184 verified control IDs (`IAM-*`, `MDS-*`, `DSP-*`, `GRC-*`, …) — see `src/compliance/aicm-v1-catalog.js` |
| **NIST AI Risk Management Framework** | 1.0 | Govern, Map, Measure, Manage — full mapping via `GOVERN`, `MAP`, `MEASURE`, `MANAGE` |
| **ISO/IEC 27001** | 2022 | Access Control (A.9), Operations Security (A.12), Incident Management (A.16) — control-level mapping |
| **ISO/IEC 42001** (AI Management System) | v1.0-2026-07-28 | 38 of 42 Annex A controls (A.5–A.8); `awareness` field tracks mapped/partial/gap — see `src/compliance/iso42001-catalog.js` (ADR-055). Catalog pinned to ISMS.online public mirror; ISO corrigendum = new AWARE release. |
| **DORA** (Digital Operational Resilience Act) | 2022 | Internal Control Frameworks (Art. 12), ICT Incidents (Art. 26), Threat Intelligence (Art. 27) |
| **OWASP Top 10 for LLM Applications** | 2025 | All ten risks (LLM01 Prompt Injection → LLM10 Unbounded Consumption); rebinding from v1.1 (2023) → 2025 spec per ADR-050 §5 GAP-1 — see `docs/compliance/llm-top-10.md`. Deprecated v1.1 IDs preserved at `OWASP_LLM_TOP_10_v1_1` for traceability. |
| **OWASP Agentic Skills Top 10** (AST10) | v1.0-2026 | All ten risks (AST01 Malicious Skills → AST10 Cross-Platform Reuse); behaviour-layer threat model that AWARE's hook-based auto-interception sits in front of — see `src/compliance/ast10-catalog.js` (ADR-048) |
| **OWASP MCP Top 10** | 2025 | Protocol-layer threat model (Model Context Protocol); adjacent to AST10 (behaviour) and LLM Top 10 (model) — see `src/compliance/mcp-top10-catalog.js` (ADR-051) |

Use `src/compliance/framework-mapper.js` as the source of truth for which AWARE controls map to which framework IDs. The companion compliance matrix at `docs/compliance-matrix.md` documents the full mapping in human-readable form.

### What's new in v2.11.0

- **Rebrand:** `aware` → `@goodciso/aware` (npm scope); `alvinchang/aware` → `GoodCISO/aware` (GitHub). Source code unchanged.
- **Three new framework catalogs** added to `framework-mapper.js`: OWASP LLM Top 10:2025 (ADR-050), OWASP MCP Top 10 (ADR-051), ISO/IEC 42001 (ADR-055).
- **AST10 coverage gap closed** (carry-over from v2.10.0) — see ADR-048.
- **Vaara shadow audit adapter merged** (pluggable audit transport; commit `d69ac27`).
- **OSS hygiene:** License cleanup (commit `ebc2b0d`) fixes a latent Apache-2.0 / GPL-3.0 header conflict on `github/main`; tarball down to **452.1 kB** from 88.3 MB pre-cleanup.

---

## AWARE 2.0 — what's new

AWARE 1.0 was the bio-inspired routing + compliance layer (Phases 1–4 of the v1 plan, all shipped). AWARE 2.0 extends that with a **5-stage self-improving feedback loop**:

```
┌──────────────────────────────────────────────────────────────────────┐
│  1. Coordinator       routes /coordinate calls, picks tier,          │
│                        enforces budget + cost cap + kill switch     │
│                                                                      │
│  2. Conversation      logs every /coordinate to Postgres             │
│     Logger            (aware_conversations + aware_preference_pairs) │
│                                                                      │
│  3. PRM Score Cache   caches PRM judge scores by content hash        │
│                        (aware_prm_cache, 30-day TTL default)         │
│                                                                      │
│  4. AZR Self-Play     runs AZR task proposer/solver on Modal A100    │
│                        (gated by `--profile training`)               │
│                                                                      │
│  5. DPO Trainer       packages preference pairs → DPO dataset →      │
│                        submits Modal QLoRA job on trained-model           │
└──────────────────────────────────────────────────────────────────────┘
```

Each stage writes to Postgres; the next stage consumes what the previous wrote. When the loop closes (Phase 4 evaluation harness, not done), we'll have a system that improves itself from real production traffic with no operator intervention.

**Detailed design:** see `redacted-internal-doc` (v2 architecture + where each phase stands today).

---

## Quickstart (v2)

Requires: Docker, Node 22+, curl, npm, jq (for the bring-up script).

```bash
# 1. Clone + enter
git clone https://github.com/GoodCISO/aware
cd aware

# 2. Copy the env template
cp deploy/env.example .env
$EDITOR .env   # uncomment + fill in what you have; defaults are safe for dev

# 3. Validate the config parses
npm run config:validate

# 4. (Optional) Run the test suite — should be green
npm test

# 5. Bring up the v2 stack
./scripts/aware-up

# 6. Verify health
curl -sS http://localhost:18080/health
# {"ok":true,"status":"live"}
```

To also start the trainer poller (Phase 3 AZR self-play):

```bash
./scripts/aware-up --profile training
```

The trainer stays in **disabled-by-config** state until you set `AWARE_TRAINER_ENABLED=1` in `.env` AND run the one-time Modal deploy:

```bash
MODAL_PROFILE=goodciso modal deploy training/run.py
```

See `docs/sop/sop-phase-3-azr-self-play.json` for the full operator-action sequence.

---

## What's done vs. what isn't (honest)

**Done (v2.0, code-complete, tests green, on `feature/aware-2.0`):**

- Phase 1: Coordinator Foundation (`537ea66`)
- Phase 1 polish: ADR (internal) centralised config + `config:show` / `config:validate` (`05a41ff`)
- Phase 2.1: Conversation Logger (Postgres-backed) (`be382b5`)
- Phase 2.2: PRM Score Cache (Postgres + content-hash) (`2a093cf`)
- Phase 2.3: Budget Watchdog (rolling window, soft + hard cap) (`e990303` + `bf6d560`)
- Phase 3: AZR Self-Play on Modal (sandbox + trainer poller + config) (`c572bfd`)
- Phase 3 follow-up: real `modal@0.8.0` JS SDK surface + trained-model base model (`6ff1cd2`)
- R2: real JS SDK surface, `@app.function()` deploy wrapper, real-SDK bring-up smoke (`cbf5511` + `6f15240`)
- Phase 4 first slice: outcome filter + real DPO dataset packaging (`89238df` + `bfe7a5b`)
- Phase 5 R1: `deploy/env.example` (24 v2 env vars documented) (`d58c4b8`) — this commit
- Phase 5 R3: `scripts/aware-up` single-command bring-up (`5fa4f9a`) — this commit

**In progress / not done:**

- Phase 4 remaining: AZR results table + cross-join, coordinator weight-reload hook, evaluation harness, benchmark delta vs. base model
- Phase 5 remaining: fresh-VM-in-30-min test, test coverage ≥80%, dev guide, security audit (bandit/npm audit/gitleaks/trivy), single-binary packaging

**Status tracking:** every phase closure is recorded in `redacted-internal-doc` and mirrored to `redacted-host-config/sops/`. Every phase has a SOP in `docs/sop/`.

**Test coverage:** c8 measures v2 source paths only (coordinator, gateway, db, trainer, budget, config — not v1). Run `npm run coverage` for the full report, `npm run coverage:summary` for a quick per-file table. Current numbers (commit d32d653): **88.42% lines** above the ADR (internal) ≥80% gate. Bring-up smoke 8i (`BRINGUP_FULL=1`) enforces the gate.

**Security audit:** `scripts/security-scan.sh` runs Bandit (Python AST), `npm audit` (Node CVEs), gitleaks (git history), and Trivy (filesystem + Dockerfile) and produces a combined `security-audit-report.txt` + `.json`. Each tool degrades gracefully (skips with warning) if not installed. Default is warn-only; `--strict` promotes warnings to errors. Bring-up smoke 8k (`BRINGUP_FULL=1`) runs it with `--strict`.

---

## Architecture (v2)

```
       Telegram / A2A / curl
                │
                ▼
   ┌──────────────────────────┐
   │  Gateway  :18080         │  ← BFF / proxy, kill switch, CORS, request log
   └──────────┬───────────────┘
              │  /coordinate → COORDINATOR_URL
              ▼
   ┌──────────────────────────┐
   │  Coordinator :18081      │  ← tier routing (online/hybrid/offline)
   │   - budget watchdog      │     cost cap, soft + hard limit
   │   - PRM score cache      │     content-hash keyed, 30-day TTL
   │   - conversation logger  │     aware_conversations + preference pairs
   │   - awareness scoring    │     tier fallthrough with PRM judge
   └──────────┬───────────────┘
              │
              ├──→ Ollama sidecar :11434  (qwen2.5:7b, local fallback)
              ├──→ the provider API            (primary tier, env-var token)
              └──→ <secondary-llm> API            (final fallback)

   ┌──────────────────────────┐         ┌──────────────────────────┐
   │  Postgres  :18432        │         │  Redis  :18379           │
   │   - aware_conversations  │         │   - rate limits          │
   │   - aware_preference_pairs│        │   - session state        │
   │   - aware_prm_cache      │         └──────────────────────────┘
   └──────────┬───────────────┘
              │
              ▼  (poller, --profile training)
   ┌──────────────────────────┐         ┌──────────────────────────┐
   │  Trainer poller          │ ──submit──▶ │  Modal                │
   │   - outcome filter       │             │   - AZR self-play      │
   │   - DPO dataset packager │             │   - QLoRA on trained-model  │
   │   - Modal client (real)  │             │   - weights → /root/   │
   └──────────────────────────┘             └──────────────────────────┘
```

**Key files:**

- `src/coordinator/` — coordinator HTTP service
- `src/gateway/` — gateway HTTP service (BFF)
- `src/budget/` — Phase 2.3 budget watchdog
- `src/prm-cache/` — Phase 2.2 PRM score cache
- `src/logger/` — Phase 2.1 conversation logger
- `src/trainer/` — Phase 3 + 4 trainer poller + outcome filter
- `training/run.py` — Modal QLoRA training function (operator deploys once)
- `eval/` — Phase 4 evaluation harness (scaffold, not started)
- `redacted-internal-doc` — the v2 architecture decision
- `redacted-internal-doc` — centralised config (Phase 1 polish)

---

## Repo layout

```
AWARE/
├── src/                  # v2 source (coordinator, gateway, logger, etc.)
├── training/             # Modal training function (Python)
├── eval/                 # Phase 4 evaluation harness (scaffold)
├── deploy/               # env.example, compose fragments
├── docker/               # Dockerfiles (coordinator, gateway, training)
├── scripts/              # aware-up, bring-up-coordinator.sh
├── config/               # modal-training.json + v2 runtime config
├── docs/
│   ├── adr/              # architecture decision records (reserved directory; current design notes in `redacted-internal-doc`)
│   ├── sop/              # Standard Operating Procedures per phase
│   └── EVOLUTION-BRIEF.md
├── redacted-internal-doc             # closure status of every phase
├── README.md             # this file
├── docker-compose.yml    # v1.0.0 stack (legacy, port 3000/3001)
├── docker-compose.coordinator.yml   # v2 stack (port 18080-18432)
├── .env.example          # v1.0.0 env reference (legacy)
├── deploy/env.example    # v2 env reference (24 vars)
└── package.json          # v2 Node deps
```

---

## Stack

**v1 (shipped):** Node.js, Express.js, React, Material-UI, Docker, Nginx, Raft Consensus, Ant Colony Optimization. Ports 3000/3001/80/443/5001.

**v2 (in development):** Node 22, Postgres 16, Redis 7, Ollama (qwen2.5:7b), Modal (trained-model + A100-80GB), the provider M3 (primary), <secondary-llm> fallback model (fallback). Ports 18080/18081/11434/18432/18379.

**Boundaries:**

- Plugin SDK boundary: v2 extensions cross into core through `<runtime>/plugin-sdk/*` only (inherited from <runtime>, not v1).
- Channel boundary: v1 Telegram bot is in `src/agent.js`; v2 channels (Telegram, A2A) live in `src/channels/`.
- Protocol boundary: gateway schema is contract — additive evolution only.

---

## Quick Links

- **Status:** [redacted-internal-doc](redacted-internal-doc) — closure status of every phase
- **v2 architecture:** [`redacted-internal-doc`](redacted-internal-doc)
- **Dev guide:** [CONTRIBUTING.md](CONTRIBUTING.md) — for anyone reading or modifying v2 source
- **Dev deep dive:** [docs/dev/architecture.md](docs/dev/architecture.md) — pipeline, data flow, trainer lifecycle
- **v1 evolution brief:** [docs/EVOLUTION-BRIEF.md](docs/EVOLUTION-BRIEF.md)
- **SOPs:** [docs/sop/](docs/sop/) — per-phase operator procedures
- **SOP mirror:** `redacted-host-config/sops/` (canonical SOP store)
- **Changelog:** [CHANGELOG.md](CHANGELOG.md)
- **Compliance matrix (v1):** [docs/compliance-matrix.md](docs/compliance-matrix.md)

---

## Enterprise Context

| Vendor | Product | AWARE's Differentiation |
|--------|---------|------------------------|
| Vanta / Drata | Compliance software | They automate checklists. AWARE automates agent governance. Different problem. |
| Microsoft Agent 365 | Agent identity | Bio-inspired coordination at core, not bolted on. Open source. |
| Okta Agent Gateway | Agent access | Kill switch via a Raft-consensus revocation path — not a centralised session kill. |
| Galileo Agent Control | Open runtime | Pheromone-trail blast-radius penalty + autonomous compliance mapping on top. |

**Plus v2:** the self-improving DPO loop means the system gets better the more you use it, without the operator shipping new model versions manually.

---

## Academic Backing

**AMRO-S** (arXiv:2603.12933) — Efficient and Interpretable Multi-Agent LLM Routing via Ant Colony Optimisation:

- Pheromone-based path selection across layered AI agent graphs
- Task-specific pheromone specialists prevent cross-task interference
- Quality-gated evolution reinforces only high-quality routing trajectories
- **4.7x speedup** over existing multi-agent routing with better accuracy

*Those bullets describe AMRO-S, not AWARE. AWARE does not implement pheromone-based path selection: the pheromone trail in the shipped code is the blast-radius penalty applied when an agent is revoked, and the router that would steer work by trail strength (`src/routing/pheromone-router.js`) is built but not yet wired into a runtime path.*

What AMRO-S does NOT address (AWARE's differentiation): security heuristics, identity governance, kill switches, compliance mapping, blast radius containment. And in v2: preference-pair collection, DPO self-training, and the evaluation harness that closes the loop.
