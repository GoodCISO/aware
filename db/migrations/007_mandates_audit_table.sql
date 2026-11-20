-- Migration 007: mandates acceptance table
-- Persistence-side half of the AWARE v2 mandate contract
-- (docs/openapi.yaml#/paths/~1v2~1mandates, card t_ae57240e).
--
-- openapi.yaml commits to POST /v2/mandates: 201 Created on acceptance, 409
-- on an idempotency hit against `triggering_event_id`. Without persistent
-- storage the contract is theatre — the coordinator cannot reconcile a
-- retry against the original grant, and nothing can answer "what mandate
-- covers this agent's capability?".
--
-- One row per accepted mandate. `triggering_event_id` is the idempotency
-- boundary: a retry of the same acceptance (coordinator crash mid-write,
-- client replay) hits the UNIQUE constraint and the server answers 409 with
-- the EXISTING grant instead of minting a second one.
--
-- The shape stored here mirrors the wire-level MandateResponse: the server
-- generates `grant_id` and `created_at`, the client supplies the rest.
--
-- Out of scope (other cards): the RiskMandate API CLIENT (AWARE records
-- acceptances; it does not call riskmandate.ai), the RM-side hook, the
-- coordinator trigger logic, and UI mandate-history views.

CREATE TABLE IF NOT EXISTS aware_mandates (
  id                      BIGSERIAL   PRIMARY KEY,

  -- Server-generated grant identity (mirrors openapi.yaml MandateResponse.grant_id)
  grant_id                UUID        NOT NULL UNIQUE,

  -- The AWARE event this mandate answers. UNIQUE = the idempotency guard
  -- behind the 409 path.
  triggering_event_id     TEXT        NOT NULL UNIQUE,
  triggering_event_type   TEXT        NOT NULL,   -- tier_promotion|pre_tool_block|cascade_revoke|spawn_request

  -- Wire-level Mandate fields
  granted_by              TEXT        NOT NULL,   -- owner principal who recorded the acceptance
  scope                   JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- capability identifiers covered by the grant
  expiry                  TIMESTAMPTZ NOT NULL,   -- RFC3339 in, timestamptz out; AWARE has no standing grants
  "interval"              TEXT        NOT NULL,   -- 1h|4h|1d|1w|1m|6m — re-evaluation cadence
  direction               TEXT        NOT NULL,   -- get_more_data|reduce|increase|hold (no "deny" by design)
  underwriters            JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- principals who underwrote the grant
  control_ids             JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- framework control IDs the underwriters' authority derives from

  -- Tri-state: NULL = not computed (the server does not assert a trifecta
  -- verdict it has not derived), true/false = computed.
  lethal_trifecta_flag    BOOLEAN,

  -- Which AWARE constraint tier (T0-T4) the accepting agent holds after the
  -- mandate resolution. Server-set; clients read but do not supply.
  agent_constraint_tier   TEXT        NOT NULL DEFAULT 'T0',

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Operator query: "show me every mandate recorded for this AWARE event".
-- The UNIQUE constraint above already covers the lookup; the index makes it
-- fast without relying on the constraint's index for a covering scan.
CREATE INDEX IF NOT EXISTS idx_mandates_triggering_event
  ON aware_mandates (triggering_event_id);

-- Operator query: "show me this principal's mandate history, newest first"
CREATE INDEX IF NOT EXISTS idx_mandates_granted_by_created
  ON aware_mandates (granted_by, created_at DESC);

-- Operator query: "which mandates are still inside their expiry window?"
CREATE INDEX IF NOT EXISTS idx_mandates_expiry
  ON aware_mandates (expiry);
