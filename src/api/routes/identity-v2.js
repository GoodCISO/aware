// src/api/routes/identity-v2.js
// Identity v2 Routes — Agent Identity & Authentication Framework
// Phase 3.1: Session management, attestation, revocation cache
// Extends: src/api/routes/agents.js (Phase 1.1)

const express = require('express');
const router = express.Router();
const IdentityProviderV2 = require('../../agents/identity-provider-v2');
const SessionManager = require('../../agents/session-manager');
const AttestationService = require('../../agents/attestation-service');
const RevocationCache = require('../../agents/revocation-cache');
const { authenticateToken } = require('../middleware/auth');
const { resolveSecretKey } = require('../../engine-secret');

// Initialize services (singleton pattern for shared state)
let identityProvider = null;
let sessionManager = null;
let attestationService = null;
let revocationCache = null;

/**
 * Initialize services with configuration.
 *
 * SC-MOD-014 : the previous
 * `config.secretKey || process.env.SECRET_KEY` fallback chain silently
 * accepted short / absent secrets. identity-v2 needs the same
 * fail-closed + length-validated path as src/api/middleware/auth.js
 * and src/index.js, otherwise an operator who forgets to set
 * SECRET_KEY in production can sign JWTs with a guessable key.
 *
 * Production → fail fast if SECRET_KEY is missing or shorter than
 * 32 chars. Dev/test → fall back to a clearly-marked dev default.
 */
function resolveIdentityV2SecretKey(configSecretKey, envSecretKey) {
  return resolveSecretKey({
    configSecretKey,
    envSecretKey,
    minLength: 32,
  });
}

/**
 * Initialize services with configuration
 */
function initializeServices(config = {}) {
  if (!identityProvider) {
    const secretKey = resolveIdentityV2SecretKey(
      config.secretKey,
      process.env.SECRET_KEY,
    );
    identityProvider = new IdentityProviderV2({
      secretKey,
      issuer: config.issuer || 'aware-ca',
      trustDomain: config.trustDomain || process.env.AWARE_TRUST_DOMAIN || 'aware-prod',
      environment: config.environment || process.env.NODE_ENV || 'production',
      sessionTtlMs: config.sessionTtlMs,
      attestationCacheTtlMs: config.attestationCacheTtlMs
    });
  }
  
  if (!sessionManager) {
    sessionManager = new SessionManager({
      sessionTtlMs: config.sessionTtlMs || 15 * 60 * 1000,
      heartbeatIntervalMs: config.heartbeatIntervalMs || 60 * 1000
    });
  }
  
  if (!attestationService) {
    attestationService = new AttestationService({
      trustDomain: config.trustDomain || process.env.AWARE_TRUST_DOMAIN || 'aware-prod'
    });
  }
  
  if (!revocationCache) {
    revocationCache = new RevocationCache({
      cacheTtlMs: config.cacheTtlMs || 60 * 1000
    });
  }
  
  return { identityProvider, sessionManager, attestationService, revocationCache };
}

/**
 * Get service instances (initializes if needed)
 */
function getServices() {
  if (!identityProvider) {
    initializeServices({});
  }
  return { identityProvider, sessionManager, attestationService, revocationCache };
}

// =============================================================================
// AGENT SESSION ENDPOINTS
// =============================================================================

/**
 * POST /api/agents/:agentId/session
 * Create a new session for an agent
 */
