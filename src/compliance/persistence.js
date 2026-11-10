// src/compliance/persistence.js
// Durable persistence bridge for the compliance engine.
//
// 2026-11-10 (scribe): the compliance engine was entirely in-memory.
// PostureCalculator.assessments and EvidenceCollector.evidenceStore were
// plain Maps, so a restart reset the measured posture to zero — and
// because the gateway image excludes `pg` and src/db (Dockerfile.gateway:
// "gateway does NOT need: ... db ... modules that would crash with their
// native deps"), the gateway process cannot open a Postgres connection at
// all.
//
// This module solves both problems at once:
//
//   1. It keeps the canonical state in a JSON file on disk. The file lives
//      next to the audit chain, on a volume BOTH the gateway and the
//      coordinator can write. No native dependency, no separate service.
//      A shared-file store is the correct shape here: the compliance
//      engine is a singleton in each process, and the gateway is the
//      read surface while the coordinator is the write surface.
//
//   2. It exposes the same API to both, and it hydrates the in-memory
//      Maps on first use, so a restart no longer loses state.
//
// The file is written atomically (write temp + rename) so a crash mid-write
// cannot leave a truncated JSON file that would make the engine
// unbootable. A corrupt file is moved aside rather than deleted, and the
// engine starts empty rather than refusing to boot.

'use strict';

const fs = require('fs');
const path = require('path');

// The audit dir is /data/audit in both the gateway and the coordinator
// (docker-compose.coordinator.yml mounts aware-2-audit-data there). The
// gateway mounts it read-only; the coordinator mounts it read-write. The
// compliance state file therefore lives in the coordinator's audit dir so
// the gateway reads a file the coordinator wrote.
//
// If the audit dir is not writable (gateway), the store degrades to
// read-only: hydrate what it can, refuse writes.
// 2026-11-10 (scribe): the state file does NOT live in /data/audit. The
// gateway mounts the audit volume READ-ONLY (docker-compose.coordinator.yml
// `:/data/audit:ro`) so a compromised gateway cannot rewrite the audit
// trail — writing compliance state there failed with EROFS. Compliance
// state has its own volume, mounted read-write in both the gateway and
// the coordinator, because both run the compliance engine.
const AUDIT_DIR = process.env.AWARE_AUDIT_DIR || '/data/audit';
const STATE_DIR = process.env.AWARE_COMPLIANCE_STATE_DIR || '/data/compliance';
const STATE_FILE = process.env.AWARE_COMPLIANCE_STATE_FILE
  || path.join(STATE_DIR, 'compliance-state.json');

let hydrated = false;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the state file. Returns {assessments: [], evidence: []} on any
 * problem — a missing file is normal on first boot.
 */
function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      assessments: Array.isArray(parsed.assessments) ? parsed.assessments : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Corrupt or unreadable. Preserve it for forensics, start empty.
      const quarantine = `${STATE_FILE}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(STATE_FILE, quarantine);
        console.error(
          `[compliance-persistence] state file unreadable (${err.message}); ` +
          `moved to ${quarantine} and starting with empty state`
        );
      } catch {
        console.error('[compliance-persistence] state file unreadable:', err.message);
      }
    }
    return { assessments: [], evidence: [] };
  }
}

/**
 * Write the state file atomically.
 * @returns {boolean} true when written
 */
function writeState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!ensureDir(dir)) return false;
    const tmp = `${STATE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
    return true;
  } catch (err) {
    console.error('[compliance-persistence] write failed:', err.message);
    return false;
  }
}

/**
 * The state singleton.
 */
const state = { assessments: [], evidence: [] };

/**
 * Re-read the state file from disk into the in-memory state.
 *
 * 2026-11-10 (scribe): the state file is the single source of truth, not
 * the in-memory copy. The compliance engine runs in BOTH the gateway and
 * the coordinator, each with its own PostureCalculator and
 * EvidenceCollector singleton. If either read only from its own memory,
 * the gateway's dashboard would not reflect an assessment recorded
 * against the coordinator (or vice versa). Re-reading on every access
 * keeps the two views of the same file consistent.
 *
 * The cost is one small file read per access. The file is a few KB.
 *
 * @returns {{assessments: Array, evidence: Array}}
 */
