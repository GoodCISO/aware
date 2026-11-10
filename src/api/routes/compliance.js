// src/api/routes/compliance.js
// Compliance API Routes
// ADR (internal): Compliance Mapping & Reporting

const express = require('express');
const router = express.Router();

const {
  getFrameworkMapper,
  FRAMEWORKS
} = require('../../compliance/framework-mapper');

const {
  getEvidenceCollector,
  EvidenceStatus
} = require('../../compliance/evidence-collector');

const {
  getPostureCalculator,
  ComplianceStatus,
  GapSeverity
} = require('../../compliance/posture-calculator');

const {
  getGapTracker,
  GapStatus
} = require('../../compliance/gap-tracker');

const {
  getReportGenerator,
  ReportType
} = require('../../compliance/report-generator');

// ADR-043: AST10 risk-class annotations ride on the decision chain as
// records with action.type === 'ast10_annotation'. They are emitted by
// src/compliance/ast10-mapper.js via decision-logger.logDecision().
const {
  createAST10Mapper
} = require('../../compliance/ast10-mapper');

// ADR-047: MITRE ATLAS technique annotations ride on the decision chain as
// records with action.type === 'atlas_annotation'. They are emitted by
// src/compliance/atlas-mapper.js via decision-logger.logDecision().
const {
  createATLASMapper
} = require('../../compliance/atlas-mapper');

// ADR-051: OWASP MCP Top 10 (2025) protocol-layer annotations ride on
// the decision chain as records with action.type === 'mcp10_annotation'.
// They are emitted by src/compliance/mcp-top10-classifier.js via
// decision-logger.logDecision(). The classifier consumes `mcp_message`
// source events produced by src/coordinator/adapters/mcp.js (the MCP
// JSON-RPC adapter).
//
// 2026-11-10 (scribe): this require was unconditional, and the module
// does not exist in the repository — src/compliance/mcp-top10-classifier.js
// was never written (three other files reference it as pending work:
// mcp-top10-catalog.js:17, framework-mapper.js:646, mcp-governance-catalog.js:289).
// A top-level require of a missing module throws at load time, which took
// down the ENTIRE compliance router — and therefore the v1 APIGateway
// (src/api/index.js:257 mounts this router), which is why the v1
// aware-backend container could not start.
//
// The require is now tolerant: if the classifier is absent, the router
// still loads and every other route works. Only /mcp-top10 degrades, and
// it degrades to the same shape it already returns for a cold chain.
let createMCP10Classifier = null;
let mcp10ClassifierLoadError = null;
try {
  ({ createMCP10Classifier } = require('../../compliance/mcp-top10-classifier'));
} catch (err) {
  mcp10ClassifierLoadError = err.message;
  console.error(
    '[compliance] mcp-top10-classifier unavailable; /api/compliance/mcp-top10 ' +
    'will report an empty annotation set. Reason: ' + err.message
  );
}

const {
  getChainBetween
} = require('../../audit/decision-logger');

// ADR-050 §5 GAP-6: LLM09:2025 (Misinformation) review-loop event type.
// Reads `review_required` annotations from the decision-chain segment and
// joins each with its `review_required_resolved` child to derive
// `status=open|resolved`. The mapper that writes the annotations is
// src/compliance/llm09-mapper.js.
const {
  ACTION_TYPE_REVIEW_REQUIRED,
  ACTION_TYPE_REVIEW_RESOLVED
} = require('../../compliance/llm09-mapper');

/**
 * GET /api/compliance/frameworks
 * List all supported frameworks
 */
