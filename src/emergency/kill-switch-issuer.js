// src/emergency/kill-switch-issuer.js
// Phase 3.2: Kill Switch Propagation — Create and issue kill signals

const EventEmitter = require('events');
const crypto = require('crypto');
const {
  KillSeverity,
  ShutdownProcedure,
  KillSignalEntry,
  KillSignalState,
  KILL_SWITCH_TRIGGERS,
} = require('./kill-signal-entry');

/**
 * KillSwitchIssuer — creates and issues kill signals
 * Main interface for the kill switch API
 */
class KillSwitchIssuer extends EventEmitter {
  /**
   * @param {Object} deps
   * @param {Object} deps.propagator - KillSwitchPropagator
   * @param {Object} deps.acknowledgmentTracker - AcknowledgmentTracker
   * @param {Object} deps.blastRadiusEstimator - BlastRadiusEstimator
   * @param {Object} deps.agentRegistry - Agent registry
   * @param {Object} deps.config
   */
  constructor(deps) {
    super();
    this.propagator = deps.propagator;
    this.acknowledgmentTracker = deps.acknowledgmentTracker;
    this.blastRadiusEstimator = deps.blastRadiusEstimator;
    this.agentRegistry = deps.agentRegistry;
    this.config = deps.config || {};

    // Track issued kill signals
    this.issuedKillSignals = new Map(); // killSignalId -> entry
  }

  /**
   * Issue a kill signal
   * @param {Object} options - Kill signal options
   * @param {string} options.severity - LOCAL | DOMAIN | GLOBAL
   * @param {Object} options.target - Target scope
   * @param {Object} options.reason - Reason for kill
   * @param {string} options.issuedBy - Admin identity
   * @param {string} [options.shutdownProcedure] - GRACEFUL | FORCED
   * @param {boolean} [options.requiresAcknowledgment] - Whether agents must ack
   * @param {number} [options.acknowledgmentDeadlineMinutes] - Deadline in minutes
   * @returns {Promise<{success: boolean, killSignalId: string, entry: KillSignalEntry}>}
   */
  async issue(options) {
    const {
      severity = KillSeverity.LOCAL,
      target = {},
      reason = {},
      issuedBy,
      shutdownProcedure = ShutdownProcedure.GRACEFUL,
      requiresAcknowledgment = true,
      acknowledgmentDeadlineMinutes = 5,
    } = options;

    // Validate issuer authority
    const authorityCheck = this._checkAuthority(severity, issuedBy);
    if (!authorityCheck.authorized) {
      return {
        success: false,
        error: 'INSUFFICIENT_AUTHORITY',
        message: authorityCheck.message,
      };
    }

    // Estimate blast radius (informational)
    let emergencyImpactEstimate = null;
    if (this.blastRadiusEstimator) {
      try {
        emergencyImpactEstimate = await this.blastRadiusEstimator.estimate(target);
      } catch (error) {
        console.warn('[ISSUER] Failed to estimate blast radius:', error.message);
      }
    }

    // Create kill signal entry
    const killSignalId = crypto.randomUUID();
    const entry = new KillSignalEntry({
      killSignalId,
      issuedAt: new Date().toISOString(),
      issuedBy,
      severity,
      target: {
        scope: target.scope || null,
        agentIds: target.agentIds || null,
      },
      reason: {
        code: reason.code || 'MANUAL',
        description: reason.description || 'Manual kill signal',
        evidence: reason.evidence || [],
      },
      requiresAcknowledgment,
      acknowledgmentDeadline: new Date(
        Date.now() + acknowledgmentDeadlineMinutes * 60 * 1000
      ).toISOString(),
      shutdownProcedure,
    });

    // Store issued kill signal
    this.issuedKillSignals.set(killSignalId, entry);

    // Emit pre-issuance event for blast radius warning if needed
    if (emergencyImpactEstimate && emergencyImpactEstimate.businessImpact === 'CRITICAL') {
      this.emit('criticalBlastRadius', {
        killSignalId,
        emergencyImpactEstimate,
        severity,
      });
    }

    // Propagate via Raft consensus
    const result = await this.propagator.propagate(entry);

    if (!result.success) {
      this.issuedKillSignals.delete(killSignalId);
      return {
        success: false,
        error: result.error,
        message: result.message,
      };
    }

    // Emit issuance event
    this.emit('killSignalIssued', {
      killSignalId,
      severity,
      target: entry.target,
      issuedBy,
      emergencyImpactEstimate,
    });

    return {
      success: true,
      killSignalId,
      entry,
      emergencyImpactEstimate,
    };
  }

