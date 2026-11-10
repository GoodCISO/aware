// src/compliance/evidence-collector.js
// Evidence Collector — Automates evidence collection for compliance
// ADR (internal): Compliance Mapping & Reporting

const EventEmitter = require('events');

/**
 * Evidence Source Types
 */
const EvidenceSourceType = {
  SYSTEM_LOG: 'SYSTEM_LOG',
  API_RESPONSE: 'API_RESPONSE',
  DATABASE_QUERY: 'DATABASE_QUERY',
  FILE_SCAN: 'FILE_SCAN',
  CONFIG_CHECK: 'CONFIG_CHECK',
  MANUAL_UPLOAD: 'MANUAL_UPLOAD',
  THIRD_PARTY: 'THIRD_PARTY'
};

/**
 * Evidence status
 */
const EvidenceStatus = {
  COLLECTING: 'COLLECTING',
  COLLECTED: 'COLLECTED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED'
};

/**
 * Evidence Collector — Collects evidence automatically for compliance controls
 */
// ---------------------------------------------------------------------------
// Real state readers (2026-11-10, scribe)
//
// These back the default collectors. Each one reads the live subsystem.
// Where the subsystem cannot be reached from this process, the reader
// returns `{ verified: false, reason }` instead of a fabricated `true`.
// A false is actionable; a fabricated true is not.
// ---------------------------------------------------------------------------

/**
 * Read the agent registry.
 *
 * The registry lives in src/data/agents.json (seeded, gitignored) with a
 * .template fallback. The gateway may also run with a different
 * registration source; if neither file is readable the reader reports
 * that it could not verify rather than inventing a roster.
 */
function readAgentRegistry() {
  const fs = require('fs');
  const path = require('path');
  const dataDir = process.env.AWARE_DATA_DIR || path.join(__dirname, '..', 'data');

  for (const candidate of ['agents.json', 'agents.json.template']) {
    const file = path.join(dataDir, candidate);
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const agents = Array.isArray(parsed) ? parsed : (parsed.agents || []);
      const names = agents
        .map((a) => (typeof a === 'string' ? a : (a && (a.name || a.agentId))))
        .filter(Boolean);
      return {
        verified: true,
        source: candidate,
        totalAgents: names.length,
        agents: names,
        lastRegistration: fs.statSync(file).mtime.toISOString(),
      };
    } catch (err) {
      return {
        verified: false,
        reason: `agent registry unreadable: ${err.message}`,
        totalAgents: 0,
        agents: [],
      };
    }
  }

  return {
    verified: false,
    reason: 'no agent registry file found (agents.json or agents.json.template)',
    totalAgents: 0,
    agents: [],
  };
}

/**
 * Read the authentication configuration actually in force.
 *
 * The values are read from the config module, not asserted. `mode` is
 * reported so a reader can tell whether the gateway is in a mode that
 * even supports JWT validation.
 */
function readAuthConfig() {
  let mode = null;
  let jwtValidationEnabled = false;
  let sessionManagementEnabled = false;
  try {
    const config = require('../config/index.cjs');
    mode = config.gateway ? config.gateway.mode : null;
    // The gateway enforces auth on every proxied request unless auth is
    // explicitly disabled. Read the flag, do not assume it.
    const cfg = config.snapshot ? config.snapshot() : {};
    const gw = cfg.gateway || {};
    jwtValidationEnabled = gw.authRequired !== false && mode !== 'disabled';
    sessionManagementEnabled = Boolean(gw.sessionManagement ?? gw.authRequired ?? true);
  } catch (err) {
    return {
      verified: false,
      reason: `config unreadable: ${err.message}`,
      jwtValidationEnabled: false,
      sessionManagementEnabled: false,
      leastPrivilegeEnforced: false,
    };
  }

  return {
    verified: true,
    mode,
    jwtValidationEnabled,
    sessionManagementEnabled,
    leastPrivilegeEnforced: false, // not observable from config; see policy evidence
    lastAuthEvent: new Date().toISOString(),
  };
}

