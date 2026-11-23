// src/acs/schemas.js
// Loads the vendored ACS JSON Schema documents.
//
// The schemas are vendored under docs/acs/schemas/ so the adapter validates
// against the PINNED spec, not against whatever is on the network. Their
// provenance and licences are in docs/acs/VENDORED.md, and their SHA-256
// hashes are asserted by test/unit/acs/schema-drift.test.js.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The vendored schema directory, resolved relative to this module so the
 * adapter works from an installed package as well as from the repo.
 */
const SCHEMA_DIR = path.join(__dirname, '..', '..', 'docs', 'acs', 'schemas');

/**
 * The schema files this adapter loads, and the role each one plays.
 *
 * - policy-input   the canonical five-member input a policy dispatcher receives
 * - verdict        the policy-output verdict (AGT D1/D2 shape)
 * - result         the intervention-point result envelope
 * - request        the wire request envelope
 * - snapshot       the host-supplied snapshot
 * - manifest       the ACS manifest
 * - approval       the approval seam (request/resolution shapes)
 * - interception-record the RECEIPT schema, taken from Agent Hooks
 * - reserved-reasons the registered runtime_error: reasons
 */
const SCHEMA_FILES = Object.freeze({
  policyInput: 'policy-input.schema.json',
  verdict: 'verdict.schema.json',
  result: 'result.schema.json',
  request: 'request.schema.json',
  snapshot: 'snapshot.schema.json',
  manifest: 'manifest.schema.json',
  approval: 'approval.schema.json',
  interceptionRecord: 'interception-record.schema.json',
  reservedReasons: 'reserved-reasons.json',
});

const cache = new Map();

/**
 * Read one vendored schema file.
 *
 * @param {string} fileName - The file name inside the schema directory.
 * @returns {Object} The parsed JSON document.
 * @throws {Error} When the file is missing or is not valid JSON. The caller
 *   must treat this as a fail-closed condition.
 */
function readSchemaFile(fileName) {
  if (cache.has(fileName)) {
    return cache.get(fileName);
  }
  const filePath = path.join(SCHEMA_DIR, fileName);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`ACS schema file is unreadable: ${fileName}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`ACS schema file is not valid JSON: ${fileName}: ${err.message}`);
  }
  cache.set(fileName, parsed);
  return parsed;
}

/**
 * Load a schema by its logical name.
 *
 * @param {string} name - One of the keys of SCHEMA_FILES.
 * @returns {Object} The parsed schema document.
 */
function getSchema(name) {
  const fileName = SCHEMA_FILES[name];
  if (!fileName) {
    throw new Error(`Unknown ACS schema name: ${name}`);
  }
  return readSchemaFile(fileName);
}

/**
 * The registered reserved reasons, as a Set of reason strings.
 *
 * Every reason the ACS runtime may use on a fail-closed path is in this
 * file. A fail-closed verdict that carries a reason outside this set is a
 * defect: the reason would be indistinguishable from a policy reason.
 *
 * @returns {Set<string>} The registered reason strings.
 */
function getReservedReasons() {
  const doc = getSchema('reservedReasons');
  const reasons = Array.isArray(doc.reasons) ? doc.reasons : [];
  return new Set(reasons.map((r) => r.reason));
}

/**
 * The reserved reasons grouped by the producer that owns them.
 *
 * @returns {Map<string, string[]>} reason -> producing component.
 */
function getReservedReasonProducers() {
  const doc = getSchema('reservedReasons');
  const reasons = Array.isArray(doc.reasons) ? doc.reasons : [];
  return new Map(reasons.map((r) => [r.reason, r.producer]));
}

module.exports = {
  SCHEMA_DIR,
  SCHEMA_FILES,
  getSchema,
  getReservedReasons,
  getReservedReasonProducers,
};
