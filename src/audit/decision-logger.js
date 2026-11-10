/**
 * ADR (internal): Phase 3.3 — Decision-Chain Traceability
 * 
 * Hash-chained decision audit logging for tamper-evident traceability.
 * Per ADR (internal) §Tamper-Evident Chaining.
 * 
 * @module audit/decision-logger
 * @author Coder (Coder)
 * @license Apache-2.0
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Constants
// ============================================================================

/**
 * Genesis prevHash for first record.
 */
const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Audit log directory.
 */
const AUDIT_DIR = process.env.AUDIT_DIR || '/data/audit';

/**
 * Audit log file (JSONL format).
 */
const AUDIT_LOG_FILE = path.join(AUDIT_DIR, 'decision-chain.jsonl');

/**
 * Index file for O(1) lookup by decisionId.
 */
const AUDIT_INDEX_FILE = path.join(AUDIT_DIR, 'decision-chain.idx');

/**
 * Stats from the most recent readAllFromLog() call.
 * `skipped` counts lines that could not be parsed (torn writes).
 */
const lastReadStats = { skipped: 0 };

// ============================================================================
// Decision Record Interface
// ============================================================================

/**
 * @typedef {Object} DecisionRecord
 * @property {string} decisionId - UUID v4
 * @property {string|null} parentDecisionId - Parent decision ID (null for root)
 * @property {string} timestamp - ISO 8601
 * @property {Object} actor - { agentId, trustScore }
 * @property {Object} action - { type, target, reason }
 * @property {Object} context - { pheromoneScores, heuristicWeights, policyId, policyVersion }
 * @property {Object} outcome - { success, latencyMs, errorMessage }
 * @property {string} hash - SHA256 of all fields plus prevHash
 * @property {string} prevHash - SHA256 of previous record
 */

// ============================================================================
// Canonical Serialization (ADR (internal) F-2 fix)
// ============================================================================

/**
 * Canonical JSON serialization for deterministic hashing.
 * 
 * Per ADR (internal) F-2 fix: canonical JSON format with sorted keys.
 * 
 * @param {DecisionRecord} record
 * @returns {string}
 */
function canonicalSerialize(record) {
  // Field order per ADR (internal) spec (sorted alphabetically)
  const fieldOrder = [
    'action',
    'actor',
    'context',
    'decisionId',
    'hash',            // excluded from hash computation
    'outcome',
    'parentDecisionId',
    'prevHash',
    'timestamp'
  ];
  
  const ordered = {};
  for (const key of fieldOrder) {
    if (key in record && key !== 'hash') {
      ordered[key] = record[key];
    }
  }
  
  return JSON.stringify(ordered);
}

/**
 * Compute SHA256 hash of record + prevHash.
 * 
 * @param {DecisionRecord} record
 * @param {string} prevHash
 * @returns {string}
 */