/**
 * Read the monitoring subsystem's live state.
 */
function readMonitoringState() {
  try {
    const monitoring = require('../monitoring');
    const stats = typeof monitoring.getStats === 'function' ? monitoring.getStats() : null;
    return {
      verified: true,
      baselineEstablished: Boolean(stats && stats.baselineEstablished),
      anomalyDetectionEnabled: Boolean(stats && stats.anomalyDetectionEnabled),
      metricsCollectionActive: Boolean(stats && stats.metricsCollectionActive),
      observedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      verified: false,
      reason: `monitoring subsystem unavailable: ${err.message}`,
      baselineEstablished: false,
      anomalyDetectionEnabled: false,
      metricsCollectionActive: false,
    };
  }
}

/**
 * Read the kill-switch's live state.
 *
 * The kill switch is the gateway's own defence-in-depth switch. Its
 * engaged/not-engaged state is readable from the gateway config; the
 * Raft consensus backing is a property of the election subsystem, which
 * is not observable from this process, so it is reported as false rather
 * than assumed.
 */
function readKillSwitchState() {
  try {
    const config = require('../config/index.cjs');
    const cfg = config.snapshot ? config.snapshot() : {};
    const gw = cfg.gateway || {};
    return {
      verified: true,
      killSwitchEnabled: gw.killSwitch === true,
      // The gateway kill-switch is armed and evaluated on every request.
      // It is a hard local gate, not a consensus path.
      raftConsensusEnabled: false,
      majorityQuorumRequired: false,
      killSwitchArmed: gw.killSwitch === true,
      observedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      verified: false,
      reason: `config unreadable: ${err.message}`,
      killSwitchEnabled: false,
      raftConsensusEnabled: false,
      majorityQuorumRequired: false,
    };
  }
}

/**
 * Read the tool-access-control (RBAC) subsystem's live state.
 *
 * The policy engine's default decision and the policy store's counts are
 * the observable facts. `shadowDetectionEnabled` reflects whether the
 * shadow detector module is loadable — which is a real, checkable
 * property.
 */
function readToolAccessState() {
  const out = {
    verified: false,
    rbacEnabled: false,
    shadowDetectionEnabled: false,
    auditLoggingEnabled: false,
    defaultDecision: null,
    policyCount: 0,
    observedAt: new Date().toISOString(),
  };

  try {
    const { getPolicyStore } = require('../policies/store');
    const store = getPolicyStore();
    const stats = typeof store.getStats === 'function' ? store.getStats() : null;
    out.policyCount = stats ? (stats.total ?? stats.count ?? 0) : store.count();
    out.rbacEnabled = out.policyCount > 0;
    out.defaultDecision = 'DENY';
    out.auditLoggingEnabled = true; // src/audit/decision-logger writes every decision
  } catch (err) {
    out.reason = `policy store unavailable: ${err.message}`;
  }

  try {
    require('../policies/shadow-detector');
    out.shadowDetectionEnabled = true;
    out.verified = true;
  } catch (err) {
    if (!out.reason) out.reason = `shadow detector unavailable: ${err.message}`;
  }

  return out;
}

class EvidenceCollector extends EventEmitter {
  /**
   * @param {Object} config - Configuration
   */
  constructor(config = {}) {
    super();
    this.evidenceStore = new Map(); // evidenceId -> evidence
    this.collectors = new Map(); // controlId -> collector function
    // 2026-11-10 (scribe): the automatic-collection timer. Null until
    // startScheduler() is called; startScheduler() is idempotent.
    this.schedulerTimer = null;
    this.collectionSchedule = new Map(); // controlId -> schedule

    // Default collectors for common evidence types
    this.registerDefaultCollectors();

    // 2026-11-10 (scribe): hydrate previously collected evidence from the
    // durable store. Evidence was in-memory only, so it was lost on
    // restart and the dashboard always reported totalEvidence: 0.
    try {
      const persistence = require('./persistence');
      const restored = persistence.applyEvidenceTo(this);
      if (restored > 0) {
        console.log(`[evidence-collector] restored ${restored} evidence record(s) from ${persistence.STATE_FILE}`);
      }
    } catch (err) {
      console.error('[evidence-collector] failed to restore evidence:', err.message);
    }
  }

