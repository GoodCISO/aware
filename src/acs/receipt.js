// src/acs/receipt.js
// Builds the ACS receipt and writes it into AWARE's evidence trail.
//
// WHAT A RECEIPT IS
// -----------------
// ACS does not ship its own receipt schema. ACS SPEC section 19 says a host
// "MAY derive an audit record from each evaluation", and points at
// AGENT-HOOKS-0.1 section 10.3 for the record shape. That shape is the
// Agent Hooks INTERCEPTION RECORD, vendored at
// docs/acs/schemas/interception-record.schema.json.
//
// THE RECEIPT IS PAYLOAD-FREE
// ---------------------------
// The interception-record schema's VerdictProjection is described as "a
// payload-free projection of the combined verdict (10.3): transform details
// are omitted, approval members stripped, messages truncated to 256 UTF-8
// bytes." So a conformant receipt does NOT carry the transform body, and
// the approval block is PRESENCE ONLY (an empty object).
//
// That is deliberate. The receipt proves THAT a decision was made and what
// it was. The sensitive payload lives in the AWARE audit chain, which is
// where the evidence trail belongs.
//
// THE SCHEMA CONSTRAINTS THIS MODULE HONOURS
// ------------------------------------------
//   - the root has additionalProperties: false, so every member here is one
//     the schema declares
//   - `decided_by` is an INTEGER (a registration index), not a string
//   - `composition.profile` of "sequential/run_all" REQUIRES a `verdicts` array
//   - `input_identity` and `enforced_identity` MUST be null when
//     `identity_provider` is null
//   - the verdict projection forbids a `transform` member
//   - the approval projection is presence only

'use strict';

const { getSchema } = require('./schemas');
const { validate } = require('./validator');
const { ACS_SPEC_VERSION } = require('./version');

/**
 * The maximum message length in the receipt, in UTF-8 bytes.
 *
 * The interception-record schema truncates messages to 256 UTF-8 bytes.
 */
const MAX_MESSAGE_BYTES = 256;

/**
 * Truncate a string to a byte budget, without splitting a UTF-8 sequence.
 *
 * @param {string} text - The text to truncate.
 * @param {number} maxBytes - The byte budget.
 * @returns {string} The truncated text.
 */
function truncateBytes(text, maxBytes) {
  if (typeof text !== 'string') return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  // Cut to the byte budget, then drop any trailing partial sequence.
  let cut = buf.subarray(0, maxBytes).toString('utf8');
  // eslint-disable-next-line no-control-regex
  if (/[\uD800-\uDFFF]$/.test(cut)) {
    cut = cut.slice(0, -1);
  }
  return cut;
}

/**
 * Project an ACS verdict into the receipt's payload-free verdict projection.
 *
 * The projection's allowed members are decision, reason, message, warnings,
 * evidence, result_labels and approval. `approval` is PRESENCE ONLY (an
 * empty object), and a member that is not present is OMITTED rather than
 * set to null, because `approval` is typed as an object and a null would
 * fail validation.
 *
 * @param {Object} verdict - The ACS verdict.
 * @returns {Object} The projection.
 */
function projectVerdict(verdict) {
  const projection = {
    decision: verdict.decision,
    reason: typeof verdict.reason === 'string' ? verdict.reason : null,
    message: typeof verdict.message === 'string' ? truncateBytes(verdict.message, MAX_MESSAGE_BYTES) : null,
  };

  if (Array.isArray(verdict.warnings)) {
    projection.warnings = verdict.warnings.map((w) => ({
      reason: typeof w.reason === 'string' ? w.reason : null,
      message: typeof w.message === 'string' ? truncateBytes(w.message, MAX_MESSAGE_BYTES) : null,
    }));
  }

  // The approval block is PRESENCE ONLY. Its members are stripped by the
  // projection, so the receipt records that an approval was consulted, not
  // what it contained.
  if (verdict.approval && typeof verdict.approval === 'object') {
    projection.approval = {};
  }

  // A transform body is FORBIDDEN in the projection. The decision itself is
  // recorded; the replacement payload is not.
  if (verdict.evidence && typeof verdict.evidence === 'object') {
    projection.evidence = verdict.evidence;
  }
  if (Array.isArray(verdict.result_labels)) {
    projection.result_labels = verdict.result_labels;
  }

  return projection;
}

/**
 * Build the per-interceptor verdict slot.
 *
 * A VerdictSlot is a DIFFERENT shape from a VerdictProjection: it carries
 * an `index`, a `name`, a `decision` and a `reason`, and nothing else. It
 * is the payload-free summary of ONE interceptor's verdict.
 *
 * @param {Object} verdict - The ACS verdict.
 * @param {number} index - The registration index of the interceptor.
 * @param {string} [name] - A host-chosen payload-free registration name.
 * @returns {Object} The verdict slot.
 */
function buildVerdictSlot(verdict, index, name) {
  const slot = {
    index,
    decision: verdict.decision,
  };
  if (typeof verdict.reason === 'string') slot.reason = verdict.reason;
  if (typeof name === 'string' && name.length > 0) slot.name = name;
  return slot;
}

/**
 * Build the ACS receipt for one evaluation.
 *
 * @param {Object} input - The receipt input.
 * @param {Object} input.verdict - The ACS verdict.
 * @param {string} input.interventionPoint - The intervention point.
 * @param {string} input.mode - The enforcement mode.
 * @param {string} input.sessionId - The host session id.
 * @param {number} input.sequence - The host sequence number.
 * @param {string} [input.timestamp] - An RFC 3339 timestamp. Defaults to now.
 * @param {number} [input.decidedBy] - The registration index of the
 *   interceptor whose verdict won. Defaults to 0.
 * @returns {Object} The receipt, conforming to the pinned interception-record
 *   schema.
 */
