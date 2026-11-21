// src/compliance/boe-pra-fca-ai-cyber-evidence.js
// Evidence collectors for the PRA / FCA / BoE AI cyber-risk catalogue
// (ADR-084 §D6).
//
// WHAT THIS IS
// ------------
// One collector per paragraph of the "Effective practices: cyber risk and
// resilience management relating to AI" catalogue. Each collector reads a
// REAL AWARE subsystem and reports what it found. Where the subsystem
// cannot be reached from this process, the collector reports
// `{ verified: false, reason }` rather than a fabricated `true`.
//
// The rule is the same one the existing default collectors follow
// (evidence-collector.js, 2026-11-10): "An honest 'not verified' is the
// point of evidence." A fabricated `true` is worse than an absent control,
// because the second line of defence would rely on it.
//
// THE SOURCE CAVEAT
// ------------------
// The upstream paper was NOT retrievable when this was written (2026-11-21).
// These collectors therefore evidence AWARE's OWN control surface. They do
// NOT evidence conformance to a paragraph whose text has never been read.
// Every evidence record produced here carries `sourceStatus` so a consumer
// cannot mistake it for a verified regulatory mapping. See the catalogue
// header and ADR-084 §D4.
//
// @module compliance/boe-pra-fca-ai-cyber-evidence
// @license Apache-2.0

'use strict';

const fs = require('fs');
const path = require('path');

const {
  BOE_PRA_FCA_AI_CYBER_CONTROLS,
  BOE_PRA_FCA_AI_CYBER_CONTROL_IDS,
  BOE_PRA_FCA_AI_CYBER_SOURCE_VERIFIED
} = require('./boe-pra-fca-ai-cyber-catalog');

/**
 * Evidence source types, mirroring the enum in evidence-collector.js.
 * Declared locally so this module has no import cycle with the collector.
 */
const EVIDENCE_SOURCE_TYPE = {
  SYSTEM_LOG: 'SYSTEM_LOG',
  API_RESPONSE: 'API_RESPONSE',
  DATABASE_QUERY: 'DATABASE_QUERY',
  FILE_SCAN: 'FILE_SCAN',
  CONFIG_CHECK: 'CONFIG_CHECK',
  MANUAL_UPLOAD: 'MANUAL_UPLOAD',
  THIRD_PARTY: 'THIRD_PARTY'
};

/**
 * Read the live agent registry.
 *
 * The registry lives in src/data/agents.json (gitignored; seeded at deploy).
 * If it is unreadable the reader reports that it could not verify rather
 * than inventing a roster.
 *
 * @returns {Object}
 */
function readRegistryState() {
  try {
    const { Agent, AgentState } = require('../api/models/Agent');
    const agents = Agent.all ? Agent.all() : [];
    const byState = {};
    for (const a of agents) {
      const st = a.state || 'unknown';
      byState[st] = (byState[st] || 0) + 1;
    }
    const revoked = agents.filter(a => a.state === AgentState.REVOKED);
    return {
      verified: true,
      agentCount: agents.length,
      byState,
      revokedCount: revoked.length,
      revokedAgentIds: revoked.map(a => a.agentId),
      observedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      verified: false,
      reason: `agent registry unavailable: ${err.message}`,
      agentCount: 0,
      byState: {},
      revokedCount: 0,
      revokedAgentIds: [],
      observedAt: new Date().toISOString()
    };
  }
}

/**
 * Read the live policy store — the per-call RBAC surface.
 *
 * `defaultDecision` is read from the policy engine's own module, not
 * hardcoded, so this evidence cannot drift from the enforcement path.
 *
 * @returns {Object}
 */
function readPolicyStoreState() {
  try {
    const { getPolicyStore } = require('../policies/store');
    const { DEFAULT_DECISION } = require('../policies/engine');
    const store = getPolicyStore();
    const stats = typeof store.getStats === 'function' ? store.getStats() : null;
    const policyCount = stats ? (stats.total ?? stats.count ?? 0) : store.count();
    return {
      verified: true,
      policyCount,
      defaultDecision: DEFAULT_DECISION,
      defaultDenyEnforced: DEFAULT_DECISION === 'DENY',
      observedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      verified: false,
      reason: `policy store unavailable: ${err.message}`,
      policyCount: 0,
      defaultDecision: null,
      defaultDenyEnforced: false,
      observedAt: new Date().toISOString()
    };
  }
}

