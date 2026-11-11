// src/disclosure/disclosure-record.js
// Disclosure record generator — binds a compliance gap and its framework
// control IDs to a verifiable audit-chain window.
//
// ADR (internal): ADR-079 — "Disclosure record generator (C1)".
//
// WHAT THIS IS NOT
// -----------------
// This module does NOT close the incident-disclosure gap that the Nadella
// coverage audit (`t_13195acc`) marked "❌ ABSENT". It mechanises the gap
// at CLASS granularity only. The audit's marking must stay in every
// external description until P-2 (specific) is reachable — which requires
// the C2 snapshots (`S-POLICY` / `S-TOOLS` / `S-KILL`) to be recording.
// See ADR-079 §4 for the full statement.
//
// PUBLICATION GRANULARITY
// -----------------------
// The publication-granularity ladder is P-0 (existence) / P-1 (class) /
// P-2 (specific). The state-layer axis is L-A (baseline) / L-B (operator
// overlay) / L-C (live state) — the two axes are distinct and must never
// be conflated (the collision was a documented amendment in the C2 spike,
// `c2-runtime-behaviour-diff-spike-2026-10-12.md` §4.1).
//
// This module renders P-0 and P-1 ONLY. P-2 is refused at the API
// boundary because the snapshots that make it truthful do not exist yet.
// A caller asking for P-2 gets an error, not a downgraded record — a
// silent downgrade would let a caller believe it holds a specific diff.
//
// WHY A HASH-CHAINED WINDOW
// -------------------------
// A disclosure record is only worth publishing if the recipient can
// recompute it. The record therefore carries the raw chain records
// (including `prevHash` and `hash`) for the window, so a third party can
// recompute the hashes rather than trust AWARE's assertion.
//
// `verifyChain()` as shipped reads the whole on-disk log, not a window,
// so this module ships `verifyChainWindow()`: the same hash maths over
// an in-memory window.

'use strict';

const crypto = require('crypto');
const { exportChain, verifyChain, canonicalSerialize } = require('../audit/decision-logger');
const { getFrameworkMapper } = require('../compliance/framework-mapper');

/**
 * Publication granularity ladder.
 *
 * P-0 — existence only ("a control in the agent-authorization layer failed").
 * P-1 — class ("the set of tools available to an agent role changed").
 * P-2 — specific (full redacted diff). REFUSED: requires the C2 snapshots.
 *
 * The legacy names (L-0/L-1/L-2) are carried on every record as
 * `granularityLegacy` so a record is traceable to the vocabulary the
 * implementation cards used. Same ladder, two labels — the rename was an
 * amendment in the C2 spike, not a new axis.
 *
 * @enum {string}
 */
const PublicationGranularity = {
  P0_EXISTENCE: 'P-0',
  P1_CLASS: 'P-1',
  P2_SPECIFIC: 'P-2'
};

/**
 * Legacy alias for each granularity, from the pre-amendment vocabulary.
 * @type {Object<string, string>}
 */
const GRANULARITY_LEGACY_ALIAS = Object.freeze({
  'P-0': 'L-0',
  'P-1': 'L-1',
  'P-2': 'L-2'
});

/**
 * Granularities this module will render.
 *
 * P-2 is absent by construction, not by omission. `assertRenderable()`
 * rejects it with an explanation rather than falling back.
 */
const RENDERABLE_GRANULARITIES = Object.freeze([
  PublicationGranularity.P0_EXISTENCE,
  PublicationGranularity.P1_CLASS
]);

/**
 * The schema version of the emitted record.
 *
 * Bump on any change to the record's field set or to the granularity
 * semantics. Consumers can branch on this rather than sniffing shape.
 */
const DISCLOSURE_RECORD_VERSION = 'aware.disclosure-record.v1';

/**
 * Gap statuses that mean the control has already been dispositioned.
 * Used only for prose shaping; the record never asserts the gap is closed.
 */
const RELEASED_GAP_STATUSES = Object.freeze([
  'REMEDIATED',
  'ACCEPTED'
]);

/**
 * Genesis prevHash — the anchor of a chain that starts at its root.
 * Matches `GENESIS_HASH` in `src/audit/decision-logger.js`.
 */
const GENESIS_HASH = '0'.repeat(64);

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Compute the SHA256 hash of a record, mirroring
 * `computeRecordHash()` in `src/audit/decision-logger.js`.
 *
 * The canonicalisation is delegated to the shipped `canonicalSerialize()`
 * rather than re-implemented here. That is deliberate: `canonicalSerialize()`
 * serialises a FIXED field order and DROPS any key outside it, so a
 * record carrying an extra field hashes without that field. A generic
 * "sort the keys" re-implementation would include the extra field and
 * silently disagree with the stored hash — a verifier that fails on
 * perfectly good records is worse than no verifier. The contract a third
 * party must reproduce is documented on every record under
 * `verification.canonicalisation`.
 *
 * @param {Object} record
 * @param {string} prevHash
 * @returns {string} hex digest
 */