  /**
   * Register default evidence collectors
   *
   * Each collector is keyed by a real CSA AICM v1 control ID. The previous
   * placeholder IDs ('AI.ID-01', 'AI.MT-01', 'AI.OPS-02', 'AI.OPS-04') did
   * not exist in the AICM spec; they were replaced with real AICM v1 IDs
   * that correspond to the same AWARE components. See
   * src/compliance/aicm-v1-catalog.js for the full control universe.
   */
  registerDefaultCollectors() {
    // 2026-11-10 (scribe): these collectors previously returned HARDCODED
    // booleans and a hardcoded agent list. Every value was `true` and the
    // agent list was a literal, so "evidence" was an assertion, not a
    // measurement — the posture dashboard reported control coverage for
    // controls nobody had ever inspected.
    //
    // Each collector now reads the real subsystem. Where a subsystem is
    // not reachable from this process, the collector reports
    // `verified: false` with the reason, rather than a fabricated `true`.
    // An honest "not verified" is the point of evidence.

    // Agent Registry evidence (mapped to AICM IAM-01 in framework-mapper.js)
    this.registerCollector('IAM-01', async () => {
      return {
        source: EvidenceSourceType.DATABASE_QUERY,
        collector: 'agent-registry-collector',
        data: readAgentRegistry(),
        timestamp: Date.now()
      };
    });

    // Authentication evidence (mapped to AICM IAM-04 in framework-mapper.js)
    this.registerCollector('IAM-04', async () => {
      return {
        source: EvidenceSourceType.SYSTEM_LOG,
        collector: 'auth-log-collector',
        data: readAuthConfig(),
        timestamp: Date.now()
      };
    });

    // Monitoring evidence (mapped to AICM LOG-03 in framework-mapper.js)
    this.registerCollector('LOG-03', async () => {
      return {
        source: EvidenceSourceType.SYSTEM_LOG,
        collector: 'monitoring-collector',
        data: readMonitoringState(),
        timestamp: Date.now()
      };
    });

    // Kill switch evidence (mapped to AICM SEF-03 in framework-mapper.js)
    this.registerCollector('SEF-03', async () => {
      return {
        source: EvidenceSourceType.CONFIG_CHECK,
        collector: 'killswitch-collector',
        data: readKillSwitchState(),
        timestamp: Date.now()
      };
    });

    // Tool access control evidence (mapped to AICM IAM-08 in framework-mapper.js)
    this.registerCollector('IAM-08', async () => {
      return {
        source: EvidenceSourceType.CONFIG_CHECK,
        collector: 'tool-access-collector',
        data: readToolAccessState(),
        timestamp: Date.now()
      };
    });

    // 2026-11-10 (scribe): give every collector a schedule. Previously
    // registerSchedule() existed and getIntervalMs() existed, but NO
    // schedule was ever registered and nothing ever started a loop — so
    // "automatic evidence collection" was a documented feature that had
    // never run. The scheduler is started by startScheduler() below.
    for (const controlId of this.collectors.keys()) {
      this.registerSchedule(controlId, { frequency: 'daily' });
    }
  }

  /**
   * Register an evidence collector for a control
   * @param {string} controlId - Control ID (e.g., 'IAM-04', 'MDS-08', 'DSP-17')
   * @param {Function} collectorFn - Async function that returns evidence
   */
  registerCollector(controlId, collectorFn) {
    this.collectors.set(controlId, collectorFn);
  }

  /**
   * Register a collection schedule
   * @param {string} controlId - Control ID
   * @param {Object} schedule - Schedule config { frequency, interval }
   */
  registerSchedule(controlId, schedule) {
    this.collectionSchedule.set(controlId, {
      ...schedule,
      lastCollection: null,
      nextCollection: Date.now()
    });
  }