/**
 * Read the tool-observation / credential-classification surface.
 *
 * These are LOADABLE-module checks plus a real registry read: if the
 * credential classifier cannot be required, the data-governance control is
 * not present in this process and the evidence says so.
 *
 * @returns {Object}
 */
function readObservationState() {
  const out = {
    verified: false,
    toolObservationProxyLoadable: false,
    credentialClassifierLoadable: false,
    shadowDetectorLoadable: false,
    classifierVersion: null,
    observedAt: new Date().toISOString()
  };
  const reasons = [];
  try {
    require('../policies/tool-observation-proxy');
    out.toolObservationProxyLoadable = true;
  } catch (err) {
    reasons.push(`tool-observation-proxy: ${err.message}`);
  }
  try {
    const cc = require('../policies/credential-classifier');
    out.credentialClassifierLoadable = true;
    out.classifierVersion = cc.CLASSIFIER_VERSION || null;
  } catch (err) {
    reasons.push(`credential-classifier: ${err.message}`);
  }
  try {
    require('../policies/shadow-detector');
    out.shadowDetectorLoadable = true;
  } catch (err) {
    reasons.push(`shadow-detector: ${err.message}`);
  }
  out.verified = out.toolObservationProxyLoadable && out.credentialClassifierLoadable;
  if (reasons.length) out.reason = reasons.join('; ');
  return out;
}

/**
 * Read the skill-scanner surface (third-party / supply-chain).
 *
 * @returns {Object}
 */
function readSkillScannerState() {
  try {
    const scanner = require('../compliance/skill-scanner');
    const version = scanner.SCANNER_VERSION || scanner.DEFAULT_SCANNER_VERSION || null;
    return {
      verified: true,
      scannerLoadable: true,
      scannerVersion: version,
      defaultScanner: scanner.DEFAULT_SCANNER || null,
      observedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      verified: false,
      reason: `skill scanner unavailable: ${err.message}`,
      scannerLoadable: false,
      scannerVersion: null,
      defaultScanner: null,
      observedAt: new Date().toISOString()
    };
  }
}

/**
 * Read the kill-switch / revocation surface.
 *
 * @returns {Object}
 */
function readKillSwitchState() {
  try {
    const config = require('../config/index.cjs');
    const cfg = config.snapshot ? config.snapshot() : {};
    const gw = cfg.gateway || {};
    const registry = readRegistryState();
    return {
      verified: true,
      gatewayKillSwitchArmed: gw.killSwitch === true,
      revokedAgentCount: registry.revokedCount,
      revokedAgentIds: registry.revokedAgentIds,
      observedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      verified: false,
      reason: `kill switch state unavailable: ${err.message}`,
      gatewayKillSwitchArmed: false,
      revokedAgentCount: 0,
      revokedAgentIds: [],
      observedAt: new Date().toISOString()
    };
  }
}

/**
 * Read the audit chain — the T0 decision log.
 *
 * The chain's integrity is checkable independently: `scripts/verify_chain.py`
 * re-implements the canonicalisation in pure Python so an auditor does not
 * have to trust AWARE. This reader reports the chain's SIZE and whether the
 * verifier is available; it does not re-implement the hash.
 *
 * @returns {Object}
 */
function readAuditChainState() {
  const auditDir = process.env.AUDIT_DIR || '/data/audit';
  const chainFile = path.join(auditDir, 'decision-chain.jsonl');
  const out = {
    verified: false,
    auditDir,
    chainFile,
    chainExists: false,
    recordCount: 0,
    verifierAvailable: null,
    observedAt: new Date().toISOString()
  };
  try {
    out.chainExists = fs.existsSync(chainFile);
    if (out.chainExists) {
      const raw = fs.readFileSync(chainFile, 'utf8');
      out.recordCount = raw.split('\n').filter(l => l.trim().length > 0).length;
      out.verified = true;
    } else {
      out.reason = `decision chain not present at ${chainFile} (set AUDIT_DIR to the chain volume)`;
    }
  } catch (err) {
    out.reason = `decision chain unreadable: ${err.message}`;
  }
  // The independent verifier ships with the repo. Report whether it is
  // reachable; running it is the auditor's step, not ours.
  try {
    const verifier = path.resolve(__dirname, '..', '..', 'scripts', 'verify_chain.py');
    out.verifierAvailable = fs.existsSync(verifier);
  } catch (_err) {
    out.verifierAvailable = false;
  }
  return out;
}

