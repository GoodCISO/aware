// src/emergency/api/emergency-routes.js
// Phase 3.2: Kill Switch Propagation — API routes for emergency shutdown operations

const express = require('express');
const router = express.Router();

/**
 * Emergency Shutdown API Routes
 *
 * Endpoints:
 * - POST /api/kill-switch/issue - Issue a kill signal
 * - GET /api/kill-switch/:killSignalId - Get kill signal status
 * - GET /api/kill-switch/:killSignalId/acks - Get acknowledgments
 * - GET /api/kill-switch/:killSignalId/progress - Get propagation progress
 * - POST /api/kill-switch/:killSignalId/cancel - Cancel a kill signal
 * - POST /api/recovery/:agentId/onboard - Re-onboard a killed agent
 * - POST /api/recovery/:agentId/estimate-blast-radius - Estimate blast radius
 */

/**
 * POST /api/kill-switch/issue
 * Issue a new kill signal
 * Requires: Admin JWT with appropriate role
 */
router.post('/issue', async (req, res) => {
  const {
    severity,
    target,
    reason,
    issuedBy,
    shutdownProcedure = 'GRACEFUL',
    requiresAcknowledgment = true,
    acknowledgmentDeadlineMinutes = 5,
  } = req.body;

  const killSwitchIssuer = req.app.get('killSwitchIssuer');

  if (!killSwitchIssuer) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Kill switch service not initialized',
    });
  }

  try {
    const result = await killSwitchIssuer.issue({
      severity,
      target,
      reason,
      issuedBy: issuedBy || req.user?.id || 'system',
      shutdownProcedure,
      requiresAcknowledgment,
      acknowledgmentDeadlineMinutes,
    });

    if (result.success) {
      return res.status(201).json({
        success: true,
        killSignalId: result.killSignalId,
        severity,
        target,
        emergencyImpactEstimate: result.emergencyImpactEstimate,
        message: 'Kill signal issued via Raft consensus',
      });
    } else {
      return res.status(403).json({
        error: result.error,
        message: result.message,
      });
    }
  } catch (error) {
    console.error('[API] Error issuing kill signal:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: error.message,
    });
  }
});

/**
 * GET /api/kill-switch/:killSignalId
 * Get status of a specific kill signal
 */
router.get('/:killSignalId', async (req, res) => {
  const { killSignalId } = req.params;
  const killSwitchIssuer = req.app.get('killSwitchIssuer');

  if (!killSwitchIssuer) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Kill switch service not initialized',
    });
  }

  const status = killSwitchIssuer.getStatus(killSignalId);

  if (!status) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: `Kill signal ${killSignalId} not found`,
    });
  }

  return res.status(200).json(status);
});

/**
 * GET /api/kill-switch/:killSignalId/acks
 * Get acknowledgments for a kill signal
 */
router.get('/:killSignalId/acks', async (req, res) => {
  const { killSignalId } = req.params;
  const acknowledgmentTracker = req.app.get('acknowledgmentTracker');

  if (!acknowledgmentTracker) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Acknowledgment tracker not initialized',
    });
  }

  const acks = acknowledgmentTracker.getAcknowledgments(killSignalId);

  return res.status(200).json({
    killSignalId,
    acknowledgments: acks,
    count: acks.length,
  });
});

/**
 * GET /api/kill-switch/:killSignalId/progress
 * Get propagation progress for a kill signal
 */
router.get('/:killSignalId/progress', async (req, res) => {
  const { killSignalId } = req.params;
  const killSwitchIssuer = req.app.get('killSwitchIssuer');

  if (!killSwitchIssuer) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Kill switch service not initialized',
    });
  }

  const progress = killSwitchIssuer.checkProgress(killSignalId);

  if (!progress) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: `Kill signal ${killSignalId} not found`,
    });
  }

  return res.status(200).json(progress);
});

/**
 * POST /api/kill-switch/:killSignalId/cancel
 * Cancel an active kill signal
 * F-2: Requires proper authority based on severity level
 */
router.post('/:killSignalId/cancel', async (req, res) => {
  const { killSignalId } = req.params;
  const { requestedBy, justification, approvers } = req.body;

  const killSwitchIssuer = req.app.get('killSwitchIssuer');

  if (!killSwitchIssuer) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Kill switch service not initialized',
    });
  }

  const cancelRequest = {
    killSignalId,
    requestedBy: requestedBy || req.user?.id || 'system',
    justification,
    approvers: approvers || [],
  };

  try {
    const result = await killSwitchIssuer.cancel(killSignalId, cancelRequest);

    if (result.success) {
      return res.status(200).json({
        success: true,
        message: 'Kill signal cancelled',
      });
    } else {
      return res.status(403).json({
        error: result.error,
        message: result.message,
      });
    }
  } catch (error) {
    console.error('[API] Error cancelling kill signal:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: error.message,
    });
  }
});

/**
 * POST /api/recovery/:agentId/onboard
 * Request re-onboarding for a killed agent
 */
router.post('/:agentId/onboard', async (req, res) => {
  const { agentId } = req.params;
  const { requestedBy, justification, approvedBy } = req.body;

  const recoveryManager = req.app.get('recoveryManager');

  if (!recoveryManager) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Recovery service not initialized',
    });
  }

  // If approvedBy is provided, this is an approval action
  if (approvedBy) {
    const result = await recoveryManager.approveReOnboarding(agentId, approvedBy);
    if (result.success) {
      return res.status(200).json({
        success: true,
        message: 'Agent re-onboarding approved and executed',
      });
    } else {
      return res.status(403).json({
        error: result.error,
        message: result.message,
      });
    }
  }

  // Otherwise, this is a request
  const result = await recoveryManager.requestReOnboarding(
    agentId,
    requestedBy || req.user?.id || 'system',
    justification
  );

  if (result.success) {
    return res.status(201).json({
      success: true,
      recoveryId: result.recoveryId,
      state: result.state,
      message: 'Re-onboarding request submitted',
    });
  } else {
    return res.status(403).json({
      error: result.error,
      message: result.message,
    });
  }
});

/**
 * GET /api/recovery/:agentId/status
 * Get recovery status for an agent
 */
router.get('/:agentId/status', async (req, res) => {
  const { agentId } = req.params;
  const recoveryManager = req.app.get('recoveryManager');

  if (!recoveryManager) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Recovery service not initialized',
    });
  }

  const status = recoveryManager.getRecoveryStatus(agentId);

  if (!status) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: `No recovery request found for agent ${agentId}`,
    });
  }

  return res.status(200).json(status);
});

/**
 * POST /api/recovery/blast-radius
 * Estimate blast radius for a target scope
 */
router.post('/blast-radius', async (req, res) => {
  const { target } = req.body;
  const blastRadiusEstimator = req.app.get('blastRadiusEstimator');

  if (!blastRadiusEstimator) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Blast radius estimator not initialized',
    });
  }

  try {
    const estimate = await blastRadiusEstimator.estimate(target);
    return res.status(200).json(estimate);
  } catch (error) {
    console.error('[API] Error estimating blast radius:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: error.message,
    });
  }
});

module.exports = router;