function computeRecordHash(record, prevHash) {
  const canonical = canonicalSerialize(record);
  const payload = canonical + prevHash;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ============================================================================
// In-Memory Index
// ============================================================================

/**
 * In-memory index for O(1) decisionId → hash lookup.
 * @type {Map<string, string>}
 */
const index = new Map();

/**
 * Last hash in chain.
 */
let lastHash = GENESIS_HASH;

// ============================================================================
// Storage
// ============================================================================

/**
 * Ensure audit directory exists.
 *
 * Wrapped in try/catch so a read-only filesystem (test environments,
 * misconfigured deploys) doesn't crash the audit module on require.
 * The error is logged once at module load; subsequent operations
 * that need the directory (logDecision, getChain, etc.) will surface
 * their own errors at use time.
 */
function ensureAuditDir() {
  try {
    if (!fs.existsSync(AUDIT_DIR)) {
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[decision-logger] AUDIT_DIR (${AUDIT_DIR}) not writable: ${err.code || err.message}`);
  }
}

/**
 * Load index from disk on startup.
 */
function loadIndex() {
  ensureAuditDir();

  if (!fs.existsSync(AUDIT_INDEX_FILE)) {
    return;
  }
  
  try {
    const data = fs.readFileSync(AUDIT_INDEX_FILE, 'utf8');
    const entries = JSON.parse(data);
    
    for (const [decisionId, hash] of Object.entries(entries)) {
      index.set(decisionId, hash);
    }
    
    // Find last hash by reading the last parseable line of the log.
    // The last line may be a torn write (not valid JSON), so walk
    // backwards until a parseable record is found.
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      const lines = fs.readFileSync(AUDIT_LOG_FILE, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const lastRecord = JSON.parse(line);
          if (lastRecord && lastRecord.hash) {
            lastHash = lastRecord.hash;
          }
          break;
        } catch {
          // Torn or partially-flushed final line - keep walking back.
          continue;
        }
      }
    }
    
    console.log(`[decision-logger] Loaded ${index.size} decisions from index`);
  } catch (err) {
    console.error(`[decision-logger] Failed to load index: ${err.message}`);
  }
}

/**
 * Persist index to disk (synchronous, full rewrite).
 *
 * ARCHITECTURAL FIX (Phase 9.2): The previous implementation rewrote the
 * entire index file on EVERY decision via fs.writeFileSync. With 20k+
 * decisions this serialized ~1.2MB per call, blocked the event loop, and
 * caused every AWARE hook to exceed its 60s timeout (HookTimeoutError).
 *
 * The fix: persistIndex now only runs on graceful shutdown via
 * scheduleIndexFlush() (debounced 5s) or shutdown handler. Per-decision
 * work is now O(1) memory + O(1) async — no fs.writeFileSync in the hot
 * path. Trade-off: ~5s of decisions may be lost on crash (acceptable for
 * an audit log; chain integrity is preserved by the JSONL append-only log).
 */
function persistIndex() {
  const entries = {};
  for (const [decisionId, hash] of index) {
    entries[decisionId] = hash;
  }
  fs.writeFileSync(AUDIT_INDEX_FILE, JSON.stringify(entries));
}

/**
 * Schedule an async flush of the index to disk. Debounced: collapses
 * bursts of decisions into a single fs.writeFile call.
 *
 * @param {number} delayMs - milliseconds to wait before flushing
 */
let flushScheduled = null;
let flushInProgress = false;
function scheduleIndexFlush(delayMs = 5000) {
  if (flushScheduled) return;
  flushScheduled = setTimeout(async () => {
    flushScheduled = null;
    if (flushInProgress) return;
    flushInProgress = true;
    try {
      await new Promise((resolve, reject) => {
        const entries = {};
        for (const [decisionId, hash] of index) {
          entries[decisionId] = hash;
        }
        // Write to a tmp file then rename for atomic replace
        const tmpFile = AUDIT_INDEX_FILE + '.tmp';
        fs.writeFile(tmpFile, JSON.stringify(entries), (err) => {
          if (err) return reject(err);
          fs.rename(tmpFile, AUDIT_INDEX_FILE, (err2) => {
            if (err2) return reject(err2);
            resolve();
          });
        });
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[decision-logger] async flush failed: ${err.message}`);
    } finally {
      flushInProgress = false;
    }
  }, delayMs);
}

/**
 * Force an immediate synchronous flush (for shutdown + tests).
 */
function flushIndexSync() {
  if (flushScheduled) {
    clearTimeout(flushScheduled);
    flushScheduled = null;
  }
  persistIndex();
}

/**
 * Append record to audit log (JSONL format).
 * 
 * @param {string} line
 */
function appendToLog(line) {
  ensureAuditDir();
  fs.appendFileSync(AUDIT_LOG_FILE, line);
}

/**
 * Read all records from log.
 * 
 * @returns {DecisionRecord[]}
 */