/**
 * Read the compliance posture / gap state.
 *
 * @returns {Object}
 */
function readComplianceState() {
  try {
    const { getPostureCalculator } = require('./posture-calculator');
    const { getGapTracker } = require('./gap-tracker');
    const posture = getPostureCalculator();
    const gaps = getGapTracker();
    const stats = typeof gaps.getStats === 'function' ? gaps.getStats() : null;
    const allGaps = typeof gaps.getAllGaps === 'function' ? gaps.getAllGaps() : [];
    return {
      verified: true,
      postureCalculatorLoadable: true,
      gapTrackerLoadable: true,
      gapCount: stats ? (stats.total ?? allGaps.length) : allGaps.length,
      openGapCount: allGaps.filter(g => g.status !== 'closed' && g.status !== 'remediated').length,
      observedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      verified: false,
      reason: `compliance state unavailable: ${err.message}`,
      postureCalculatorLoadable: false,
      gapTrackerLoadable: false,
      gapCount: 0,
      openGapCount: 0,
      observedAt: new Date().toISOString()
    };
  }
}

/**
 * Read the scenario-harness evidence.
 *
 * The harness (ADR-086) writes its per-scenario results to
 * `test/results/`. Until that harness ships, there is no result file, and
 * the evidence says so rather than reporting a fabricated pass.
 *
 * @returns {Object}
 */
