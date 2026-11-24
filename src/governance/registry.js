// src/governance/registry.js
//
// The registry of AWARE's governance quantities and their actual provenance.
//
// WHY THIS FILE EXISTS
// --------------------
// A governance quantity is "typed, transported, and consumed, but not
// computed" — and the type system cannot tell you that. This registry is
// where a reader goes to find out what actually happens to each quantity.
//
// Each entry states the origin. A reader who needs to know whether
// `trustScore` is a measurement or a configuration value reads one line here
// instead of grepping 106 occurrences and classifying them.
//
// The registry is deliberately the single place where provenance lives. If a
// quantity is added elsewhere and not registered here, `assertRegistryCovers`
// (see below) is the test that catches it.
//
// SEE ALSO
// --------
//   src/governance/quantity.js          — the primitive and the origin enum.
//   src/governance/registry.test.js     — the registry's completeness contract.
//   docs/adr/ADR-082-aware-governance-quantity-provenance.md

'use strict';

const {
  QUANTITY_ORIGIN,
  TRUST_SCORE_SCALE,
  BLAST_RADIUS_KIND,
  BLAST_RADIUS_UNITS,
  defineQuantity,
} = require('./quantity');

/**
 * The declared provenance of every governance quantity AWARE ships.
 *
 * @type {Readonly<Record<string, Object>>}
 */
const GOVERNANCE_QUANTITIES = Object.freeze({
  /**
   * The trust score carried in the agent JWT claim and in attestation
   * results.
   *
   * ORIGIN IS 'orphaned', NOT 'declared'.
   *
   * A producer exists and is implemented: `computeTrustScore()` in
   * src/monitoring/anomaly-scorer.js computes a score from an anomaly score
   * and a historical trend. It is real, tested code.
   *
   * But nothing imports that module, so the value that ships in the claim is
   * NOT that score. It is the registry field `Agent.trustScore`
   * (src/api/models/Agent.js), which is operator-supplied — settable via
   * `AgentRegistry.updateTrustScore()` and via the agent-update API route.
   *
   * The routing consumer was written against the orphaned producer —
   * src/routing/heuristic-calculator.js describes its `trustScore` input as
   * "Anomaly detection trust score from Phase 1.3", i.e. the anomaly-scorer
   * output. The wiring gap is visible in the consumer's own documentation.
   */
  trustScore: defineQuantity({
    name: 'trustScore',
    origin: QUANTITY_ORIGIN.ORPHANED,
    unit: TRUST_SCORE_SCALE.UNIT,
    note:
      'Producer computeTrustScore() exists at src/monitoring/anomaly-scorer.js:132 ' +
      'but that module is imported nowhere; the shipped value is the operator-set ' +
      'Agent.trustScore field. Canonical unit is [0,1].',
  }),

  /**
   * The anomaly-detection trust score produced by the anomaly scorer.
   *
   * This one IS derived — but it is derived into nothing, because the module
   * is orphaned. It is registered so the registry describes the whole
   * quantity landscape, and so the two trust scores cannot be conflated.
   */
  anomalyDerivedTrustScore: defineQuantity({
    name: 'anomalyDerivedTrustScore',
    origin: QUANTITY_ORIGIN.DERIVED,
    unit: TRUST_SCORE_SCALE.UNIT,
    producer: 'computeTrustScore',
    note:
      'Computed at src/monitoring/anomaly-scorer.js:132 from anomalyScore and ' +
      'historicalTrend. The module is currently imported nowhere, so this value ' +
      'does not reach any shipped quantity.',
  }),

  /**
   * The blast-radius estimate read into the v2 JWT claim.
   *
   * Operator-supplied, with a hardcoded fallback of 0.1. No writer for
   * `agent.metadata.blastRadius` was found in the identity or registry code.
   */
  declaredBlastRadiusEstimate: defineQuantity({
    name: 'declaredBlastRadiusEstimate',
    origin: QUANTITY_ORIGIN.DECLARED,
    unit: 'fraction',
    note:
      'Read at src/agents/identity-provider-v2.js:145 as ' +
      '`agent.metadata.blastRadius || 0.1`. No writer for metadata.blastRadius ' +
      'was found, so the fallback is the effective value.',
  }),

  /**
   * The penalty factor applied to a revoked agent's trail.
   *
   * Derived from the revocation severity — this IS computed. But it is not a
   * radius over affected agents or resources; it is an erosion factor for one
   * agent's own trail. The distinct name prevents it being read as a radius.
   */
  revocationTrailPenalty: defineQuantity({
    name: 'revocationTrailPenalty',
    origin: QUANTITY_ORIGIN.DERIVED,
    unit: 'fraction',
    producer: '_applyBlastRadius',
    note:
      'Computed at src/agents/revocation-cache.js:191 from the revocation severity ' +
      '(CRITICAL 0.0, HIGH 0.1, MEDIUM 0.3, LOW 0.5). Erodes the revoked agent\'s ' +
      'own trail; does not describe a radius over other agents.',
  }),

  /**
   * The emergency kill-scope impact estimate.
   *
   * Derived, and genuinely a radius-shaped quantity: it counts affected agents
   * and tasks. It is an object, not a number, and is not comparable with the
   * fractional forms.
   */
  emergencyImpactEstimate: defineQuantity({
    name: 'emergencyImpactEstimate',
    origin: QUANTITY_ORIGIN.DERIVED,
    unit: BLAST_RADIUS_UNITS[BLAST_RADIUS_KIND.EMERGENCY_IMPACT],
    producer: 'BlastRadiusEstimator.estimate',
    note:
      'Computed by src/emergency/blast-radius-estimator.js from the agent registry ' +
      'and task queue. Reports agentsAffected, tasksAffected, businessImpact and ' +
      'affectedServices.',
  }),

  /**
   * The legacy protocol-level blast-radius label.
   *
   * A constant with no computation behind it. Retained for wire
   * compatibility; carries no numeric meaning.
   */
  protocolBlastRadiusSeverity: defineQuantity({
    name: 'protocolBlastRadiusSeverity',
    origin: QUANTITY_ORIGIN.DECLARED,
    unit: BLAST_RADIUS_UNITS[BLAST_RADIUS_KIND.PROTOCOL_SEVERITY],
    note:
      '`calculateBlastRadius()` at src/agents/protocol.js:347 returns the literal ' +
      "'low'. Placeholder pending a real implementation; not a numeric quantity.",
  }),

  /**
   * The routing heuristic's blast-radius input.
   *
   * A supplied estimate in [0,1]. The calculator treats it as an input and
   * inverts it; it does not estimate it.
   */
  routingBlastRadiusEstimate: defineQuantity({
    name: 'routingBlastRadiusEstimate',
    origin: QUANTITY_ORIGIN.DECLARED,
    unit: 'fraction',
    note:
      'Input to src/routing/heuristic-calculator.js, which inverts it as ' +
      '`1 - blastRadiusEstimate` and weights it at 0.10. Supplied by the caller.',
  }),

  /**
   * The number of records the audit chain verified.
   *
   * Derived and genuinely counted. Listed here because it is a governance
   * quantity in the same sense: it evidences a control.
   */
  auditRecordsVerified: defineQuantity({
    name: 'auditRecordsVerified',
    origin: QUANTITY_ORIGIN.DERIVED,
    unit: 'count',
    producer: 'verifyChain',
    note:
      'Counted at src/audit/decision-logger.js:584 during chain verification.',
  }),

  /**
   * The number of records skipped because a torn write left them unreadable.
   *
   * Derived. This is the counter that a `valid: true` boolean can hide, and
   * it is the reason chain verification now reports integrity separately from
   * parseability.
   */
  auditSkippedRecords: defineQuantity({
    name: 'auditSkippedRecords',
    origin: QUANTITY_ORIGIN.DERIVED,
    unit: 'count',
    producer: 'verifyChain',
    note:
      'Counted at src/audit/decision-logger.js during chain verification. Non-zero ' +
      'means the log has damage even when the chain over parseable records verifies.',
  }),

  /**
   * The number of chain resyncs after a torn write.
   *
   * Derived. See auditSkippedRecords.
   */
  auditResyncs: defineQuantity({
    name: 'auditResyncs',
    origin: QUANTITY_ORIGIN.DERIVED,
    unit: 'count',
    producer: 'verifyChain',
    note:
      'Counted at src/audit/decision-logger.js during chain verification. Non-zero ' +
      'means a record was destroyed and the chain was re-anchored at the surviving ' +
      'record\'s own prevHash.',
  }),
});

