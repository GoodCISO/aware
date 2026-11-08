// src/monitoring/metrics-collector.js
// Collects per-agent behavioural metrics
// Phase 1.3: Behavioural Baseline & Anomaly Detection

const crypto = require('crypto');
const store = require('./store');

/**
 * Metric types collected
 */
const MetricType = {
  RESPONSE_LATENCY: 'responseLatency',
  TOOL_CALL_FREQUENCY: 'toolCallFrequency',
  OUTPUT_TOKEN_COUNT: 'outputTokenCount',
  ERROR_RATE: 'errorRate',
  DECISION_FINGERPRINT: 'decisionFingerprint'
};

/**
 * Severity levels for anomalies.
 *
 * RE-EXPORTED from src/monitoring/severity-contract.js rather than declared
 * here: this was one of two independent copies of the same enum (the other
 * in anomaly-detector.js), which is precisely how the product ended up with
 * four incompatible severity vocabularies -- card t_517be819. Both call sites
 * now read one definition, so they cannot drift apart.
 */
const { SEVERITY_LEVELS } = require('./severity-contract');
const Severity = SEVERITY_LEVELS.reduce((acc, level) => {
  acc[level] = level;
  return acc;
}, Object.create(null));

/**
 * MetricsCollector - collects and stores agent behavioural metrics
 */
class MetricsCollector {
  constructor() {
    this.pendingMetrics = [];
    this.flushInterval = null;
    this.flushIntervalMs = 5000; // Flush every 5 seconds
  }

  /**
   * Start the periodic flush timer
   */
  start() {
    if (!this.flushInterval) {
      this.flushInterval = setInterval(() => this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * Stop the periodic flush timer
   */
  stop() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    // Final flush
    this.flush();
  }

  /**
   * Flush pending metrics to store
   */
  flush() {
    if (this.pendingMetrics.length === 0) return;
    
    const toFlush = [...this.pendingMetrics];
    this.pendingMetrics = [];
    
    store.storeMetrics(toFlush);
  }

  /**
   * Record a metric for an agent
   * @param {Object} metric
   * @param {string} metric.agentId - Agent identifier
   * @param {string} metric.type - Metric type
   * @param {number} metric.value - Metric value
   * @param {Object} metric.metadata - Additional context
   */
  record(metric) {
    const entry = {
      agentId: metric.agentId,
      type: metric.type,
      value: metric.value,
      timestamp: new Date().toISOString(),
      metadata: metric.metadata || {}
    };
    
    this.pendingMetrics.push(entry);
  }

  /**
   * Record response latency
   * @param {string} agentId
   * @param {number} latencyMs - Response time in milliseconds
   * @param {Object} metadata
   */
  recordLatency(agentId, latencyMs, metadata = {}) {
    this.record({
      agentId,
      type: MetricType.RESPONSE_LATENCY,
      value: latencyMs,
      metadata: { unit: 'ms', ...metadata }
    });
  }

  /**
   * Record tool call frequency
   * @param {string} agentId
   * @param {string} toolName - Tool that was called
   * @param {number} count - Number of calls
   * @param {Object} metadata
   */
  recordToolCall(agentId, toolName, count = 1, metadata = {}) {
    this.record({
      agentId,
      type: MetricType.TOOL_CALL_FREQUENCY,
      value: count,
      metadata: { tool: toolName, ...metadata }
    });
  }

  /**
   * Record output token count
   * @param {string} agentId
   * @param {number} tokenCount - Number of output tokens
   * @param {Object} metadata
   */
  recordTokenCount(agentId, tokenCount, metadata = {}) {
    this.record({
      agentId,
      type: MetricType.OUTPUT_TOKEN_COUNT,
      value: tokenCount,
      metadata: { unit: 'tokens', ...metadata }
    });
  }

  /**
   * Record an error
   * @param {string} agentId
   * @param {string} errorType - Type of error
   * @param {Object} metadata
   */
  recordError(agentId, errorType, metadata = {}) {
    this.record({
      agentId,
      type: MetricType.ERROR_RATE,
      value: 1,
      metadata: { errorType, ...metadata }
    });
  }

  /**
   * Get current metrics for an agent (from pending + recent store)
   * @param {string} agentId
   * @returns {Object}
   */
  getCurrentMetrics(agentId) {
    const recentMetrics = store.getMetrics(agentId);
    const pending = this.pendingMetrics.filter(m => m.agentId === agentId);
    
    const all = [...recentMetrics, ...pending];
    
    // Aggregate by type
    const byType = {};
    for (const m of all) {
      if (!byType[m.type]) {
        byType[m.type] = [];
      }
      byType[m.type].push(m.value);
    }
    
    // Calculate aggregates
    const result = {
      agentId,
      timestamp: new Date().toISOString(),
      metrics: {}
    };
    
    for (const [type, values] of Object.entries(byType)) {
      if (values.length === 0) continue;
      
      const sum = values.reduce((a, b) => a + b, 0);
      const avg = sum / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);
      
      // Calculate standard deviation
      const variance = values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / values.length;
      const stddev = Math.sqrt(variance);
      
      // Sort for percentiles
      const sorted = [...values].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
      const p99 = sorted[Math.floor(sorted.length * 0.99)] || sorted[sorted.length - 1];
      
      result.metrics[type] = {
        count: values.length,
        avg: Math.round(avg * 100) / 100,
        min: Math.round(min * 100) / 100,
        max: Math.round(max * 100) / 100,
        stddev: Math.round(stddev * 100) / 100,
        p50: Math.round(p50 * 100) / 100,
        p95: Math.round(p95 * 100) / 100,
        p99: Math.round(p99 * 100) / 100
      };
    }
    
    return result;
  }

  /**
   * Emit a batch of metrics (typically called by API route)
   * @param {Array} metrics
   * @returns {Object} result with accepted count
   */
  emitBatch(metrics) {
    const accepted = metrics.filter(m => {
      return m.agentId && m.type && typeof m.value === 'number';
    });
    
    for (const m of accepted) {
      this.record(m);
    }
    
    return {
      accepted: accepted.length,
      rejected: metrics.length - accepted.length,
      timestamp: new Date().toISOString()
    };
  }
}

// Singleton instance
let collectorInstance = null;

function getCollector() {
  if (!collectorInstance) {
    collectorInstance = new MetricsCollector();
  }
  return collectorInstance;
}

module.exports = {
  MetricsCollector,
  getCollector,
  MetricType,
  Severity
};
