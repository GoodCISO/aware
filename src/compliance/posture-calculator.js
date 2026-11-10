// src/compliance/posture-calculator.js
// Posture Calculator — Computes compliance scores
// ADR (internal): Compliance Mapping & Reporting

const { getFrameworkMapper } = require('./framework-mapper');

/**
 * Compliance Status
 */
const ComplianceStatus = {
  COMPLIANT: 'COMPLIANT',
  PARTIAL: 'PARTIAL',
  NON_COMPLIANT: 'NON_COMPLIANT',
  NOT_ASSESSED: 'NOT_ASSESSED'
};

/**
 * Gap Severity
 */
const GapSeverity = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
};

/**
 * Posture Calculator — Computes compliance posture scores
 */
class PostureCalculator {
  constructor(config = {}) {
    this.frameworkMapper = getFrameworkMapper();
    this.gaps = new Map(); // gapId -> gap
    this.assessments = new Map(); // controlId -> assessment
    this.weights = config.weights || this.getDefaultWeights();

    // 2026-11-10 (scribe): hydrate from the durable store so a restart
    // does not reset the measured posture to zero. Assessments were
    // in-memory only (this.assessments), so every restart lost them and
    // every framework read 0 / CRITICAL regardless of what had actually
    // been assessed.
    try {
      const persistence = require('./persistence');
      const restored = persistence.applyAssessmentsTo(this);
      if (restored > 0) {
        console.log(`[posture-calculator] restored ${restored} assessment(s) from ${persistence.STATE_FILE}`);
      }
    } catch (err) {
      console.error('[posture-calculator] failed to restore assessments:', err.message);
    }
  }

  /**
   * Get default control weights based on framework
   * @returns {Object}
   */
  getDefaultWeights() {
    return {
      CRITICAL: 1.0,
      HIGH: 0.75,
      MEDIUM: 0.5,
      LOW: 0.25
    };
  }

  /**
   * Record an assessment result for a control
   * @param {string} controlId - Control ID
   * @param {string} frameworkId - Framework ID
   * @param {Object} assessment - Assessment data { status, evidence, notes }
   */
  recordAssessment(controlId, frameworkId, assessment) {
    const key = `${frameworkId}:${controlId}`;

    // 2026-11-10 (scribe): write through to the durable store. The
    // in-memory Map is the cache; the file is the record.
    try {
      require('./persistence').recordAssessment({
        frameworkId,
        controlId,
        status: assessment.status,
        evidence: assessment.evidence,
        notes: assessment.notes,
        assessedBy: assessment.assessedBy,
      });
    } catch (err) {
      console.error('[posture-calculator] failed to persist assessment:', err.message);
    }

    this.assessments.set(key, {
      controlId,
      frameworkId,
      status: assessment.status || ComplianceStatus.NOT_ASSESSED,
      evidence: assessment.evidence || [],
      notes: assessment.notes || '',
      assessedAt: Date.now(),
      assessedBy: assessment.assessedBy || 'system'
    });
  }

  /**
   * Record a compliance gap
   * @param {Object} gap - Gap data
   */
  recordGap(gap) {
    const id = gap.id || `gap-${gap.controlId}-${Date.now()}`;

    // Convert severity to priority number
    const severityToPriority = (severity) => {
      const priorities = { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4 };
      return priorities[severity] ?? 5;
    };

    this.gaps.set(id, {
      id,
      controlId: gap.controlId,
      frameworkId: gap.frameworkId,
      severity: gap.severity || GapSeverity.MEDIUM,
      priority: severityToPriority(gap.severity || GapSeverity.MEDIUM),
      description: gap.description,
      remediation: gap.remediation || '',
      status: gap.status || 'OPEN',
      identifiedAt: gap.identifiedAt || Date.now(),
      remediatedAt: null,
      notes: gap.notes || []
    });

    return id;
  }

  /**
   * Update gap status
   * @param {string} gapId
   * @param {Object} update
   */
  updateGapStatus(gapId, update) {
    const gap = this.gaps.get(gapId);
    if (!gap) return false;

    gap.status = update.status || gap.status;
    gap.notes = update.notes ? [...(gap.notes || []), update] : gap.notes;

    if (update.status === 'REMEDIATED') {
      gap.remediatedAt = Date.now();
    }

    return true;
  }

  /**
   * Calculate posture score for a framework
   * @param {string} frameworkId
   * @returns {Object}
   */
  calculateFrameworkPosture(frameworkId) {
    const framework = this.frameworkMapper.getFramework(frameworkId);
    if (!framework) {
      return { error: 'FRAMEWORK_NOT_FOUND' };
    }

    const controls = this.frameworkMapper.getFrameworkControls(frameworkId);
    let totalWeight = 0;
    let achievedWeight = 0;

    for (const control of controls) {
      const key = `${frameworkId}:${control.id}`;
      const assessment = this.assessments.get(key);

      if (!assessment || assessment.status === ComplianceStatus.NOT_ASSESSED) {
        // Not assessed - contribute nothing
        continue;
      }

      // Determine severity based on control
      const severity = this.determineSeverity(control.id);
      const weight = this.weights[severity] || 0.5;

      totalWeight += weight;

      if (assessment.status === ComplianceStatus.COMPLIANT) {
        achievedWeight += weight;
      } else if (assessment.status === ComplianceStatus.PARTIAL) {
        achievedWeight += weight * 0.5;
      }
      // NON_COMPLIANT contributes 0
    }

    const score = totalWeight > 0 ? achievedWeight / totalWeight : 0;

    return {
      frameworkId,
      frameworkName: framework.name,
      score,
      percentage: Math.round(score * 100),
      status: this.getPostureStatus(score),
      controlsAssessed: this.getAssessedCount(frameworkId),
      controlsTotal: controls.length,
      compliantControls: this.getCompliantCount(frameworkId),
      nonCompliantControls: this.getNonCompliantCount(frameworkId),
      openGaps: this.getOpenGapCount(frameworkId)
    };
  }