/**
 * Look up a quantity descriptor by name.
 *
 * @param {string} name
 * @returns {Object|undefined}
 */
function getQuantity(name) {
  return Object.prototype.hasOwnProperty.call(GOVERNANCE_QUANTITIES, name)
    ? GOVERNANCE_QUANTITIES[name]
    : undefined;
}

/**
 * Every quantity whose origin is not 'derived'.
 *
 * These are the quantities a reader must not describe as measurements. The
 * list is the operational output of the audit: it is short, and every entry
 * has a documented reason.
 *
 * @returns {Object[]}
 */
function listNonDerivedQuantities() {
  return Object.values(GOVERNANCE_QUANTITIES).filter(
    (q) => q.origin !== QUANTITY_ORIGIN.DERIVED
  );
}

/**
 * A machine-readable provenance report for every governance quantity.
 *
 * Intended for an audit endpoint or an evidence export: it lets an assessor
 * ask "which of these are computed?" and get an answer that traces to code.
 *
 * @returns {Object[]}
 */
function provenanceReport() {
  return Object.values(GOVERNANCE_QUANTITIES).map((q) => ({
    name: q.name,
    origin: q.origin,
    unit: q.unit,
    producer: q.producer,
    note: q.note,
  }));
}

module.exports = {
  GOVERNANCE_QUANTITIES,
  getQuantity,
  listNonDerivedQuantities,
  provenanceReport,
};