function readScenarioState() {
  const resultsDir = path.resolve(__dirname, '..', '..', 'test', 'results');
  const out = {
    verified: false,
    resultsDir,
    resultsPresent: false,
    scenarioCount: 0,
    passedCount: 0,
    failedCount: 0,
    scenarios: [],
    observedAt: new Date().toISOString()
  };
  try {
    if (!fs.existsSync(resultsDir)) {
      out.reason = `scenario results directory not present at ${resultsDir}`;
      return out;
    }
    const files = fs.readdirSync(resultsDir).filter(f => /scenario.*\.json$/.test(f));
    if (files.length === 0) {
      out.reason = `no scenario result files in ${resultsDir}`;
      return out;
    }
    const scenarios = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
        scenarios.push(parsed);
      } catch (_err) {
        // A malformed result file is skipped, not counted as a pass.
      }
    }
    out.resultsPresent = true;
    out.scenarios = scenarios;
    out.scenarioCount = scenarios.length;
    out.passedCount = scenarios.filter(s => s.passed === true || s.result === 'pass').length;
    out.failedCount = scenarios.filter(s => s.passed === false || s.result === 'fail').length;
    out.verified = scenarios.length > 0;
    if (!out.verified) out.reason = 'scenario result files contained no parsable results';
  } catch (err) {
    out.reason = `scenario results unreadable: ${err.message}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-paragraph collectors
// ---------------------------------------------------------------------------

/**
 * The collector table. One entry per catalogue paragraph.
 *
 * Each collector returns the shape evidence-collector.js expects:
 * `{ source, collector, data, timestamp }`. `data` carries the real
 * reading plus the `sourceStatus` caveat.
 *
 * @type {Object<string, Function>}
 */
const BOE_PRA_FCA_AI_CYBER_COLLECTORS = Object.freeze({
  // 2.3 — Accountability for AI in cyber risk.
  '2.3': async () => ({
    source: EVIDENCE_SOURCE_TYPE.SYSTEM_LOG,
    collector: 'boe-pra-fca-2.3-accountability',
    data: {
      ...readComplianceState(),
      registry: readRegistryState()
    },
    timestamp: Date.now()
  }),

  // 4.2 — Inventory of AI use cases.
  '4.2': async () => ({
    source: EVIDENCE_SOURCE_TYPE.DATABASE_QUERY,
    collector: 'boe-pra-fca-4.2-inventory',
    data: readRegistryState(),
    timestamp: Date.now()
  }),

  // 4.4 — Third-party and model supply-chain risk.
  '4.4': async () => ({
    source: EVIDENCE_SOURCE_TYPE.FILE_SCAN,
    collector: 'boe-pra-fca-4.4-supply-chain',
    data: {
      ...readSkillScannerState(),
      observation: readObservationState()
    },
    timestamp: Date.now()
  }),

  // 6.6 — Access control for AI systems.
  '6.6': async () => ({
    source: EVIDENCE_SOURCE_TYPE.CONFIG_CHECK,
    collector: 'boe-pra-fca-6.6-access-control',
    data: readPolicyStoreState(),
    timestamp: Date.now()
  }),

  // 7.5 — Data governance for AI inputs and outputs.
  '7.5': async () => ({
    source: EVIDENCE_SOURCE_TYPE.SYSTEM_LOG,
    collector: 'boe-pra-fca-7.5-data-governance',
    data: readObservationState(),
    timestamp: Date.now()
  }),

  // 8.2 — Logging and monitoring of AI activity.
  '8.2': async () => ({
    source: EVIDENCE_SOURCE_TYPE.SYSTEM_LOG,
    collector: 'boe-pra-fca-8.2-logging',
    data: {
      ...readAuditChainState(),
      compliance: readComplianceState()
    },
    timestamp: Date.now()
  }),

  // 8.5 — State rollback and memory integrity.
  '8.5': async () => ({
    source: EVIDENCE_SOURCE_TYPE.SYSTEM_LOG,
    collector: 'boe-pra-fca-8.5-state-integrity',
    data: {
      ...readKillSwitchState(),
      auditChain: readAuditChainState()
    },
    timestamp: Date.now()
  }),

  // 9.1 — Revocation of AI identities and credentials.
  '9.1': async () => ({
    source: EVIDENCE_SOURCE_TYPE.DATABASE_QUERY,
    collector: 'boe-pra-fca-9.1-revocation',
    data: {
      ...readRegistryState(),
      killSwitch: readKillSwitchState()
    },
    timestamp: Date.now()
  }),

  // 10.2 — Incident response for AI-related incidents.
  '10.2': async () => ({
    source: EVIDENCE_SOURCE_TYPE.CONFIG_CHECK,
    collector: 'boe-pra-fca-10.2-incident-response',
    data: readKillSwitchState(),
    timestamp: Date.now()
  }),

  // 10.4 — Assurance testing of AI controls.
  '10.4': async () => ({
    source: EVIDENCE_SOURCE_TYPE.SYSTEM_LOG,
    collector: 'boe-pra-fca-10.4-assurance',
    data: readScenarioState(),
    timestamp: Date.now()
  }),

  // 10.5 — Third-party assurance and attestation.
  '10.5': async () => ({
    source: EVIDENCE_SOURCE_TYPE.THIRD_PARTY,
    collector: 'boe-pra-fca-10.5-third-party-assurance',
    data: {
      ...readComplianceState(),
      auditChain: readAuditChainState()
    },
    timestamp: Date.now()
  }),

  // 11.1 — Exercises and adversarial validation.
  '11.1': async () => ({
    source: EVIDENCE_SOURCE_TYPE.SYSTEM_LOG,
    collector: 'boe-pra-fca-11.1-exercises',
    data: readScenarioState(),
    timestamp: Date.now()
  })
});

/**
 * Register the catalogue's collectors on an evidence collector instance.
 *
 * The controlId used by the collector is the PARAGRAPH NUMBER (e.g. '8.2'),
 * because that is what the catalogue, the framework mapper and the
 * compliance report all key on.
 *
 * @param {Object} collector - an EvidenceCollector instance
 * @returns {number} the number of collectors registered
 */
function registerBoePraFcaAiCyberCollectors(collector) {
  let count = 0;
  for (const pid of BOE_PRA_FCA_AI_CYBER_CONTROL_IDS) {
    const fn = BOE_PRA_FCA_AI_CYBER_COLLECTORS[pid];
    if (!fn) continue;
    collector.registerCollector(pid, async () => {
      const result = await fn();
      // The source caveat travels with EVERY record so a consumer that
      // reads only the evidence cannot mistake it for a verified
      // regulatory mapping.
      return {
        ...result,
        data: {
          ...result.data,
          frameworkId: 'BOE_PRA_FCA_AI_CYBER',
          paragraph: pid,
          awareness: BOE_PRA_FCA_AI_CYBER_CONTROLS[pid].awareness,
          sourceStatus: BOE_PRA_FCA_AI_CYBER_CONTROLS[pid].sourceStatus,
          sourceVerified: BOE_PRA_FCA_AI_CYBER_SOURCE_VERIFIED
        }
      };
    });
    count += 1;
  }
  return count;
}

/**
 * Build the exportable second-line report for the catalogue.
 *
 * Every paragraph appears, whether or not evidence was collected. A
 * paragraph with no evidence is reported as such — the absence is the
 * finding. The report carries the source caveat at the top so it cannot
 * be forwarded without it.
 *
 * @param {Object} [options]
 * @param {Object} [options.evidenceCollector] - collector instance to read from
 * @param {Object[]} [options.evidence] - evidence records to render
 * @returns {Object}
 */
function buildSecondLineReport(options = {}) {
  const evidence = options.evidence || [];
  const byControl = new Map();
  for (const e of evidence) {
    if (!byControl.has(e.controlId)) byControl.set(e.controlId, []);
    byControl.get(e.controlId).push(e);
  }

  const paragraphs = BOE_PRA_FCA_AI_CYBER_CONTROL_IDS.map((pid) => {
    const entry = BOE_PRA_FCA_AI_CYBER_CONTROLS[pid];
    const records = byControl.get(pid) || [];
    const latest = records.length > 0 ? records[records.length - 1] : null;
    let status = 'NO_EVIDENCE';
    if (latest) {
      if (latest.status === 'COLLECTED') {
        status = latest.data && latest.data.verified === false ? 'UNVERIFIED' : 'EVIDENCED';
      } else {
        status = 'FAILED';
      }
    }
    return {
      paragraph: pid,
      name: entry.name,
      theme: entry.paragraphTheme,
      awareness: entry.awareness,
      crosswalkConfidence: entry.crosswalkConfidence,
      awareComponents: entry.awareComponents,
      evidenceStatus: status,
      evidenceRecordCount: records.length,
      latestEvidenceId: latest ? latest.id : null,
      latestCollectedAt: latest ? (latest.collectedAt || latest.timestamp || null) : null,
      reason: latest && latest.data && latest.data.reason ? latest.data.reason : null,
      // The caveat is repeated per paragraph so a row extracted from the
      // table still carries it.
      sourceStatus: entry.sourceStatus,
      regulatorText: entry.regulatorText
    };
  });

  const summary = { evidenced: 0, unverified: 0, failed: 0, noEvidence: 0 };
  for (const p of paragraphs) {
    if (p.evidenceStatus === 'EVIDENCED') summary.evidenced += 1;
    else if (p.evidenceStatus === 'UNVERIFIED') summary.unverified += 1;
    else if (p.evidenceStatus === 'FAILED') summary.failed += 1;
    else summary.noEvidence += 1;
  }

  return {
    reportType: 'UK_REGULATOR_AI_CYBER_SECOND_LINE',
    frameworkId: 'BOE_PRA_FCA_AI_CYBER',
    frameworkName: 'PRA / FCA / Bank of England — Effective practices: cyber risk and resilience management relating to AI',
    generatedAt: new Date().toISOString(),
    sourceVerified: BOE_PRA_FCA_AI_CYBER_SOURCE_VERIFIED,
    sourceCaveat: BOE_PRA_FCA_AI_CYBER_SOURCE_VERIFIED
      ? null
      : 'Upstream paper not retrieved (2026-11-21). This report evidences AWARE\'s own control surface only. It does NOT evidence conformance to the paper\'s text, which has never been read. The paper is non-binding guidance; this report asserts no regulatory compliance and no certification.',
    nonBindingNotice: 'The referenced material is non-binding supervisory guidance. This report is a control-surface evidence summary, not a compliance opinion.',
    paragraphs,
    summary,
    totalParagraphs: paragraphs.length
  };
}

module.exports = {
  BOE_PRA_FCA_AI_CYBER_COLLECTORS,
  registerBoePraFcaAiCyberCollectors,
  buildSecondLineReport,
  EVIDENCE_SOURCE_TYPE
};