  /**
   * Check if issuer has authority for the severity level
   * @param {string} severity
   * @param {string} issuedBy
   * @returns {{authorized: boolean, message: string}}
   */
  _checkAuthority(severity, issuedBy) {
    // NOTE: Admin/role integration deferred - uses basic check for now
    // Production should replace with proper role-based authorization

    if (!issuedBy) {
      return {
        authorized: false,
        message: 'Issuer identity is required',
      };
    }

    // For GLOBAL kills, require special handling (F-2)
    if (severity === KillSeverity.GLOBAL) {
      // In production, this would check for C-level approval
      // For now, just log and allow
      console.log(`[ISSUER] GLOBAL kill signal being issued by ${issuedBy}`);
    }

    return { authorized: true };
  }

  /**
   * Get kill signal status
   * @param {string} killSignalId
   * @returns {Object|null}
   */
  getStatus(killSignalId) {
    const entry = this.issuedKillSignals.get(killSignalId);

    if (!entry) {
      // Try to get from propagator
      const propagated = this.propagator.getKillSignal(killSignalId);
      if (propagated) {
        return this._buildStatusResponse(propagated);
      }
      return null;
    }

    return this._buildStatusResponse(entry);
  }

  /**
   * Build status response for a kill signal
   */
  _buildStatusResponse(entry) {
    const totalTargets = entry.getTargetAgents(this.agentRegistry || { getAllAgents: () => [], getAgentsByScope: () => [] });
    const acks = this.acknowledgmentTracker
      ? this.acknowledgmentTracker.getAcknowledgments(entry.killSignalId)
      : [];

    return {
      killSignalId: entry.killSignalId,
      severity: entry.severity,
      target: entry.target,
      reason: entry.reason,
      issuedBy: entry.issuedBy,
      issuedAt: entry.issuedAt,
      state: entry.state,
      shutdownProcedure: entry.shutdownProcedure,
      requiresAcknowledgment: entry.requiresAcknowledgment,
      acknowledgmentDeadline: entry.acknowledgmentDeadline,
      statistics: {
        totalTargets: totalTargets.length,
        acknowledged: acks.length,
        missing: totalTargets.length - acks.length,
        completionPercentage: entry.getCompletionPercentage(totalTargets),
      },
    };
  }

  /**
   * Get all issued kill signals
   */
  getIssuedKillSignals() {
    return Array.from(this.issuedKillSignals.values());
  }

  /**
   * Get kill signals by state
   */
  getKillSignalsByState(state) {
    return Array.from(this.issuedKillSignals.values()).filter(e => e.state === state);
  }

  /**
   * Cancel a kill signal
   * F-2: Must satisfy override authority matrix
   * @param {string} killSignalId
   * @param {Object} cancelRequest - Cancel request with approvers
   */
  async cancel(killSignalId, cancelRequest) {
    const entry = this.issuedKillSignals.get(killSignalId);

    if (!entry) {
      return { success: false, error: 'Kill signal not found' };
    }

    if (entry.state !== KillSignalState.ACTIVE) {
      return {
        success: false,
        error: 'INVALID_STATE',
        message: `Cannot cancel kill signal in ${entry.state} state`,
      };
    }

    const result = await this.propagator.cancel(killSignalId, cancelRequest);
    return result;
  }

  /**
   * Check kill signal progress
   * @param {string} killSignalId
   * @returns {Object|null}
   */
  checkProgress(killSignalId) {
    const entry = this.issuedKillSignals.get(killSignalId) ||
      this.propagator.getKillSignal(killSignalId);

    if (!entry) {
      return null;
    }

    const totalTargets = entry.getTargetAgents(this.agentRegistry || { getAllAgents: () => [], getAgentsByScope: () => [] });
    const progress = this.acknowledgmentTracker
      ? this.acknowledgmentTracker.checkProgress(killSignalId, totalTargets.length)
      : { totalExpected: totalTargets.length, acknowledged: 0, missing: totalTargets.length };

    return {
      killSignalId,
      state: entry.state,
      progress,
      deadlinePassed: entry.isDeadlinePassed(),
    };
  }
}

module.exports = KillSwitchIssuer;