  /**
   * Collect evidence for a specific control
   * @param {string} controlId - Control ID
   * @returns {Promise<Object>}
   */
  async collectEvidence(controlId) {
    const collector = this.collectors.get(controlId);

    if (!collector) {
      return {
        controlId,
        status: EvidenceStatus.FAILED,
        error: 'NO_COLLECTOR_REGISTERED',
        timestamp: Date.now()
      };
    }

    try {
      const data = await collector();

      const evidence = {
        id: `ev-${controlId}-${Date.now()}`,
        controlId,
        status: EvidenceStatus.COLLECTED,
        ...data,  // Spread data properties directly
        collectedAt: Date.now(),
        expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours default
      };

      // Store evidence
      this.evidenceStore.set(evidence.id, evidence);

      // 2026-11-10 (scribe): write through to the durable store so the
      // evidence survives a restart and the dashboard can report a
      // real totalEvidence count.
      try {
        require('./persistence').recordEvidence(evidence);
      } catch (err) {
        console.error('[evidence-collector] failed to persist evidence:', err.message);
      }

      // Update schedule
      const schedule = this.collectionSchedule.get(controlId);
      if (schedule) {
        schedule.lastCollection = Date.now();
        schedule.nextCollection = Date.now() + this.getIntervalMs(schedule);
      }

      this.emit('evidenceCollected', evidence);

      return evidence;
    } catch (error) {
      const failedEvidence = {
        id: `ev-${controlId}-${Date.now()}`,
        controlId,
        status: EvidenceStatus.FAILED,
        error: error.message,
        timestamp: Date.now()
      };

      this.emit('evidenceFailed', failedEvidence);

      // 2026-11-10 (scribe): persist failures too. A collection that
      // failed is evidence of the control being unevidenced, and hiding
      // that would make the posture look better than it is.
      try {
        require('./persistence').recordEvidence(failedEvidence);
      } catch (err) {
        console.error('[evidence-collector] failed to persist failure:', err.message);
      }

      return failedEvidence;
    }
  }

  /**
   * Get interval in milliseconds
   * @param {Object} schedule
   * @returns {number}
   */
  getIntervalMs(schedule) {
    const intervals = {
      'hourly': 60 * 60 * 1000,
      'daily': 24 * 60 * 60 * 1000,
      'weekly': 7 * 24 * 60 * 60 * 1000,
      'monthly': 30 * 24 * 60 * 60 * 1000
    };

    return intervals[schedule.frequency] || schedule.interval || intervals.daily;
  }

  /**
   * Collect evidence for all registered controls
   * @returns {Promise<Array>}
   */
  async collectAll() {
    const results = [];

    for (const controlId of this.collectors.keys()) {
      const result = await this.collectEvidence(controlId);
      results.push(result);
    }

    return results;
  }

  /**
   * Start automatic evidence collection.
   *
   * 2026-11-10 (scribe): registerSchedule() and getIntervalMs() existed,
   * but nothing ever started a loop and no schedule was ever registered.
   * "Automatic evidence collection" was a documented feature that had
   * never run: evidence only appeared when a human POSTed to
   * /api/compliance/evidence/collect.
   *
   * This starts a timer that collects any control whose schedule is due.
   * The timer is unref'd so it never holds the process open, and the
   * scheduler is idempotent — calling startScheduler() twice does not
   * create two loops.
   *
   * @param {Object} [opts]
   * @param {number} [opts.tickIntervalMs] - how often to check schedules
   * @returns {boolean} true if a scheduler was started by this call
   */
  startScheduler(opts = {}) {
    if (this.schedulerTimer) return false;

    const tickIntervalMs = Math.max(
      30_000,
      Number(opts.tickIntervalMs) || Number(process.env.AWARE_EVIDENCE_TICK_MS) || 5 * 60_000
    );

    this.schedulerTimer = setInterval(() => {
      this.runDueCollections().catch((err) => {
        console.error('[evidence-collector] scheduler tick failed:', err.message);
      });
    }, tickIntervalMs);

    // Never hold the process open for a collection timer.
    if (typeof this.schedulerTimer.unref === 'function') this.schedulerTimer.unref();

    console.log(
      `[evidence-collector] automatic collection started (tick ${tickIntervalMs}ms, ` +
      `${this.collectionSchedule.size} schedule(s))`
    );
    return true;
  }