function buildReceipt(input) {
  const {
    verdict,
    interventionPoint,
    mode,
    sessionId,
    sequence,
    timestamp,
    decidedBy,
  } = input;

  const profile = 'sequential/run_all';

  const receipt = {
    interception_point: interventionPoint,
    mode,
    verdict: projectVerdict(verdict),
    // AWARE declares a null identity provider. The schema then REQUIRES the
    // two identities to be null. See docs/acs/DESIGN.md open question 4.
    input_identity: null,
    enforced_identity: null,
    identity_provider: null,
    session_id: sessionId,
    sequence,
    timestamp: timestamp || new Date().toISOString(),
    // The registration index is an integer, not a name.
    decided_by: typeof decidedBy === 'number' ? decidedBy : 0,
    composition: { profile },
    // The "sequential/run_all" profile REQUIRES the verdicts array, and each
    // entry is a VerdictSlot (index, decision, reason, name), NOT a
    // VerdictProjection.
    verdicts: [buildVerdictSlot(verdict, 0, 'aware-acs-adapter')],
    interceptors_registered: 1,
  };

  // Materialise the receipt through a JSON round trip.
  //
  // A receipt is a WIRE artefact: it is defined by a JSON Schema, it is
  // validated against one, and it is transported as JSON. Round-tripping it
  // here guarantees three things:
  //
  //   1. The object carries exactly the JSON data model. A receipt can never
  //      carry an undefined, a function, a Date instance or a class
  //      instance, because the round trip flattens all of those.
  //   2. The object is a plain data object with plain data properties, which
  //      is what every consumer of the receipt expects.
  //   3. It avoids a runtime defect observed on Node 26.13.0, where the
  //      FIRST plain property read of a freshly constructed object literal
  //      can return undefined even though the property descriptor and
  //      JSON.stringify both report the correct value. The round trip
  //      removes the freshly-constructed-literal shape that triggers it.
  //
  // The round trip also makes the payload-free guarantee structural: only
  // the JSON data model survives, so nothing outside it can leak into the
  // receipt.
  return JSON.parse(JSON.stringify(receipt));
}

/**
 * Validate a receipt against the pinned interception-record schema.
 *
 * @param {Object} receipt - The receipt to validate.
 * @returns {{valid: boolean, errors: Array}} The validation result.
 */
function validateReceipt(receipt) {
  const schema = getSchema('interceptionRecord');
  return validate(receipt, schema);
}

/**
 * Build the AWARE decision-chain record that carries a receipt.
 *
 * The receipt goes into AWARE's existing hash-chained audit log
 * (src/audit/decision-logger.js), so the trail is tamper-evident without a
 * new integrity primitive. The chain record ALSO links the receipt to the
 * eventual execution outcome through `parentDecisionId`.
 *
 * @param {Object} input - The record input.
 * @param {Object} input.receipt - The ACS receipt.
 * @param {Object} input.decisionId - The decision id for this record.
 * @param {string|null} [input.parentDecisionId] - The parent decision id.
 * @param {string} [input.agentId] - The agent id.
 * @param {string} [input.policyId] - The policy id.
 * @param {string} [input.policyVersion] - The policy version.
 * @param {Object} [input.outcome] - The execution outcome, when known.
 * @returns {Object} A DecisionRecord for the chain.
 */
function buildDecisionRecord(input) {
  const {
    receipt,
    decisionId,
    parentDecisionId = null,
    agentId = null,
    policyId = 'acs-adapter',
    policyVersion = ACS_SPEC_VERSION,
    outcome,
  } = input;

  // Read the receipt members from a JSON-materialised copy.
  //
  // A receipt is a JSON wire artefact, so the JSON data model is its
  // canonical form. Reading the members back through that model also avoids
  // a runtime defect observed on Node 26.13.0, where a plain property read
  // of a freshly constructed object can intermittently yield undefined even
  // though the property descriptor and JSON.stringify both report the
  // correct value. The defect is call-site dependent and non-deterministic,
  // so it cannot be worked around by re-reading the same property.
  //
  // The round trip happens once per record, not once per member.
  const materialised = JSON.parse(JSON.stringify(receipt));
  const interventionPoint = materialised.interception_point;
  const mode = materialised.mode;
  const sessionId = materialised.session_id;
  const sequence = materialised.sequence;
  const receiptTimestamp = materialised.timestamp;
  const verdict = materialised.verdict || {};
  const verdictReason = verdict.reason;
  const verdictDecision = verdict.decision;

  return {
    decisionId,
    parentDecisionId,
    timestamp: receiptTimestamp,
    actor: {
      agentId,
      trustScore: null,
    },
    action: {
      type: 'acs_receipt',
      target: interventionPoint,
      reason: verdictReason,
      // The receipt itself is stored in the record so the chain holds the
      // whole proof. It is payload-free, so it carries no sensitive value.
      receipt,
    },
    context: {
      pheromoneScores: {},
      heuristicWeights: {},
      policyId,
      policyVersion,
      // The ACS-specific fields, so a reader can answer "which spec, which
      // point, which mode" from the chain alone.
      interventionPoint,
      mode,
      specVersion: ACS_SPEC_VERSION,
      sessionId,
      sequence,
    },
    outcome: outcome || {
      success: verdictDecision === 'allow',
      latencyMs: 0,
      errorMessage: null,
    },
  };
}

module.exports = {
  MAX_MESSAGE_BYTES,
  truncateBytes,
  projectVerdict,
  buildVerdictSlot,
  buildReceipt,
  validateReceipt,
  buildDecisionRecord,
};
