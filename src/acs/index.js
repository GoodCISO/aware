// src/acs/index.js
// The public surface of the ACS adapter.
//
// Every ACS-specific export lives behind this module. A host that depends on
// AWARE's ACS support depends on THIS module, not on the internals, so a
// spec bump is a contained change.
//
// CONTAINMENT
// -----------
// Nothing outside src/acs/ and the one mounted HTTP router may import an
// ACS module. See docs/acs/DESIGN.md section 4.1.

'use strict';

const version = require('./version');
const { AcsDecisionEngine } = require('./decision-engine');
const { AcsHostSession, AcsHostResult, buildPolicyInput } = require('./host-adapter');
const { ApprovalSeam, ApprovalStore, ApprovalOutcome } = require('./approval');
const {
  buildReceipt,
  validateReceipt,
  buildDecisionRecord,
  projectVerdict,
  buildVerdictSlot,
} = require('./receipt');
const { failClosed, isFailClosed, isReservedReason } = require('./fail-closed');
const { normalizeVerdict, ACS_DECISIONS, AWARE_DECISIONS } = require('./normalize');
const { resolveTransform, validateTransformPath } = require('./transform');
const { validate, assertValid, SchemaError } = require('./validator');
const { getSchema, getReservedReasons } = require('./schemas');

/**
 * Wire the ACS adapter into AWARE's evidence trail.
 *
 * The receipt is written into the EXISTING hash-chained decision log
 * (src/audit/decision-logger.js). That log is already tamper-evident: each
 * record carries a SHA-256 hash over its canonical form plus the previous
 * record's hash, anchored at a genesis hash, and `verifyChain()` verifies
 * both the per-record hash and the chain linkage.
 *
 * Using it means AWARE needs NO new integrity primitive, and the receipt
 * sits in the same trail as every other AWARE decision.
 *
 * @param {Object} [config] - The wiring configuration.
 * @param {Object} [config.decisionLogger] - The decision logger module. Defaults
 *   to src/audit/decision-logger.js.
 * @param {Function} [config.generateId] - A function returning a unique id.
 *   Defaults to the decision logger's own generateUUID.
 * @returns {{onReceipt: Function}} An object with the receipt sink.
 */
function wireEvidenceTrail(config = {}) {
  // eslint-disable-next-line global-require
  const logger = config.decisionLogger || require('../audit/decision-logger');
  const generateId = config.generateId || logger.generateUUID;

  /**
   * Write one receipt into the decision chain.
   *
   * @param {Object} receipt - The ACS receipt.
   * @param {Object} [meta] - Extra chain metadata.
   * @returns {Promise<string>} The decision id the receipt was written under.
   */
  async function onReceipt(receipt, meta = {}) {
    const decisionId = generateId();
    const record = buildDecisionRecord({
      receipt,
      decisionId,
      parentDecisionId: meta.parentDecisionId || null,
      agentId: meta.agentId || null,
      policyId: meta.policyId || 'acs-adapter',
      outcome: meta.outcome,
    });
    await logger.logDecision(record);
    return decisionId;
  }

  return { onReceipt };
}

module.exports = {
  // Version and pin
  ACS_RELEASE_TAG: version.ACS_RELEASE_TAG,
  ACS_COMMIT: version.ACS_COMMIT,
  ACS_SPEC_VERSION: version.ACS_SPEC_VERSION,
  ACS_ACCEPTED_MANIFEST_VERSIONS: version.ACS_ACCEPTED_MANIFEST_VERSIONS,
  AGENT_HOOKS_COMMIT: version.AGENT_HOOKS_COMMIT,
  INTERVENTION_POINTS: version.INTERVENTION_POINTS,
  ENFORCED_INTERVENTION_POINTS: version.ENFORCED_INTERVENTION_POINTS,
  ENFORCEMENT_MODES: version.ENFORCEMENT_MODES,

  // Engine and host
  AcsDecisionEngine,
  AcsHostSession,
  AcsHostResult,
  buildPolicyInput,

  // Approvals
  ApprovalSeam,
  ApprovalStore,
  ApprovalOutcome,

  // Receipts and evidence
  buildReceipt,
  validateReceipt,
  buildDecisionRecord,
  projectVerdict,
  buildVerdictSlot,
  wireEvidenceTrail,

  // Fail-closed helpers
  failClosed,
  isFailClosed,
  isReservedReason,
  getReservedReasons,

  // Normalisation
  normalizeVerdict,
  ACS_DECISIONS,
  AWARE_DECISIONS,

  // Transform
  resolveTransform,
  validateTransformPath,

  // Validation
  validate,
  assertValid,
  SchemaError,
  getSchema,
};