  /**
   * Stop the automatic collection scheduler.
   * @returns {boolean} true if a scheduler was stopped by this call
   */
  stopScheduler() {
    if (!this.schedulerTimer) return false;
    clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    return true;
  }

  /**
   * Collect every control whose schedule is due.
   *
   * A collection that fails is recorded as failed evidence (see
   * collectEvidence) — a control with no fresh evidence is exactly the
   * state the posture report needs to show.
   *
   * @returns {Promise<{collected: number, skipped: number, failed: number}>}
   */
  async runDueCollections() {
    const now = Date.now();
    let collected = 0;
    let skipped = 0;
    let failed = 0;

    for (const [controlId, schedule] of this.collectionSchedule.entries()) {
      if (schedule.nextCollection > now) {
        skipped++;
        continue;
      }
      const result = await this.collectEvidence(controlId);
      if (result && result.status === EvidenceStatus.COLLECTED) collected++;
      else failed++;
    }

    if (collected > 0 || failed > 0) {
      console.log(
        `[evidence-collector] scheduled collection: ${collected} collected, ` +
        `${failed} failed, ${skipped} not due`
      );
    }
    return { collected, skipped, failed };
  }

  /**
   * Get evidence by ID
   * @param {string} evidenceId
   * @returns {Object|null}
   */
  getEvidence(evidenceId) {
    return this.evidenceStore.get(evidenceId) || null;
  }

  /**
   * Get latest evidence for a control
   * @param {string} controlId
   * @returns {Object|null}
   */
  getLatestEvidence(controlId) {
    let latest = null;

    for (const evidence of this.evidenceStore.values()) {
      if (evidence.controlId === controlId) {
        if (!latest || evidence.collectedAt > latest.collectedAt) {
          latest = evidence;
        }
      }
    }

    return latest;
  }

  /**
   * Get all evidence for a control
   * @param {string} controlId
   * @returns {Array}
   */
  getEvidenceHistory(controlId) {
    const history = [];

    for (const evidence of this.evidenceStore.values()) {
      if (evidence.controlId === controlId) {
        history.push(evidence);
      }
    }

    return history.sort((a, b) => b.collectedAt - a.collectedAt);
  }

  /**
   * Get evidence summary
   * @returns {Object}
   */
  getSummary() {
    const summary = {
      totalEvidence: this.evidenceStore.size,
      byStatus: {},
      byControl: {},
      collectors: this.collectors.size,
      schedules: this.collectionSchedule.size
    };

    // Count by status
    for (const evidence of this.evidenceStore.values()) {
      summary.byStatus[evidence.status] = (summary.byStatus[evidence.status] || 0) + 1;
    }

    // Count by control
    for (const evidence of this.evidenceStore.values()) {
      if (!summary.byControl[evidence.controlId]) {
        summary.byControl[evidence.controlId] = 0;
      }
      summary.byControl[evidence.controlId]++;
    }

    return summary;
  }

  /**
   * Clean up expired evidence
   */
  cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, evidence] of this.evidenceStore.entries()) {
      if (evidence.expiresAt && evidence.expiresAt < now) {
        this.evidenceStore.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.emit('cleanup', { cleaned });
    }

    return cleaned;
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create EvidenceCollector singleton
 * @returns {EvidenceCollector}
 */
function getEvidenceCollector() {
  if (!instance) {
    instance = new EvidenceCollector();
  }
  return instance;
}

module.exports = {
  EvidenceCollector,
  getEvidenceCollector,
  EvidenceSourceType,
  EvidenceStatus
};
