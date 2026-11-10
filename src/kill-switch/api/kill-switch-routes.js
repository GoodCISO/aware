// src/kill-switch/api/kill-switch-routes.js
// Phase 1.4: Kill Switch — API routes for revocation operations

const express = require('express');
const router = express.Router();

/**
 * Kill Switch API Routes
 * 
 * These routes provide the external interface for the distributed kill switch.
 * Revocations go through Raft consensus before being applied.
 */

/**
 * DELETE /api/kill-switch/agents/:agentId
 * Revoke an agent across the entire cluster via Raft consensus
 * 
 * Requires: Leader role, admin JWT
 * Returns: 200 on success, 503 if not leader (with redirect)
 */
router.delete('/agents/:agentId', async (req, res) => {
  const { agentId } = req.params;
  const { reason = 'manual' } = req.body;
  
  // Get revocation service from app context
  const revocationService = req.app.get('revocationService');
  
  if (!revocationService) {
    return res.status(503).json({ 
      error: 'SERVICE_UNAVAILABLE',
      message: 'Kill switch service not initialized'
    });
  }
  
  // The kill switch is wired to the Raft layer only when this process is part
  // of a cluster. Report the missing dependency instead of failing later with
  // an opaque 500 (t_8c8cbf64).
  if (typeof revocationService.isReady === 'function' && !revocationService.isReady()) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: `Kill switch is not wired to the Raft consensus layer (missing: ${(revocationService.missingDependencies || []).join(', ')})`,
      missing: revocationService.missingDependencies || []
    });
  }
  
  try {
    const result = await revocationService.initiateRevocation(
      agentId,
      reason,
      req.user?.id || 'system'
    );
    
    if (result.success) {
      return res.status(200).json({
        success: true,
        agentId,
        revocationId: result.entry.id,
        message: 'Agent revoked via Raft consensus'
      });
    } else if (result.error === 'NOT_LEADER') {
      return res.status(503).json({
        error: 'NOT_LEADER',
        redirect: result.redirect,
        message: result.message
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error,
        message: result.message || 'Revocation failed'
      });
    }
  } catch (error) {
    console.error('[KILL-SWITCH] Revocation error:', error);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * GET /api/kill-switch/status/:agentId
 * Check if an agent is revoked
 */
router.get('/status/:agentId', (req, res) => {
  const { agentId } = req.params;
  
  const revocationService = req.app.get('revocationService');
  
  if (!revocationService) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Kill switch service not initialized'
    });
  }
  
  const status = revocationService.getRevocationStatus(agentId);
  
  return res.status(200).json({
    agentId,
    ...status
  });
});

/**
 * POST /api/kill-switch/agents/:agentId/reinstate
 * Reinstate a previously revoked agent (rollback mechanism)
 * M-03: Revocation rollback
 */
router.post('/agents/:agentId/reinstate', async (req, res) => {
  const { agentId } = req.params;
  const { reason = 'manual', originalRevocationId } = req.body;
  
  const revocationService = req.app.get('revocationService');
  
  if (!revocationService) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Kill switch service not initialized'
    });
  }
  
  // The kill switch is wired to the Raft layer only when this process is part
  // of a cluster. Report the missing dependency instead of failing later with
  // an opaque 500 (t_8c8cbf64).
  if (typeof revocationService.isReady === 'function' && !revocationService.isReady()) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: `Kill switch is not wired to the Raft consensus layer (missing: ${(revocationService.missingDependencies || []).join(', ')})`,
      missing: revocationService.missingDependencies || []
    });
  }
  
  if (!originalRevocationId) {
    return res.status(400).json({
      error: 'BAD_REQUEST',
      message: 'originalRevocationId is required'
    });
  }
  
  try {
    const result = await revocationService.reinstate(
      agentId,
      reason,
      req.user?.id || 'system',
      originalRevocationId
    );
    
    if (result.success) {
      return res.status(200).json({
        success: true,
        agentId,
        reinstatementId: result.entry.id,
        message: 'Agent reinstated via Raft consensus'
      });
    } else if (result.error === 'NOT_LEADER') {
      return res.status(503).json({
        error: 'NOT_LEADER',
        redirect: result.redirect,
        message: result.message
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error,
        message: 'Reinstatement failed'
      });
    }
  } catch (error) {
    console.error('[KILL-SWITCH] Reinstatement error:', error);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    });
  }
});

/**
 * GET /api/kill-switch/stats
 * Get kill switch statistics
 */
router.get('/stats', (req, res) => {
  const revocationService = req.app.get('revocationService');
  
  if (!revocationService) {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Kill switch service not initialized'
    });
  }
  
  return res.status(200).json({
    committedRevocations: revocationService.getCommittedRevocationCount(),
    pendingRevocations: revocationService.pendingRevocations?.size || 0
  });
});

module.exports = router;