function computeWindowRecordHash(record, prevHash) {
  const payload = canonicalSerialize(record) + prevHash;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Reject a granularity this module must not render.
 *
 * @param {string} granularity
 * @throws {Error} when the granularity is P-2 or unknown
 */
function assertRenderable(granularity) {
  if (RENDERABLE_GRANULARITIES.includes(granularity)) return;

  if (granularity === PublicationGranularity.P2_SPECIFIC) {
    throw new Error(
      'P-2 (specific) disclosure is not renderable: it requires the C2 ' +
      'runtime-behaviour snapshots (S-POLICY / S-TOOLS / S-KILL) to be ' +
      'recording. Until they are, this generator renders P-0/P-1 only. ' +
      'See ADR-079 §4.'
    );
  }

  throw new Error(
    `Unsupported publication granularity: ${granularity}. ` +
    `Renderable: ${RENDERABLE_GRANULARITIES.join(', ')}.`
  );
}

/**
 * Resolve the framework control IDs a gap maps to.
 *
 * A gap carries `frameworkId` and `controlId` — the control that failed.
 * The mapper carries component→control mappings. The two are joined by
 * inversion: the components whose mapping covers the failed control are
 * the components that implement it, and their full control coverage is
 * the CLASS of control affected. That is what lets a P-1 record name a
 * class rather than a bare ID.
 *
 * @param {Object} gap
 * @param {Object} mapper
 * @returns {{controls: Array<Object>, components: Array<string>}}
 */
function resolveControlIds(gap, mapper) {
  const controls = [];
  const seen = new Set();
  const components = new Set();

  const push = (frameworkId, controlId, name, source) => {
    const key = `${frameworkId}::${controlId}`;
    if (!controlId || seen.has(key)) return;
    seen.add(key);
    controls.push({ frameworkId, controlId, name: name || null, source });
  };

  const nameFor = (frameworkId, controlId) => {
    if (typeof mapper.getFrameworkControls !== 'function') return null;
    const match = mapper.getFrameworkControls(frameworkId)
      .find(c => c.id === controlId);
    return match ? match.name : null;
  };

  const mappings = typeof mapper.getAllMappings === 'function'
    ? mapper.getAllMappings()
    : {};

  // 1. The gap's own control — the one that failed. Always first.
  if (gap.frameworkId && gap.controlId) {
    push(gap.frameworkId, gap.controlId,
      nameFor(gap.frameworkId, gap.controlId), 'gap');
  }

  // 2. Invert the mapper: which components implement the failed control?
  //    An explicit `gap.componentId` is honoured as well.
  const implementing = [];
  if (gap.frameworkId && gap.controlId) {
    for (const [componentId, byFramework] of Object.entries(mappings)) {
      const covered = byFramework[gap.frameworkId];
      if (Array.isArray(covered) && covered.includes(gap.controlId)) {
        implementing.push(componentId);
      }
    }
  }
  if (gap.componentId) implementing.push(gap.componentId);

  for (const componentId of implementing) {
    components.add(componentId);
    const byFramework = mappings[componentId] || {};
    for (const [frameworkId, controlIds] of Object.entries(byFramework)) {
      for (const controlId of controlIds) {
        push(frameworkId, controlId, nameFor(frameworkId, controlId),
          'framework-mapper');
      }
    }
  }

  return { controls, components: [...components].sort() };
}

/**
 * Compose the P-0 prose — existence only.
 *
 * @param {Object} gap
 * @returns {string}
 */
function renderExistenceProse(gap) {
  const layer = gap.layer || 'agent-governance';
  return (
    `A control in the ${layer} layer failed. ` +
    'This notice states existence only; it does not describe which ' +
    'behaviour changed.'
  );
}

/**
 * Compose the P-1 prose — the class of control affected.
 *
 * Names the layer, the disposition, and the frameworks touched. Does NOT
 * name tools, agents, roles, or deployment topology — those are the
 * L-B/L-C specifics that P-2 would carry, and the redaction classes R1-R7
 * in the C2 spike exist precisely because those specifics disclose
 * operator topology.
 *
 * The disposition clause is shaped by the gap's ACTUAL status: a gap that
 * is still open says so. The record never asserts a remediation that the
 * gap tracker does not record.
 *
 * @param {Object} gap
 * @param {Array} controls
 * @returns {string}
 */
function renderClassProse(gap, controls) {
  const layer = gap.layer || 'agent-governance';
  const frameworks = [...new Set(controls.map(c => c.frameworkId))].sort();
  const frameworkClause = frameworks.length
    ? ` Control frameworks touched: ${frameworks.join(', ')}.`
    : '';
  const severity = gap.severity ? ` Severity: ${gap.severity}.` : '';

  const disposition = gap.status === 'REMEDIATED'
    ? 'The gap was remediated.'
    : (gap.status === 'ACCEPTED'
      ? 'The gap risk was accepted by an operator.'
      : (gap.status
        ? `The gap is currently ${gap.status}.`
        : 'The gap disposition is not recorded.'));

  return (
    `A control in the ${layer} layer failed.${severity} ${disposition}` +
    `${frameworkClause} This notice states the class of control affected. ` +
    'It does not name tools, agents, roles, or deployment topology.'
  );
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build a disclosure record for a gap over an audit-chain window.
 *
 * The chain window is the transport: the record carries the raw chain
 * records so the recipient can recompute the hashes independently.
 *
 * @param {Object} options
 * @param {Object} options.gap - A gap object from `gap-tracker.js`.
 * @param {string} options.fromDecisionId - First decision ID in the window.
 * @param {string} options.toDecisionId - Last decision ID in the window.
 * @param {string} [options.granularity='P-1'] - Publication granularity.
 * @param {Object} [options.gapTracker] - GapTracker instance (for history).
 * @param {Object} [options.frameworkMapper] - FrameworkMapper instance.
 * @returns {Promise<Object>} The disclosure record.
 */
async function buildDisclosureRecord(options = {}) {
  const {
    gap,
    fromDecisionId,
    toDecisionId,
    granularity = PublicationGranularity.P1_CLASS,
    gapTracker = null,
    frameworkMapper = null
  } = options;

  if (!gap || typeof gap !== 'object') {
    throw new Error('buildDisclosureRecord requires a gap object');
  }
  if (!fromDecisionId || !toDecisionId) {
    throw new Error(
      'buildDisclosureRecord requires fromDecisionId and toDecisionId ' +
      '(the audit-chain window to bind to the gap)'
    );
  }

  assertRenderable(granularity);

  const mapper = frameworkMapper || getFrameworkMapper();
  const { controls, components } = resolveControlIds(gap, mapper);

  // The window itself, exported verbatim. `exportChain()` resolves the
  // chain and returns the records as written — including `prevHash` and
  // `hash` — so the recipient can recompute.
  const exported = await exportChain(fromDecisionId, toDecisionId, 'json');
  const chain = typeof exported === 'string' ? JSON.parse(exported) : exported;

  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error(
      `Audit-chain window ${fromDecisionId}..${toDecisionId} is empty; ` +
      'a disclosure record must carry a non-empty window to be verifiable.'
    );
  }

  const history = gapTracker && typeof gapTracker.getGapHistory === 'function'
    ? gapTracker.getGapHistory(gap.id)
    : [];

  return {
    schema: DISCLOSURE_RECORD_VERSION,
    generatedAt: new Date().toISOString(),

    // The granularity this record was rendered at, and why it is not more.
    publication: {
      granularity,
      granularityLegacy: GRANULARITY_LEGACY_ALIAS[granularity] || null,
      rendersBeyondClass: false,
      statement:
        'This record is rendered at class granularity. It does not assert ' +
        'that the incident-disclosure gap is closed, and it does not ' +
        'describe which runtime behaviour changed. The incident-disclosure ' +
        'gap remains open until specific-granularity (P-2) disclosure is ' +
        'reachable, which requires the runtime-behaviour snapshots to be ' +
        'recording.',
      rationale:
        'Specific disclosure requires the C2 runtime-behaviour snapshots ' +
        '(S-POLICY / S-TOOLS / S-KILL). They are not recording. Class-level ' +
        'disclosure stops the gap being silent; it does not close it.'
    },

    // What went wrong, and which control failed.
    gap: {
      id: gap.id,
      title: gap.title || null,
      severity: gap.severity || null,
      status: gap.status || null,
      controlId: gap.controlId || null,
      frameworkId: gap.frameworkId || null,
      owner: gap.owner || null,
      createdAt: gap.createdAt || null,
      remediatedAt: gap.remediatedAt || null,
      released: RELEASED_GAP_STATUSES.includes(gap.status)
    },

    // Which controls failed — the framework control IDs.
    controls,
    components,

    // How to prevent it happening again — the recorded remediation state.
    remediation: {
      state: gap.status || null,
      owner: gap.owner || null,
      notes: Array.isArray(gap.notes) ? gap.notes : [],
      historyEntries: history.length
    },

    // The disclosure prose, at the requested granularity.
    prose: granularity === PublicationGranularity.P0_EXISTENCE
      ? renderExistenceProse(gap)
      : renderClassProse(gap, controls),

    // The transport: the audit-chain window, verbatim, so a third party can
    // recompute the hashes rather than trust this record's assertion.
    chain: {
      fromDecisionId,
      toDecisionId,
      recordCount: chain.length,
      firstPrevHash: chain[0].prevHash,
      lastHash: chain[chain.length - 1].hash,
      // The anchor outside the window is DECLARED, not verified: the first
      // record's prevHash points at a record this window does not contain.
      // It is verifiable only when it is the genesis anchor.
      anchorVerified: chain[0].prevHash === GENESIS_HASH,
      records: chain
    },

    // How to verify the window independently.
    verification: {
      method: 'recompute-sha256-chain',
      canonicalisation:
        'canonicalSerialize(record) — sorted top-level field order, the ' +
        'hash field excluded, keys outside the canonical field set ' +
        'dropped, nested key order as emitted. Payload = ' +
        'canonicalJSON + prevHash. sha256 hex.',
      verifier: 'scripts/verify_chain.py (stdlib only) or the in-repo ' +
        'verifyChainWindow() helper',
      recompute:
        'For each record in chain.records, recompute ' +
        'sha256(canonicalSerialize(record) + record.prevHash) and compare ' +
        "with record.hash; then check each record's prevHash equals the " +
        "previous record's hash. The first record's prevHash is the " +
        'window anchor — verifiable from the window alone only when it ' +
        'is the genesis hash.'
    }
  };
}

/**
 * Verify a disclosure record's chain window by recomputing the hashes.
 *
 * This is the check a recipient runs. It does NOT trust the record's
 * `chain.anchorVerified` flag or any hash the record asserts — it
 * recomputes every hash from the carried records.
 *
 * @param {Object} disclosureRecord - A record from `buildDisclosureRecord()`.
 * @returns {{valid: boolean, recordsChecked: number, firstInvalidRecord: string|null, error: string|null, anchorVerified: boolean, declaredAnchor: string}}
 */
function verifyChainWindow(disclosureRecord) {
  if (!disclosureRecord || !disclosureRecord.chain) {
    throw new Error('verifyChainWindow requires a disclosure record with a chain');
  }

  const records = disclosureRecord.chain.records;
  if (!Array.isArray(records) || records.length === 0) {
    return {
      valid: false,
      recordsChecked: 0,
      firstInvalidRecord: null,
      error: 'chain window carries no records',
      anchorVerified: false,
      declaredAnchor: null
    };
  }

  let expectedPrevHash = records[0].prevHash;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    const ownHash = computeWindowRecordHash(record, record.prevHash);
    if (ownHash !== record.hash) {
      return {
        valid: false,
        recordsChecked: i,
        firstInvalidRecord: record.decisionId,
        error: `Hash mismatch at record ${i}: expected ${ownHash}, got ${record.hash}`,
        anchorVerified: false,
        declaredAnchor: records[0].prevHash
      };
    }

    if (i > 0 && record.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        recordsChecked: i,
        firstInvalidRecord: record.decisionId,
        error:
          `Chain break at record ${i}: prevHash ${record.prevHash} does not ` +
          `match the previous record's hash ${expectedPrevHash}`,
        anchorVerified: false,
        declaredAnchor: records[0].prevHash
      };
    }

    expectedPrevHash = record.hash;
  }

  // The window's first record's prevHash points at a record outside the
  // window, so it cannot be verified from the window alone — unless it is
  // the genesis anchor, which is a known constant rather than a claim.
  return {
    valid: true,
    recordsChecked: records.length,
    firstInvalidRecord: null,
    error: null,
    anchorVerified: records[0].prevHash === GENESIS_HASH,
    declaredAnchor: records[0].prevHash
  };
}

/**
 * Verify the whole on-disk chain (not just a window).
 *
 * Exposed so a recipient of a disclosure record who has access to the
 * log file can run the canonical check. This is the shipped
 * `verifyChain()` from `src/audit/decision-logger.js`, re-exported here
 * so the disclosure module is a single import for a consumer.
 *
 * @returns {Promise<{valid: boolean, firstInvalidRecord?: string, error?: string}>}
 */
async function verifyFullChain() {
  return verifyChain();
}

module.exports = {
  // Constants
  PublicationGranularity,
  GRANULARITY_LEGACY_ALIAS,
  RENDERABLE_GRANULARITIES,
  DISCLOSURE_RECORD_VERSION,
  GENESIS_HASH,

  // Core functions
  buildDisclosureRecord,
  verifyChainWindow,
  verifyFullChain,

  // Utilities
  canonicalSerialize,
  computeWindowRecordHash
};
