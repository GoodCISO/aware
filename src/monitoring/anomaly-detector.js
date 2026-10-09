// src/monitoring/anomaly-detector.js
// Z-score based anomaly detection
// Phase 1.3: Behavioural Baseline & Anomaly Detection

const store = require('./store');
const baselineService = require('./baseline-service');

/**
 * Anomaly severity thresholds based on z-score
 */
const Z_SCORE_THRESHOLDS = {
  CRITICAL: 4.0,  // >4 stddev
  HIGH: 3.0,      // >3 stddev
  MEDIUM: 2.5,    // >2.5 stddev
  LOW: 2.0        // >2 stddev (flagged but not alarming)
};

/**
 * Severity levels.
 *
 * RE-EXPORTED from src/monitoring/severity-contract.js rather than declared
 * here: this is the ladder the whole product is supposed to agree on (the
 * detector is the real producer -- the server.js seed array is stand-in
 * data), so it is the one place the levels are DEFINED. See card t_517be819
 * for the four-vocabulary collision this replaced, re-landed on main by
 * t_775073b4.
 */
const { SEVERITY_LEVELS } = require('./severity-contract');
const Severity = SEVERITY_LEVELS.reduce((acc, level) => {
  acc[level] = level;
  return acc;
}, Object.create(null));

/**
 * AnomalyDetector - detects anomalies using z-score methodology
 */
class AnomalyDetector {
  constructor(config = {}) {
    this.thresholds = config.thresholds || Z_SCORE_THRESHOLDS;
    this.baselineService = baselineService.getBaselineService();
  }

  /**
   * Detect anomaly for a single metric value
   * @param {string} agentId
   * @param {string} metricType
   * @param {number} value
   * @param {Object} metadata
   * @returns {Object|null} anomaly if detected, null otherwise
   */
  detect(agentId, metricType, value, metadata = {}) {
    const comparison = this.baselineService.compareToBaseline(agentId, metricType, value);
    
    if (!comparison.hasBaseline) {
      return null; // Can't detect without baseline
    }
    
    const { zScore, isAnomalous, baseline } = comparison;
    
    if (!isAnomalous) {
      return null; // Within normal range
    }
    
    // Determine severity
    const absZScore = Math.abs(zScore);
    let severity;
    
    if (absZScore > this.thresholds.CRITICAL) {
      severity = Severity.CRITICAL;
    } else if (absZScore > this.thresholds.HIGH) {
      severity = Severity.HIGH;
    } else if (absZScore > this.thresholds.MEDIUM) {
      severity = Severity.MEDIUM;
    } else {
      severity = Severity.LOW;
    }
    
    const anomaly = {
      agentId,
      metricType,
      detectedAt: new Date().toISOString(),
      severity,
      zScore,
      value,
      baselineMean: baseline.mean,
      baselineStddev: baseline.stddev,
      direction: comparison.direction,
      percentile: comparison.percentile,
      metadata,
      status: 'detected'
    };
    
    // Store the anomaly
    store.storeAnomaly(anomaly);
    
    return anomaly;
  }

  /**
   * Batch detect anomalies from multiple metrics
   * @param {Array} metrics - [{agentId, type, value, metadata}]
   * @returns {Array} detected anomalies
   */
  detectBatch(metrics) {
    const anomalies = [];
    
    for (const m of metrics) {
      const anomaly = this.detect(m.agentId, m.type, m.value, m.metadata || {});
      if (anomaly) {
        anomalies.push(anomaly);
      }
    }
    
    return anomalies;
  }

  /**
   * Get anomalies for an agent
   * @param {string} agentId
   * @param {Object} options - { limit, startDate, endDate, severity }
   * @returns {Array}
   */
  getAnomalies(agentId, options = {}) {
    return store.getAnomalies(agentId, options);
  }

  /**
   * Get recent anomalies across all agents
   * @param {number} limit
   * @returns {Array}
   */
  getRecentAnomalies(limit = 50) {
    return store.getRecentAnomalies(limit);
  }

  /**
   * Get anomaly statistics for an agent
   * @param {string} agentId
   * @param {number} days - number of days to look back
   * @returns {Object}
   */
  getAnomalyStats(agentId, days = 7) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const anomalies = store.getAnomalies(agentId, { startDate });
    
    const bySeverity = {
      [Severity.LOW]: 0,
      [Severity.MEDIUM]: 0,
      [Severity.HIGH]: 0,
      [Severity.CRITICAL]: 0
    };
    
    const byType = {};
    
    for (const a of anomalies) {
      bySeverity[a.severity]++;
      
      if (!byType[a.metricType]) {
        byType[a.metricType] = 0;
      }
      byType[a.metricType]++;
    }
    
    return {
      agentId,
      periodDays: days,
      totalAnomalies: anomalies.length,
      bySeverity,
      byMetricType: byType,
      mostCommonType: Object.entries(byType).sort((a, b) => b[1] - a[1])[0]?.[0] || null
    };
  }

  /**
   * Get current threshold settings
   * @returns {Object}
   */
  getThresholds() {
    return { ...this.thresholds };
  }

  /**
   * Update threshold settings
   * @param {Object} thresholds
   */
  setThresholds(thresholds) {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }
}

// Singleton
let detectorInstance = null;

function getDetector() {
  if (!detectorInstance) {
    detectorInstance = new AnomalyDetector();
  }
  return detectorInstance;
}

module.exports = {
  AnomalyDetector,
  getDetector,
  Severity,
  Z_SCORE_THRESHOLDS
};