router.post('/:agentId/session', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { executionContext, metadata } = req.body;
    
    if (!executionContext) {
      return res.status(400).json({ error: 'executionContext is required' });
    }
    
    const { identityProvider, sessionManager } = getServices();
    
    // Create session
    const session = sessionManager.createSession(agentId, executionContext, metadata);
    
    // Issue JWT
    const tokenData = identityProvider.createSession(agentId, executionContext, metadata);
    
    res.status(201).json({
      success: true,
      sessionId: tokenData.sessionId,
      token: tokenData.token,
      expiresAt: tokenData.expiresAt,
      expiresInSeconds: tokenData.expiresInSeconds,
      executionContext: tokenData.executionContext
    });
    
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/agents/:agentId/session/:sessionId/heartbeat
 * Session heartbeat
 */
router.post('/:agentId/session/:sessionId/heartbeat', async (req, res) => {
  try {
    const { agentId, sessionId } = req.params;
    const { executionContext, metadata } = req.body;
    
    const { identityProvider, sessionManager } = getServices();
    
    // Verify session belongs to agent
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    }
    if (session.agentId !== agentId) {
      return res.status(403).json({ error: 'Session does not belong to this agent' });
    }
    
    // Update heartbeat
    const result = sessionManager.heartbeat(sessionId, { executionContext, metadata });
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    // Refresh session token
    const refreshResult = identityProvider.refreshSession(sessionId, executionContext);
    
    res.json({
      success: true,
      sessionId,
      expiresAt: result.expiresAt,
      heartbeatCount: result.heartbeatCount,
      token: refreshResult.token
    });
    
  } catch (error) {
    console.error('Session heartbeat error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/agents/:agentId/sessions
 * List all sessions for an agent
 */
router.get('/:agentId/sessions', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { sessionManager } = getServices();
    
    const sessions = sessionManager.getAgentSessions(agentId);
    
    res.json({
      success: true,
      agentId,
      sessions: sessions.map(s => ({
        sessionId: s.sessionId,
        status: s.status,
        createdAt: new Date(s.createdAt).toISOString(),
        expiresAt: new Date(s.expiresAt).toISOString(),
        lastHeartbeat: new Date(s.lastHeartbeat).toISOString(),
        heartbeatCount: s.heartbeatCount,
        executionContext: s.executionContext
      }))
    });
    
  } catch (error) {
    console.error('List sessions error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/agents/:agentId/session/:sessionId
 * Invalidate a session
 */
router.delete('/:agentId/session/:sessionId', async (req, res) => {
  try {
    const { agentId, sessionId } = req.params;
    const { identityProvider, sessionManager } = getServices();
    
    // Verify session exists and belongs to agent
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    }
    if (session.agentId !== agentId) {
      return res.status(403).json({ error: 'Session does not belong to this agent' });
    }
    
    // Invalidate
    identityProvider.invalidateSession(sessionId);
    sessionManager.revokeSession(sessionId, 'manual');
    
    res.json({ success: true, sessionId });
    
  } catch (error) {
    console.error('Session invalidation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// IDENTITY ATTESTATION ENDPOINTS
// =============================================================================

/**
 * POST /api/identity/verify
 * Verify an attestation token
 */
router.post('/verify', async (req, res) => {
  try {
    const { token, targetTrustDomain } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }
    
    const { attestationService } = getServices();
    
    const result = await attestationService.verifyAttestation(token, {
      targetTrustDomain
    });
    
    if (!result.verified) {
      return res.status(403).json({ error: result.error, ...result });
    }
    
    res.json({
      verified: true,
      agentId: result.agentId,
      agentType: result.agentType,
      declaredTrustScore: result.declaredTrustScore,
      clearance: result.clearance,
      trustDomain: result.trustDomain,
      capabilities: result.capabilities,
      declaredBlastRadiusEstimate: result.declaredBlastRadiusEstimate,
      sessionId: result.sessionId
    });
    
  } catch (error) {
    console.error('Attestation verification error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/identity/verify-batch
 * Verify multiple attestation tokens
 */
router.post('/verify-batch', async (req, res) => {
  try {
    const { attestations } = req.body;
    
    if (!Array.isArray(attestations)) {
      return res.status(400).json({ error: 'attestations must be an array' });
    }
    
    const { attestationService } = getServices();
    
    const results = await attestationService.verifyBatch(attestations);
    
    res.json({
      success: true,
      results: results.map((result, index) => ({
        index,
        ...result
      }))
    });
    
  } catch (error) {
    console.error('Batch attestation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/identity/revocation-list
 * Get the current revocation list
 */
router.get('/revocation-list', async (req, res) => {
  try {
    const { revocationCache } = getServices();
    
    const revoked = revocationCache.getRevokedAgents();
    
    res.json({
      success: true,
      revokedAgents: revoked,
      count: revoked.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Revocation list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// REVOCATION ENDPOINTS
// =============================================================================

/**
 * POST /api/agents/:agentId/revoke
 * Revoke an agent
 */
router.post('/:agentId/revoke', authenticateToken, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { severity, reason, issuedBy } = req.body;
    
    if (!severity || !['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(severity)) {
      return res.status(400).json({ error: 'severity must be CRITICAL, HIGH, MEDIUM, or LOW' });
    }
    
    const { revocationCache } = getServices();
    
    const result = await revocationCache.revoke(agentId, severity, reason || 'manual', { issuedBy });
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({
      success: true,
      agentId: result.agentId,
      severity: result.severity,
      reason: result.reason,
      blastRadiusPenalty: result.blastRadiusPenalty,
      expiresAt: result.expiresAt
    });
    
  } catch (error) {
    console.error('Agent revocation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/agents/:agentId/reinstate
 * Reinstate a revoked agent
 */
router.post('/:agentId/reinstate', authenticateToken, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { issuedBy } = req.body;
    
    const { revocationCache } = getServices();
    
    const result = await revocationCache.reinstate(agentId, { issuedBy });
    
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    
    res.json({
      success: true,
      agentId: result.agentId
    });
    
  } catch (error) {
    console.error('Agent reinstatement error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/agents/:agentId/revocation-status
 * Get revocation status for an agent
 */
router.get('/:agentId/revocation-status', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { revocationCache } = getServices();
    
    const status = revocationCache.getStatus(agentId);
    
    if (!status) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    }
    
    res.json({
      success: true,
      agentId,
      ...status
    });
    
  } catch (error) {
    console.error('Revocation status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// STATISTICS ENDPOINTS
// =============================================================================

/**
 * GET /api/identity/stats
 * Get identity service statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const { identityProvider, sessionManager, attestationService, revocationCache } = getServices();
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      identityProvider: {
        activeSessions: identityProvider.listSessions().length
      },
      sessionManager: sessionManager.getStats(),
      attestationService: attestationService.getStats(),
      revocationCache: revocationCache.getStats()
    });
    
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/identity/tool-access
 * Verify tool access for a session
 */
router.post('/tool-access', async (req, res) => {
  try {
    const { sessionId, toolName } = req.body;
    
    if (!sessionId || !toolName) {
      return res.status(400).json({ error: 'sessionId and toolName are required' });
    }
    
    const { sessionManager } = getServices();
    
    const result = sessionManager.verifyToolAccess(sessionId, toolName);
    
    if (!result.allowed) {
      return res.status(403).json({ error: result.error, tool: toolName });
    }
    
    res.json({
      allowed: true,
      sessionId,
      toolName
    });
    
  } catch (error) {
    console.error('Tool access error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = {
  router,
  initializeServices,
  getServices
};