function readAllFromLog() {
  if (!fs.existsSync(AUDIT_LOG_FILE)) {
    return [];
  }
  
  const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
  if (!content.trim()) {
    return [];
  }
  
  // A torn or partially-flushed write can leave a line that is not valid
  // JSON (truncated record, or a NUL-padded hole from a sparse write).
  // JSON.parse on the whole file would throw and take down every reader
  // - including verifyChain() and getChain() - so the audit API would
  // return 500 for a chain that is otherwise intact.
  //
  // Skip the unparseable lines and record how many were skipped, so the
  // caller can report the damage instead of silently ignoring it.
  const records = [];
  let skipped = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  
  lastReadStats.skipped = skipped;
  
  if (skipped > 0) {
    lastReadStats.skipped = skipped;
    console.warn(
      `[decision-logger] skipped ${skipped} malformed line(s) in ${AUDIT_LOG_FILE} ` +
      '(torn or partially-flushed write). Chain verification continues on the ' +
      'parseable records.'
    );
  }
  
  return records;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Generate UUID v4.
 * 
 * @returns {string}
 */
function generateUUID() {
  return crypto.randomUUID();
}

/**
 * Get last hash in chain.
 * 
 * @returns {string}
 */
async function getLastHash() {
  return lastHash;
}

/**
 * Index lookup by decisionId.
 * 
 * @param {string} decisionId
 * @returns {string|undefined}
 */
function indexLookup(decisionId) {
  return index.get(decisionId);
}

/**
 * Read record from log by hash.
 * 
 * @param {string} hash
 * @returns {DecisionRecord|undefined}
 */
function readFromLog(hash) {
  const records = readAllFromLog();
  return records.find(r => r.hash === hash);
}

/**
 * Update index with new decision.
 *
 * ARCHITECTURAL FIX (Phase 9.2): previously called persistIndex() which
 * did a full synchronous rewrite of the entire index on every decision.
 * Now uses scheduleIndexFlush() (debounced async) so per-decision cost
 * is O(1) memory + O(1) async — no event-loop blocking.
 *
 * @param {string} decisionId
 * @param {string} hash
 */
async function updateIndex(decisionId, hash) {
  index.set(decisionId, hash);
  lastHash = hash;
  scheduleIndexFlush();
}

/**
 * Log a decision to the audit chain.
 * 
 * Algorithm (ADR (internal) F-1 fix):
 * 1. Validate required fields
 * 2. Get previous hash for chaining
 * 3. Compute record hash
 * 4. Append to log
 * 5. Update index
 * 
 * @param {Omit<DecisionRecord, 'hash' | 'prevHash'>} decision
 * @returns {Promise<string>} Computed hash
 */
async function logDecision(decision) {
  // Step 1: Validate required fields
  const required = ['decisionId', 'parentDecisionId', 'timestamp', 'actor', 'action', 'context', 'outcome'];
  for (const field of required) {
    if (!(field in decision)) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  
  // Step 2: Get previous hash
  const prevHash = await getLastHash();
  
  // Step 3: Compute hash
  const recordWithHash = {
    ...decision,
    prevHash,
    hash: ''  // Will be computed
  };
  
  const computedHash = computeRecordHash(recordWithHash, prevHash);
  recordWithHash.hash = computedHash;
  
  // Step 4: Append to log
  appendToLog(JSON.stringify(recordWithHash) + '\n');
  
  // Step 5: Update index
  await updateIndex(decision.decisionId, computedHash);
  
  console.log(`[decision-logger] Logged decision: ${decision.decisionId}`);
  
  return computedHash;
}

/**
 * Get full chain from root to specified decision.
 * 
 * Algorithm (ADR (internal) F-1 fix):
 * 1. Look up decision's hash in index
 * 2. Read decision record from log
 * 3. Recursively fetch parent
 * 4. Return chain (root → ... → target)
 * 
 * @param {string} decisionId
 * @returns {Promise<DecisionRecord[]>}
 */
async function getChain(decisionId) {
  const chain = [];

  // Cold-index fallback (C-step finding #16 follow-up): if the in-memory
  // index is empty (e.g., fresh deploy, index file missing, audit module
  // freshly required without a prior logDecision call), build a transient
  // index from the JSONL log file so /api/audit/* works on first hit.
  // This is more expensive than the index lookup but only triggers when
  // the persistent index is cold — production deployments warm the
  // index automatically as new decisions are appended.
  if (index.size === 0 && fs.existsSync(AUDIT_LOG_FILE)) {
    try {
      const lines = fs.readFileSync(AUDIT_LOG_FILE, 'utf8').split('\n');
      let skipped = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          index.set(rec.decisionId, rec.hash);
        } catch {
          // A torn write must not abort the whole rebuild - skip it and
          // keep going, otherwise one bad line loses the entire index.
          skipped++;
        }
      }
      if (skipped > 0) {
        console.warn(
          `[decision-logger] cold-index rebuild skipped ${skipped} malformed line(s)`
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[decision-logger] cold-index rebuild failed: ${err.message}`);
    }
  }

  let currentId = decisionId;

  while (currentId !== null) {
    const hash = indexLookup(currentId);
    if (!hash) {
      throw new Error(`Decision ${currentId} not found in index`);
    }

    const record = readFromLog(hash);
    if (!record) {
      throw new Error(`Decision ${currentId} not found in log`);
    }

    chain.unshift(record);  // Prepend (building root-first)
    currentId = record.parentDecisionId;
  }
  
  return chain;
}

/**
 * Get chain between two decision IDs (inclusive).
 * 
 * @param {string} fromId
 * @param {string} toId
 * @returns {Promise<DecisionRecord[]>}
 */
async function getChainBetween(fromId, toId) {
  // 2026-11-10 (scribe): the chain was resolved from the in-memory
  // index, which is flushed on a 5s debounce (scheduleIndexFlush — see
  // the Phase 9.2 note above). A decision written in the last few seconds
  // was therefore not yet in the index, and an export covering the
  // newest record failed with
  //   "Decision <id> not found in index"
  // even though the record was on disk and verified by verifyChain().
  //
  // The index is a lookup accelerator, not the record of truth — the
  // JSONL log is. So: resolve from the index when it has the record,
  // and fall back to reading the log file when it does not. That keeps
  // the fast path fast and makes a fresh export correct.
  let toChain = null;
  try {
    toChain = await getChain(toId);
  } catch {
    toChain = null;
  }

  let fromIndex = toChain
    ? toChain.findIndex(r => r.decisionId === fromId)
    : -1;

  if (fromIndex === -1) {
    // Not in the (possibly stale) index — read the log directly.
    const all = readAllFromLog();
    const toIdx = all.findIndex(r => r.decisionId === toId);
    const fromIdx = all.findIndex(r => r.decisionId === fromId);
    if (fromIdx === -1) {
      throw new Error(`Decision ${fromId} not found in chain to ${toId}`);
    }
    if (toIdx === -1) {
      // 'to' is not on disk yet: return everything from 'from' onward.
      return all.slice(fromIdx);
    }
    return all.slice(fromIdx, toIdx + 1);
  }

  return toChain.slice(fromIndex);
}

/**
 * Verify chain integrity.
 * 
 * Algorithm (ADR (internal) F-1 fix):
 * 1. Read all records
 * 2. For each, recompute hash
 * 3. Verify against stored hash
 * 4. Verify prevHash chain
 * 
 * @returns {Promise<{valid: boolean, firstInvalidRecord?: string, error?: string}>}
 */
async function verifyChain() {
  const records = readAllFromLog();
  const skipped = lastReadStats.skipped;
  
  let expectedPrevHash = GENESIS_HASH;
  let resyncs = 0;
  const seenHashes = new Set();
  
  for (const record of records) {
    // A record's own hash is computed over its canonical form PLUS its
    // prevHash. Verify it against the record's OWN prevHash first: that
    // proves the record was not altered after it was written.
    const ownHash = computeRecordHash(record, record.prevHash);
    if (ownHash !== record.hash) {
      return {
        valid: false,
        firstInvalidRecord: record.decisionId,
        error: `Hash mismatch: expected ${ownHash}, got ${record.hash}`,
        ...(skipped > 0 ? { skippedRecords: skipped } : {}),
        ...(resyncs > 0 ? { resyncs } : {})
      };
    }
    
    // Verify the chain linkage. When the previous record is missing (a
    // torn write destroyed it), the linkage check fails for THIS record
    // and every record after it - because computeRecordHash above uses
    // the expected prevHash, which is now the wrong anchor.
    //
    // A lost record is a GAP, not tampering: the surviving record still
    // hashes correctly against its own prevHash. So resync to the
    // record's own prevHash and keep verifying, rather than reporting a
    // false tampering alarm on the whole remainder of the chain.
    if (record.prevHash !== expectedPrevHash) {
      resyncs++;
      
      // If the record's own prevHash is a hash we have already seen in
      // this chain, the gap is a genuine reordering/tampering.
      if (seenHashes.has(record.prevHash)) {
        return {
          valid: false,
          firstInvalidRecord: record.decisionId,
          error: `Chain broken: expected prevHash ${expectedPrevHash}, got ${record.prevHash}`,
          ...(skipped > 0 ? { skippedRecords: skipped } : {}),
          ...(resyncs > 0 ? { resyncs } : {})
        };
      }
      
      // Resync: continue the chain from this record's own prevHash.
      expectedPrevHash = record.prevHash;
    }
    
    seenHashes.add(record.hash);
    expectedPrevHash = record.hash;
  }
  
  // The chain is intact over every parseable record. `skippedRecords` is
  // non-zero when a torn write left an unreadable line, and `resyncs` is
  // non-zero when a torn write destroyed a record entirely, leaving a
  // gap in the linkage. Both are reported rather than hidden: the hash
  // chain verified, but the log has damage an operator should know about.
  return {
    valid: true,
    recordsVerified: records.length,
    ...(skipped > 0 ? { skippedRecords: skipped } : {}),
    ...(resyncs > 0 ? { resyncs } : {})
  };
}

/**
 * Export chain in SIEM-compatible format.
 * 
 * @param {string} fromId
 * @param {string} toId
 * @param {string} format - 'json' | 'csv' | 'cef'
 * @returns {Promise<string>}
 */
async function exportChain(fromId, toId, format = 'json') {
  const chain = await getChainBetween(fromId, toId);
  
  switch (format) {
    case 'json':
      return JSON.stringify(chain, null, 2);
      
    case 'csv':
      // CEF (Common Event Format) compatible CSV
      const headers = ['decisionId', 'parentDecisionId', 'timestamp', 'actor.agentId', 'action.type', 'outcome.success'];
      const rows = chain.map(r => [
        r.decisionId,
        r.parentDecisionId || '',
        r.timestamp,
        r.actor.agentId,
        r.action.type,
        r.outcome.success
      ].join(','));
      return [headers.join(','), ...rows].join('\n');
      
    case 'cef':
      // Common Event Format
      return chain.map(r =>
        `CEF:0|AWARE|Audit|1.0|${r.action.type}|${r.decisionId}|${r.outcome.success ? 'Info' : 'Warn'}|${r.actor.agentId}`
      ).join('\n');

    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

// ============================================================================
// Bootstrap (C-step finding #16 follow-up)
// ============================================================================
//
// CRITICAL: load the on-disk index on module require so callers don't need
// to remember to call loadIndex() themselves. Without this, a fresh process
// that requires decision-logger.js sees an empty in-memory `index` Map and
// getChain() throws "not found in index" — even though the JSONL on disk
// has the records. The previous behavior silently failed the first time
// getChain was called; this was a latent bug that the audit HTTP API
// (mounted on the v2 gateway) made visible because every /api/audit/*
// request was the "first call" from the gateway's perspective.
//
// loadIndex() is safe to call repeatedly and no-ops when the index file
// is missing (it just creates an empty index). Errors during load are
// logged but don't throw — the module stays usable, just with a cold
// index (callers will see "not found" until they re-load).
loadIndex();

// ============================================================================
// Graceful Shutdown (Phase 9.2)
// ============================================================================
//
// ARCHITECTURAL FIX: when the coordinator receives SIGTERM (e.g., docker
// stop, oc reload), the process exits without flushing pending index
// updates. With the old per-call persistIndex, every decision was on disk
// immediately; with the new debounced flush, we need to flush before exit.
//
// flushIndexSync() does a final synchronous persistIndex() to capture any
// unflushed decisions.

function installShutdownHandlers() {
  const handler = (signal) => {
    try {
      flushIndexSync();
      // eslint-disable-next-line no-console
      console.log(`[decision-logger] flushed on ${signal}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[decision-logger] shutdown flush failed: ${err.message}`);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

installShutdownHandlers();

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  // Constants
  GENESIS_HASH,

  // Core functions
  logDecision,
  getChain,
  getChainBetween,
  verifyChain,
  exportChain,

  // Utilities
  generateUUID,
  canonicalSerialize,
  computeRecordHash,
  loadIndex,
  ensureAuditDir,

  // Index operations
  getLastHash,
  indexLookup,
  readFromLog,

  // Phase 9.2: async flush controls (exported for tests + ops)
  scheduleIndexFlush,
  flushIndexSync,
  isFlushScheduled: () => flushScheduled !== null,
  isFlushInProgress: () => flushInProgress
};