function hydrate(force = false) {
  if (hydrated && !force) return state;
  hydrated = true;
  const loaded = readState();
  state.assessments = loaded.assessments;
  state.evidence = loaded.evidence;
  return state;
}

/**
 * Record an assessment. Writes through to disk.
 * @param {Object} a - {frameworkId, controlId, status, evidence, notes, assessedBy}
 */
function recordAssessment(a) {
  if (!a || !a.frameworkId || !a.controlId) return false;
  hydrate(true);
  const entry = {
    frameworkId: a.frameworkId,
    controlId: a.controlId,
    status: a.status || 'NOT_ASSESSED',
    evidence: Array.isArray(a.evidence) ? a.evidence : [],
    notes: a.notes || '',
    assessedBy: a.assessedBy || 'system',
    assessedAt: a.assessedAt || Date.now(),
  };
  const idx = state.assessments.findIndex(
    (x) => x.frameworkId === entry.frameworkId && x.controlId === entry.controlId
  );
  if (idx >= 0) state.assessments[idx] = entry;
  else state.assessments.push(entry);
  return writeState(state);
}

/**
 * Record an evidence item. Writes through to disk.
 * @param {Object} ev - {id, controlId, status, source, collector, data, error, collectedAt, expiresAt}
 */
function recordEvidence(ev) {
  if (!ev || !ev.id || !ev.controlId) return false;
  hydrate(true);
  const entry = {
    id: ev.id,
    controlId: ev.controlId,
    status: ev.status || 'UNKNOWN',
    source: ev.source || null,
    collector: ev.collector || null,
    data: ev.data || {},
    error: ev.error || null,
    collectedAt: ev.collectedAt || Date.now(),
    expiresAt: ev.expiresAt || ev.collectedAt || Date.now(),
  };
  const idx = state.evidence.findIndex((x) => x.id === entry.id);
  if (idx >= 0) state.evidence[idx] = entry;
  else state.evidence.push(entry);
  return writeState(state);
}

/**
 * All recorded assessments.
 */
function listAssessments() {
  hydrate(true);
  return state.assessments.slice();
}

/**
 * All recorded evidence, most recent first.
 */
function listEvidence() {
  hydrate(true);
  return state.evidence.slice().sort((a, b) => (b.collectedAt || 0) - (a.collectedAt || 0));
}

/**
 * Evidence grouped by status — the shape /api/compliance/evidence returns.
 */
function evidenceSummary() {
  const items = listEvidence();
  const byStatus = {};
  const byControl = {};
  for (const e of items) {
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    byControl[e.controlId] = (byControl[e.controlId] || 0) + 1;
  }
  return {
    totalEvidence: items.length,
    byStatus,
    byControl,
    collectors: 5,
    schedules: 0,
    persisted: true,
    stateFile: STATE_FILE,
  };
}

/**
 * Restore assessments into the in-memory posture calculator.
 * @param {Object} postureCalc - PostureCalculator instance
 */
function applyAssessmentsTo(postureCalc) {
  if (!postureCalc || !postureCalc.assessments) return 0;
  const items = listAssessments();
  for (const a of items) {
    postureCalc.assessments.set(`${a.frameworkId}:${a.controlId}`, {
      controlId: a.controlId,
      frameworkId: a.frameworkId,
      status: a.status,
      evidence: a.evidence,
      notes: a.notes,
      assessedAt: a.assessedAt,
      assessedBy: a.assessedBy,
    });
  }
  return items.length;
}

/**
 * Restore evidence into the in-memory evidence collector.
 * @param {Object} collector - EvidenceCollector instance
 */
function applyEvidenceTo(collector) {
  if (!collector || !collector.evidenceStore) return 0;
  const items = listEvidence();
  for (const e of items) {
    collector.evidenceStore.set(e.id, e);
  }
  return items.length;
}

module.exports = {
  STATE_FILE,
  hydrate,
  recordAssessment,
  recordEvidence,
  listAssessments,
  listEvidence,
  evidenceSummary,
  applyAssessmentsTo,
  applyEvidenceTo,
};