  /**
   * Determine severity of a control
   * @param {string} controlId
   * @returns {string}
   */
  determineSeverity(controlId) {
    // Identity controls are typically higher severity
    if (controlId.includes('ID')) return GapSeverity.HIGH;
    if (controlId.includes('OPS')) return GapSeverity.HIGH;
    if (controlId.includes('MT')) return GapSeverity.MEDIUM;
    return GapSeverity.MEDIUM;
  }

  /**
   * Get posture status from score
   * @param {number} score
   * @returns {string}
   */
  getPostureStatus(score) {
    if (score >= 0.9) return 'EXCELLENT';
    if (score >= 0.7) return 'GOOD';
    if (score >= 0.5) return 'FAIR';
    if (score >= 0.3) return 'POOR';
    return 'CRITICAL';
  }

  /**
   * Get assessed count for framework
   * @param {string} frameworkId
   * @returns {number}
   */
  getAssessedCount(frameworkId) {
    let count = 0;
    for (const [key] of this.assessments) {
      if (key.startsWith(`${frameworkId}:`)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get compliant count for framework
   * @param {string} frameworkId
   * @returns {number}
   */
  getCompliantCount(frameworkId) {
    let count = 0;
    for (const [key, assessment] of this.assessments) {
      if (key.startsWith(`${frameworkId}:`) && assessment.status === ComplianceStatus.COMPLIANT) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get non-compliant count for framework
   * @param {string} frameworkId
   * @returns {number}
   */
  getNonCompliantCount(frameworkId) {
    let count = 0;
    for (const [key, assessment] of this.assessments) {
      if (key.startsWith(`${frameworkId}:`) && assessment.status === ComplianceStatus.NON_COMPLIANT) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get open gap count for framework
   * @param {string} frameworkId
   * @returns {number}
   */
  getOpenGapCount(frameworkId) {
    let count = 0;
    for (const gap of this.gaps.values()) {
      if (gap.frameworkId === frameworkId && gap.status === 'OPEN') {
        count++;
      }
    }
    return count;
  }

  /**
   * Calculate overall posture across all frameworks
   * @returns {Object}
   */
  calculateOverallPosture() {
    const frameworks = Object.keys(this.frameworkMapper.getFrameworks());
    const postures = [];

    let totalScore = 0;
    let totalWeight = 0;

    for (const frameworkId of frameworks) {
      const posture = this.calculateFrameworkPosture(frameworkId);
      if (posture.error) continue;

      postures.push(posture);

      // Weight frameworks equally for now
      totalScore += posture.score;
      totalWeight += 1;
    }

    const overallScore = totalWeight > 0 ? totalScore / totalWeight : 0;

    return {
      overallScore,
      overallPercentage: Math.round(overallScore * 100),
      overallStatus: this.getPostureStatus(overallScore),
      frameworks: postures,
      totalGaps: this.gaps.size,
      openGaps: Array.from(this.gaps.values()).filter(g => g.status === 'OPEN').length,
      criticalGaps: Array.from(this.gaps.values()).filter(g => g.severity === GapSeverity.CRITICAL && g.status === 'OPEN').length
    };
  }

  /**
   * Get gap report
   * @param {string} frameworkId - Optional filter
   * @returns {Array}
   */
  getGapReport(frameworkId = null) {
    const gaps = [];

    for (const gap of this.gaps.values()) {
      if (frameworkId && gap.frameworkId !== frameworkId) continue;
      gaps.push(gap);
    }

    return gaps.sort((a, b) => {
      // Sort by severity (CRITICAL first), then by date
      const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) return severityDiff;
      return b.identifiedAt - a.identifiedAt;
    });
  }

  /**
   * Get trend analysis
   * @param {string} frameworkId
   * @param {number} periods - Number of periods to analyze
   * @returns {Object}
   */
  getTrendAnalysis(frameworkId, periods = 6) {
    // This would normally query historical data
    // For now, return placeholder structure
    return {
      frameworkId,
      periods,
      trend: 'STABLE', // UP, DOWN, STABLE
      change: 0,
      historicalScores: []
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create PostureCalculator singleton
 * @returns {PostureCalculator}
 */
function getPostureCalculator() {
  if (!instance) {
    instance = new PostureCalculator();
  }
  return instance;
}

module.exports = {
  PostureCalculator,
  getPostureCalculator,
  ComplianceStatus,
  GapSeverity
};