router.get('/frameworks', (req, res) => {
  try {
    const mapper = getFrameworkMapper();
    const frameworks = mapper.getFrameworks();

    res.json({
      frameworks: Object.values(frameworks).map(f => ({
        id: f.id,
        name: f.name,
        version: f.version
      }))
    });
  } catch (error) {
    console.error('Failed to list frameworks:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/frameworks/:frameworkId
 * Get framework details with controls
 */
router.get('/frameworks/:frameworkId', (req, res) => {
  try {
    const { frameworkId } = req.params;
    const mapper = getFrameworkMapper();
    const framework = mapper.getFramework(frameworkId);

    if (!framework) {
      return res.status(404).json({
        error: 'FRAMEWORK_NOT_FOUND',
        message: `Framework '${frameworkId}' not found`
      });
    }

    const controls = mapper.getFrameworkControls(frameworkId);
    const postureCalc = getPostureCalculator();

    // Get posture for each control
    const controlsWithPosture = controls.map(c => {
      const key = `${frameworkId}:${c.id}`;
      const assessment = postureCalc.assessments.get(key);
      return {
        ...c,
        status: assessment?.status || ComplianceStatus.NOT_ASSESSED,
        lastAssessed: assessment?.assessedAt || null
      };
    });

    const posture = postureCalc.calculateFrameworkPosture(frameworkId);

    res.json({
      framework,
      posture,
      controls: controlsWithPosture
    });
  } catch (error) {
    console.error('Failed to get framework:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/matrix
 * Get compliance matrix for all components
 */
router.get('/matrix', (req, res) => {
  try {
    const mapper = getFrameworkMapper();
    const matrix = mapper.generateComplianceMatrix();

    res.json({ matrix });
  } catch (error) {
    console.error('Failed to get matrix:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/posture
 * Get overall compliance posture
 */
router.get('/posture', (req, res) => {
  try {
    const postureCalc = getPostureCalculator();
    const posture = postureCalc.calculateOverallPosture();

    res.json(posture);
  } catch (error) {
    console.error('Failed to get posture:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/compliance/assessments
 * Record assessment for a control
 */
router.post('/assessments', (req, res) => {
  try {
    const { controlId, frameworkId, status, evidence, notes } = req.body;

    if (!controlId || !frameworkId) {
      return res.status(400).json({
        error: 'CONTROL_ID_AND_FRAMEWORK_ID_REQUIRED',
        message: 'controlId and frameworkId are required'
      });
    }

    const postureCalc = getPostureCalculator();
    postureCalc.recordAssessment(controlId, frameworkId, {
      status: status || ComplianceStatus.NOT_ASSESSED,
      evidence: evidence || [],
      notes: notes || '',
      assessedBy: req.user?.agentId || 'system'
    });

    res.json({ success: true, controlId, frameworkId });
  } catch (error) {
    console.error('Failed to record assessment:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/evidence
 * Get evidence summary
 */
router.get('/evidence', async (req, res) => {
  try {
    const collector = getEvidenceCollector();
    const summary = collector.getSummary();

    res.json(summary);
  } catch (error) {
    console.error('Failed to get evidence:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/compliance/evidence/collect
 * Trigger evidence collection
 */
router.post('/evidence/collect', async (req, res) => {
  try {
    const { controlId } = req.body;
    const collector = getEvidenceCollector();

    let results;
    if (controlId) {
      results = [await collector.collectEvidence(controlId)];
    } else {
      results = await collector.collectAll();
    }

    res.json({ results });
  } catch (error) {
    console.error('Failed to collect evidence:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/gaps
 * List all compliance gaps
 */
router.get('/gaps', (req, res) => {
  try {
    const { frameworkId, status, severity } = req.query;

    const tracker = getGapTracker();
    const gaps = tracker.getAllGaps({
      frameworkId,
      status,
      severity
    });

    res.json({
      gaps,
      total: gaps.length
    });
  } catch (error) {
    console.error('Failed to list gaps:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/compliance/gaps
 * Create a new gap
 */
router.post('/gaps', (req, res) => {
  try {
    const { controlId, frameworkId, severity, title, description, remediation } = req.body;

    if (!controlId || !frameworkId) {
      return res.status(400).json({
        error: 'CONTROL_ID_AND_FRAMEWORK_ID_REQUIRED',
        message: 'controlId and frameworkId are required'
      });
    }

    const tracker = getGapTracker();
    const gapId = tracker.createGap({
      controlId,
      frameworkId,
      severity: severity || GapSeverity.MEDIUM,
      title: title || `Gap in ${controlId}`,
      description,
      remediation
    });

    res.json({ success: true, gapId });
  } catch (error) {
    console.error('Failed to create gap:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * PATCH /api/compliance/gaps/:gapId
 * Update gap status
 */
router.patch('/gaps/:gapId', (req, res) => {
  try {
    const { gapId } = req.params;
    const { status, owner, notes } = req.body;

    const tracker = getGapTracker();
    const updated = tracker.updateStatus(gapId, {
      status,
      owner,
      notes,
      updatedBy: req.user?.agentId || 'system'
    });

    if (!updated) {
      return res.status(404).json({
        error: 'GAP_NOT_FOUND',
        message: `Gap '${gapId}' not found`
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update gap:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/gaps/stats
 * Get gap statistics
 */
router.get('/gaps/stats', (req, res) => {
  try {
    const tracker = getGapTracker();
    const stats = tracker.getStats();

    res.json(stats);
  } catch (error) {
    console.error('Failed to get gap stats:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/reports
 * List generated reports
 */
router.get('/reports', (req, res) => {
  try {
    const { type } = req.query;

    const generator = getReportGenerator();
    const reports = generator.listReports({ type });

    res.json({
      reports: reports.map(r => ({
        reportId: r.reportId,
        type: r.type,
        generatedAt: r.generatedAt,
        period: r.period
      })),
      total: reports.length
    });
  } catch (error) {
    console.error('Failed to list reports:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/compliance/reports
 * Generate a new report
 */
router.post('/reports', (req, res) => {
  try {
    const { type, frameworkId, period } = req.body;

    const generator = getReportGenerator();

    let report;
    switch (type) {
      case ReportType.EXECUTIVE_SUMMARY:
        report = generator.generateExecutiveSummary({ period });
        break;
      case ReportType.DETAILED_COMPLIANCE:
        report = generator.generateDetailedComplianceReport({ frameworkId, period });
        break;
      case ReportType.GAP_STATUS:
        report = generator.generateGapStatusReport({ frameworkId, status: 'OPEN' });
        break;
      default:
        return res.status(400).json({
          error: 'INVALID_REPORT_TYPE',
          message: `Type must be one of: ${Object.values(ReportType).join(', ')}`
        });
    }

    res.json({ report });
  } catch (error) {
    console.error('Failed to generate report:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/reports/:reportId
 * Get report details
 */
router.get('/reports/:reportId', (req, res) => {
  try {
    const { reportId } = req.params;

    const generator = getReportGenerator();
    const report = generator.getReport(reportId);

    if (!report) {
      return res.status(404).json({
        error: 'REPORT_NOT_FOUND',
        message: `Report '${reportId}' not found`
      });
    }

    res.json({ report });
  } catch (error) {
    console.error('Failed to get report:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/ast10
 *
 * Returns OWASP AST10 risk-class annotations in the decision-chain segment
 * between two decisionIds. Annotations are written by
 * src/policies/tool-observation-proxy.js (when enableAST10Annotation is true)
 * or by classifyChainSegment backfill jobs. Each annotation is a
 * decision-chain record with action.type === 'ast10_annotation' — we
 * filter the chain segment on that discriminator.
 *
 * Query params:
 *   fromDecisionId - required, the lower-bound decisionId (inclusive)
 *   toDecisionId   - required, the upper-bound decisionId (inclusive)
 *
 * Reuses the same read-side auth/middleware pattern as the surrounding
 * `/api/compliance/*` routes — the upstream middleware (mounted on the
 * v2 gateway) populates req.user; the route does not enforce auth here.
 *
 * Per ADR-043 §"Acceptance criteria".
 */
router.get('/ast10', async (req, res) => {
  try {
    const { fromDecisionId, toDecisionId } = req.query;

    if (!fromDecisionId || !toDecisionId) {
      return res.status(400).json({
        error: 'FROM_AND_TO_DECISION_ID_REQUIRED',
        message: 'fromDecisionId and toDecisionId are required'
      });
    }

    let segment;
    try {
      segment = await getChainBetween(fromDecisionId, toDecisionId);
    } catch (err) {
      // Common case: the chain hasn't been initialised (fresh deploy, or
      // the range is just outside the loaded index). Return an empty
      // annotations list rather than 500 — the route is read-only.
      return res.status(200).json({
        annotations: [],
        total: 0,
        fromDecisionId,
        toDecisionId,
        rangeStatus: 'CHAIN_UNAVAILABLE'
      });
    }

    if (!Array.isArray(segment)) {
      return res.json({ annotations: [], total: 0, fromDecisionId, toDecisionId });
    }

    // Filter to AST10 annotations only. Each annotation record was
    // emitted by ast10-mapper.classifyAndLog with action.type =
    // 'ast10_annotation' and a child `annotation` field carrying the
    // full AST10Annotation shape (matchedClasses, classification,
    // evidence, sourceDecisionId). Flatten for the API response.
    const annotations = [];
    for (const record of segment) {
      if (!record || !record.action || record.action.type !== 'ast10_annotation') continue;
      const inner = record.action.annotation || {};
      annotations.push({
        sourceDecisionId: inner.sourceDecisionId || null,
        decisionId: record.decisionId,
        timestamp: record.timestamp,
        eventType: inner.eventType || null,
        matchedClasses: Array.isArray(inner.matchedClasses) ? inner.matchedClasses : [],
        classification: inner.classification || null,
        evidence: inner.evidence || null,
        parentDecisionId: record.parentDecisionId,
        hash: record.hash || null
      });
    }

    return res.json({
      annotations,
      total: annotations.length,
      fromDecisionId,
      toDecisionId,
      rangeStatus: 'OK'
    });
  } catch (error) {
    console.error('Failed to list AST10 annotations:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/asi06', async (req, res) => {
  try {
    const { fromDecisionId, toDecisionId } = req.query;
    if (!fromDecisionId || !toDecisionId) {
      return res.status(400).json({
        error: 'FROM_AND_TO_DECISION_ID_REQUIRED',
        message: 'fromDecisionId and toDecisionId are required'
      });
    }

    let segment;
    try {
      segment = await getChainBetween(fromDecisionId, toDecisionId);
    } catch (_) {
      return res.status(200).json({ annotations: [], total: 0, fromDecisionId, toDecisionId, rangeStatus: 'CHAIN_UNAVAILABLE' });
    }

    const annotations = (segment || [])
      .filter((record) => record?.action?.type === 'asi06_annotation')
      .map((record) => ({
        ...(record.action.annotation || {}),
        decisionId: record.decisionId,
        parentDecisionId: record.parentDecisionId,
        hash: record.hash || null
      }));
    return res.json({ annotations, total: annotations.length, fromDecisionId, toDecisionId, rangeStatus: 'OK' });
  } catch (error) {
    console.error('Failed to list ASI06 annotations:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/atlas
 *
 * Returns MITRE ATLAS technique annotations in the decision-chain segment
 * between two decisionIds. Annotations are written by
 * src/policies/tool-observation-proxy.js (when enableATLASAnnotation is true)
 * or by classifyChainSegment backfill jobs. Each annotation is a
 * decision-chain record with action.type === 'atlas_annotation' — we filter
 * the chain segment on that discriminator.
 *
 * Query params:
 *   fromDecisionId - required, the lower-bound decisionId (inclusive)
 *   toDecisionId   - required, the upper-bound decisionId (inclusive)
 *
 * Reuses the same read-side auth/middleware pattern as the surrounding
 * `/api/compliance/*` routes. The catalogue reference (./atlas-catalog)
 * is the same source-of-truth as the framework-mapper's MITRE_ATLAS
 * block, so the technique IDs surfaced here match the IDs in
 * /api/compliance/frameworks/MITRE_ATLAS.
 *
 * Per ADR-047 §"Acceptance criteria".
 */
router.get('/atlas', async (req, res) => {
  try {
    const { fromDecisionId, toDecisionId } = req.query;

    if (!fromDecisionId || !toDecisionId) {
      return res.status(400).json({
        error: 'FROM_AND_TO_DECISION_ID_REQUIRED',
        message: 'fromDecisionId and toDecisionId are required'
      });
    }

    let segment;
    try {
      segment = await getChainBetween(fromDecisionId, toDecisionId);
    } catch (err) {
      // Common case: the chain hasn't been initialised (fresh deploy, or
      // the range is just outside the loaded index). Return an empty
      // annotations list rather than 500 — the route is read-only.
      return res.status(200).json({
        annotations: [],
        total: 0,
        fromDecisionId,
        toDecisionId,
        rangeStatus: 'CHAIN_UNAVAILABLE'
      });
    }

    if (!Array.isArray(segment)) {
      return res.json({ annotations: [], total: 0, fromDecisionId, toDecisionId });
    }

    // Filter to ATLAS annotations only. Each annotation record was
    // emitted by atlas-mapper.classifyAndLog with action.type =
    // 'atlas_annotation' and a child `annotation` field carrying the
    // full ATLASAnnotation shape (matchedTechniques, classification,
    // evidence, c2RelayIndicators, sourceDecisionId). Flatten for the
    // API response.
    const annotations = [];
    for (const record of segment) {
      if (!record || !record.action || record.action.type !== 'atlas_annotation') continue;
      const inner = record.action.annotation || {};
      annotations.push({
        sourceDecisionId: inner.sourceDecisionId || null,
        decisionId: record.decisionId,
        timestamp: record.timestamp,
        eventType: inner.eventType || null,
        matchedTechniques: Array.isArray(inner.matchedTechniques) ? inner.matchedTechniques : [],
        classification: inner.classification || null,
        evidence: inner.evidence || null,
        c2RelayIndicators: Array.isArray(inner.c2RelayIndicators) ? inner.c2RelayIndicators : null,
        parentDecisionId: record.parentDecisionId,
        hash: record.hash || null
      });
    }

    return res.json({
      annotations,
      total: annotations.length,
      fromDecisionId,
      toDecisionId,
      rangeStatus: 'OK'
    });
  } catch (error) {
    console.error('Failed to list ATLAS annotations:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/compliance/llm-top-10/misinformation-review
 *
 * Returns LLM09:2025 (Misinformation) review-loop annotations in the
 * decision-chain segment between two decisionIds. Per ADR-050 §5 GAP-6.
 *
 * Annotations are written by src/compliance/llm09-mapper.js via
 * decision-logger.logDecision(). Each annotation is a decision-chain record
 * with action.type === 'review_required'. A resolved review is a follow-up
 * child record with action.type === 'review_required_resolved' and
 * parentDecisionId === review_required.decisionId.
 *
 * Query params:
 *   fromDecisionId - required, lower-bound decisionId (inclusive)
 *   toDecisionId   - required, upper-bound decisionId (inclusive)
 *   status         - optional filter: 'open' | 'resolved'. Default: both.
 *
 * Pagination: the [fromDecisionId, toDecisionId] window IS the pagination
 * primitive. Callers page forward by setting fromDecisionId to the last
 * record's decisionId from the previous response.
 *
 * Reuses the same read-side pattern as /ast10 and /asi06: getChainBetween
 * is wrapped in try/catch so a cold chain returns 200 with empty results
 * rather than 500 — the route is read-only and must degrade gracefully.
 *
 * Per ADR-050 §6 LLM09:2025 — the reviewer is the operator, not the model.
 */
router.get('/llm-top-10/misinformation-review', async (req, res) => {
  try {
    const { fromDecisionId, toDecisionId, status } = req.query;

    if (!fromDecisionId || !toDecisionId) {
      return res.status(400).json({
        error: 'FROM_AND_TO_DECISION_ID_REQUIRED',
        message: 'fromDecisionId and toDecisionId are required'
      });
    }

    // Validate status filter (default = both, so absence is allowed).
    let statusFilter = null;
    if (status !== undefined && status !== null && status !== '') {
      if (status !== 'open' && status !== 'resolved') {
        return res.status(400).json({
          error: 'INVALID_STATUS_FILTER',
          message: "status must be 'open' or 'resolved' (or omitted)"
        });
      }
      statusFilter = status;
    }

    let segment;
    try {
      segment = await getChainBetween(fromDecisionId, toDecisionId);
    } catch (err) {
      // Chain unavailable (cold start, out-of-range): return empty list.
      return res.status(200).json({
        annotations: [],
        total: 0,
        fromDecisionId,
        toDecisionId,
        status: statusFilter || 'all',
        rangeStatus: 'CHAIN_UNAVAILABLE'
      });
    }

    if (!Array.isArray(segment)) {
      return res.status(200).json({
        annotations: [],
        total: 0,
        fromDecisionId,
        toDecisionId,
        status: statusFilter || 'all',
        rangeStatus: 'OK'
      });
    }

    // Build a set of resolved review ids from this segment. A resolved
    // record's parentDecisionId points at the review_required it resolves.
    const resolvedReviewIds = new Set();
    for (const record of segment) {
      if (record && record.action && record.action.type === ACTION_TYPE_REVIEW_RESOLVED) {
        // The review_required's decisionId is the parent of this resolved
        // record. Capture both: the explicit parentDecisionId on the
        // resolved record, and the sourceDecisionId field carried inside
        // the annotation payload (defence-in-depth — the mapper writes
        // both, but the chain-of-parent linkage is the contract).
        if (record.parentDecisionId) resolvedReviewIds.add(record.parentDecisionId);
        const inner = record.action.annotation || {};
        if (inner.sourceDecisionId) resolvedReviewIds.add(inner.sourceDecisionId);
      }
    }

    // Filter to review_required records and join with resolution state.
    const annotations = [];
    for (const record of segment) {
      if (!record || !record.action || record.action.type !== ACTION_TYPE_REVIEW_REQUIRED) continue;
      const inner = record.action.annotation || {};
      const reviewId = record.decisionId;
      const isResolved = resolvedReviewIds.has(reviewId);
      const derivedStatus = isResolved ? 'resolved' : 'open';
      if (statusFilter && derivedStatus !== statusFilter) continue;
      annotations.push({
        decisionId: reviewId,
        parentDecisionId: record.parentDecisionId,
        timestamp: record.timestamp,
        sourceDecisionId: inner.sourceDecisionId || record.parentDecisionId || null,
        triggerSource: inner.triggerSource || null,
        confidenceScore: typeof inner.confidenceScore === 'number' ? inner.confidenceScore : null,
        outputHash: inner.outputHash || null,
        agentId: inner.agentId || null,
        eventType: inner.eventType || ACTION_TYPE_REVIEW_REQUIRED,
        status: derivedStatus,
        concerns: Array.isArray(inner.concerns) ? inner.concerns : [],
        heuristicVersion: inner.heuristicVersion || null,
        hash: record.hash || null
      });
    }

    return res.json({
      annotations,
      total: annotations.length,
      fromDecisionId,
      toDecisionId,
      status: statusFilter || 'all',
      rangeStatus: 'OK'
    });
  } catch (error) {
    console.error('Failed to list LLM09 misinformation review annotations:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});


// ----------------------------------------------------------------------------
// ADR-051: GET /api/compliance/mcp-top10
//
// Returns OWASP MCP Top 10 (2025) protocol-layer annotations in the
// decision-chain segment between two decisionIds. Per ADR-051 §2 + §3
// (the catalog card's lane is separate).
//
// Annotations are written by src/compliance/mcp-top10-classifier.js via
// decision-logger.logDecision(). Each annotation is a decision-chain
// record with action.type === 'mcp10_annotation' and a child
// `annotation` field carrying the full MCP10Annotation shape
// (matchedClasses, classification, evidence, sourceDecisionId).
//
// Query params:
//   fromDecisionId - required, lower-bound decisionId (inclusive)
//   toDecisionId   - required, upper-bound decisionId (inclusive)
//   rule           - optional filter, exact match against
//                    classification.rule (e.g. 'mcp_tool_poisoning')
//   confidence     - optional filter, exact match ('H' | 'M' | 'L')
//
// Returns {annotations, total, fromDecisionId, toDecisionId,
// rangeStatus: 'OK' | 'CHAIN_UNAVAILABLE'}. Same shape as the
// surrounding /ast10 /atlas /asi06 routes — the read-side auth
// middleware is upstream (mounted on the v2 gateway).
// ----------------------------------------------------------------------------
router.get('/mcp-top10', async (req, res) => {
  try {
    const { fromDecisionId, toDecisionId, rule, confidence } = req.query;

    if (!fromDecisionId || !toDecisionId) {
      return res.status(400).json({
        error: 'FROM_AND_TO_DECISION_ID_REQUIRED',
        message: 'fromDecisionId and toDecisionId are required'
      });
    }

    // Pre-build the classifier once per request — its constructor binds
    // module-level state, so a single instance is enough. We don't run a
    // classifier-internal allowlist on the read side; per ADR-051 §2.1
    // MCP09 the allowlist is operator-managed and lives at a separate
    // config surface. Future: wire `req.query.allowlist` through here
    // when the operator-facing config route lands.
    //
    // 2026-11-10 (scribe): the classifier module does not exist in the
    // repo (see the tolerant require above). When it is absent, the read
    // path is unaffected — it reads annotations straight from the chain —
    // so report the empty set rather than a 500. The classifier was only
    // ever a structural no-op here (`void classifier`).
    let classifier = null;
    if (createMCP10Classifier) {
      try {
        classifier = createMCP10Classifier({ enableWrites: false });
      } catch (err) {
        console.error('Failed to construct MCP10Classifier:', err);
        return res.status(500).json({ error: 'INTERNAL_ERROR' });
      }
    }
    void classifier; // structure-only; we read annotations from the chain directly.

    let segment;
    try {
      segment = await getChainBetween(fromDecisionId, toDecisionId);
    } catch (err) {
      // Cold chain → empty annotations rather than 500 (mirror /ast10).
      return res.status(200).json({
        annotations: [],
        total: 0,
        fromDecisionId,
        toDecisionId,
        rangeStatus: 'CHAIN_UNAVAILABLE'
      });
    }

    if (!Array.isArray(segment)) {
      return res.json({ annotations: [], total: 0, fromDecisionId, toDecisionId });
    }

    // Filter to MCP10 annotations only. Each annotation record was
    // emitted by mcp-top10-classifier.classifyAndLog with action.type
    // === 'mcp10_annotation' and a child `annotation` field carrying
    // the full MCP10Annotation shape (matchedClasses, classification,
    // evidence, sourceDecisionId). Flatten for the API response.
    const annotations = [];
    for (const record of segment) {
      if (!record || !record.action || record.action.type !== 'mcp10_annotation') continue;
      const inner = record.action.annotation || {};
      if (rule && inner.classification && inner.classification.rule !== rule) continue;
      if (confidence && inner.classification && inner.classification.confidence !== confidence) continue;
      annotations.push({
        sourceDecisionId: inner.sourceDecisionId || null,
        decisionId: record.decisionId,
        timestamp: record.timestamp,
        eventType: inner.eventType || null,
        matchedClasses: Array.isArray(inner.matchedClasses) ? inner.matchedClasses : [],
        classification: inner.classification || null,
        evidence: inner.evidence || null,
        parentDecisionId: record.parentDecisionId,
        hash: record.hash || null
      });
    }

    return res.json({
      annotations,
      total: annotations.length,
      fromDecisionId,
      toDecisionId,
      rangeStatus: 'OK'
    });
  } catch (error) {
    console.error('Failed to list MCP10 annotations:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
