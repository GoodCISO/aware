// src/agents/identity-provider-v2.js
// Identity Provider v2 — Agent Identity & Authentication Framework
// Phase 3.1: Extended JWT claims, session binding, attestation
// Extends: src/agents/identity-provider.js (Phase 1.1)

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Agent, AgentState } = require('../api/models/Agent');

// Default session TTL: 15 minutes (production) / 30 minutes (staging)
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const STAGING_SESSION_TTL_MS = 30 * 60 * 1000;

// Attestation cache TTL: 15 minutes
const ATTESTATION_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Identity Provider v2
 * Extends Phase 1.1 IdentityProvider with:
 * - Extended JWT claims (trustDomain, blastRadius, sessionId, executionContext)
 * - Session binding with execution context
 * - Zero-downtime credential rotation
 * - Identity attestation for cross-agent communication
 */
class IdentityProviderV2 {
  constructor(config = {}) {
    // CRITICAL: Secret key is required - no defaults allowed
    if (!config.secretKey) {
      throw new Error('FATAL: identity-provider-v2 requires config.secretKey. No default value allowed.');
    }
    this.secretKey = config.secretKey;
    this.issuer = config.issuer || 'aware-ca';
    
    // Session TTL configuration
    this.sessionTtlMs = config.environment === 'staging' 
      ? STAGING_SESSION_TTL_MS 
      : (config.sessionTtlMs || DEFAULT_SESSION_TTL_MS);
    
    // Trust domain (required for Phase 3.1)
    if (!config.trustDomain) {
      throw new Error('FATAL: identity-provider-v2 requires config.trustDomain. No default value allowed.');
    }
    this.trustDomain = config.trustDomain;
    
    // Attestation cache TTL
    this.attestationCacheTtlMs = config.attestationCacheTtlMs || ATTESTATION_CACHE_TTL_MS;
    
    // Session store (agentId -> session data)
    this.sessions = new Map();
    
    // Attestation cache (agentId -> { verified, expiresAt })
    this.attestationCache = new Map();
    
    // Cleanup intervals
    this.sessionCleanupInterval = setInterval(() => this._cleanupExpiredSessions(), 60 * 1000);
    this.attestationCleanupInterval = setInterval(() => this._cleanupExpiredAttestations(), 60 * 1000);
  }

  /**
   * Create a session and issue a bound JWT for an agent
   * @param {string} agentId - The agent's unique identifier
   * @param {object} executionContext - The execution context to bind
   * @param {object} options - Additional options
   * @returns {object} Session info with token
   */
  createSession(agentId, executionContext = {}, options = {}) {
    const agent = Agent.findByAgentId(agentId);
    
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    
    if (agent.state !== AgentState.ACTIVE) {
      throw new Error(`Cannot create session for agent in ${agent.state} state`);
    }
    
    // Generate session ID
    const sessionId = `sess-${crypto.randomBytes(16).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + this.sessionTtlMs;
    
    // Store session data
    const session = {
      sessionId,
      agentId,
      executionContext: {
        workspace: executionContext.workspace || '/workspace/default',
        browserProfile: executionContext.browserProfile || 'default',
        maxConcurrentTasks: executionContext.maxConcurrentTasks || 3,
        allowedTools: executionContext.allowedTools || ['*'],
        deniedTools: executionContext.deniedTools || [],
        ...executionContext
      },
      trustDomain: this.trustDomain,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      lastHeartbeat: now,
      metadata: options.metadata || {}
    };
    
    this.sessions.set(sessionId, session);
    
    // Issue JWT with extended claims
    const token = this._issueToken(agent, session);
    
    return {
      sessionId,
      token,
      expiresAt: session.expiresAt,
      expiresInSeconds: Math.floor(this.sessionTtlMs / 1000),
      executionContext: session.executionContext
    };
  }

  /**
   * Issue a JWT with extended claims bound to a session
   * @private
   */
  _issueToken(agent, session) {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + Math.floor(this.sessionTtlMs / 1000);
    
    // Extended JWT claims per ADR (internal)
    const payload = {
      // Standard claims
      sub: agent.agentId,
      iss: this.issuer,
      type: 'agent',
      
      // Identity claims
      agentId: agent.agentId,
      name: agent.name,
      agentType: agent.type,
      agentVersion: agent.version,
      
      // Security claims (ADR (internal))
      trustDomain: this.trustDomain,
      clearance: agent.clearance,
      
      // Capability claims (as object, not array per ADR (internal))
      capabilities: this._normalizeCapabilities(agent.capabilities),
      
      // Trust scoring (from ADR (internal))
      declaredTrustScore: agent.declaredTrustScore,
      // Operator-declared blast-radius ESTIMATE.
      //
      // This is NOT a computed radius. It is read from agent metadata with a
      // hardcoded fallback, and no writer for `metadata.blastRadius` was
      // found in the identity or registry code — so the fallback is the
      // effective value in normal operation.
      //
      // The claim is named `declaredBlastRadiusEstimate` rather than
      // `blastRadius` because four different mechanisms previously answered
      // to the name "blast radius" with four incompatible representations:
      //
      //   declaredBlastRadiusEstimate  a supplied fraction in [0,1]  (this)
      //   revocationTrailPenalty        a computed erosion factor   [0,1]
      //   emergencyImpactEstimate       a computed impact record    (object)
      //   protocolBlastRadiusSeverity   a legacy severity label    (string)
      //
      // A consumer could not tell which it held. The distinct names make the
      // distinction checkable. See src/governance/registry.js.
      declaredBlastRadiusEstimate: agent.metadata.blastRadius || 0.1,
      
      // Session binding (ADR (internal))
      sessionId: session.sessionId,
      executionContext: session.executionContext,
      
      // Temporal claims
      issuedAt: new Date(now * 1000).toISOString(),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      notBefore: new Date(now * 1000).toISOString(),
      
      // Metadata
      iat: now,
      exp: expiresAt
    };
    
    return jwt.sign(payload, this.secretKey, {
      algorithm: 'HS256',
      keyid: String(agent.id)
    });
  }

  /**
   * Normalize capabilities to object format (capability -> score)
   * @private
   */
  _normalizeCapabilities(capabilities) {
    if (Array.isArray(capabilities)) {
      // Convert array to object with default scores
      const normalized = {};
      for (const cap of capabilities) {
        normalized[cap] = 0.8; // Default capability score
      }
      return normalized;
    }
    if (typeof capabilities === 'object') {
      return capabilities;
    }
    return {};
  }

  /**
   * Verify a session token and return verification result
   * @param {string} token - The JWT to verify
   * @returns {object} Verification result
   */
  verifySession(token) {
    try {
      const decoded = jwt.verify(token, this.secretKey, {
        algorithms: ['HS256']
      });
      
      // Verify session exists and is valid
      const session = this.sessions.get(decoded.sessionId);
      if (!session) {
        return { valid: false, error: 'SESSION_NOT_FOUND', sessionId: decoded.sessionId };
      }
      
      // Check session expiry
      if (new Date(session.expiresAt) < new Date()) {
        this.sessions.delete(decoded.sessionId);
        return { valid: false, error: 'SESSION_EXPIRED', sessionId: decoded.sessionId };
      }
      
      // Verify agent still exists and is active
      const agent = Agent.findByAgentId(decoded.agentId);
      if (!agent) {
        return { valid: false, error: 'AGENT_NOT_FOUND' };
      }
      
      if (agent.state !== AgentState.ACTIVE) {
        return { valid: false, error: `AGENT_NOT_ACTIVE (state: ${agent.state})` };
      }
      
      // Verify trustDomain matches
      if (decoded.trustDomain !== this.trustDomain) {
        return { valid: false, error: 'TRUST_DOMAIN_MISMATCH', expected: this.trustDomain, actual: decoded.trustDomain };
      }
      
      return {
        valid: true,
        sessionId: decoded.sessionId,
        agentId: decoded.agentId,
        // Back-compat: tokens issued before the rename carry `trustScore`.
        // Prefer the new claim, fall back to the legacy one so in-flight
        // tokens keep verifying across the rename.
        declaredTrustScore:
          decoded.declaredTrustScore !== undefined
            ? decoded.declaredTrustScore
            : decoded.trustScore,
        clearance: decoded.clearance,
        trustDomain: decoded.trustDomain,
        executionContext: decoded.executionContext,
        capabilities: decoded.capabilities,
        expiresAt: decoded.expiresAt
      };
      
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return { valid: false, error: 'TOKEN_EXPIRED' };
      }
      if (error.name === 'JsonWebTokenError') {
        return { valid: false, error: 'INVALID_TOKEN', message: error.message };
      }
      return { valid: false, error: 'VERIFICATION_FAILED', message: error.message };
    }
  }

  /**
   * Refresh a session (extend expiry, optional new execution context)
   * @param {string} sessionId - The session to refresh
   * @param {object} newContext - Optional new execution context
   * @returns {object} New session info
   */
  refreshSession(sessionId, newContext = null) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    
    const agent = Agent.findByAgentId(session.agentId);
    if (!agent || agent.state !== AgentState.ACTIVE) {
      throw new Error('Agent not active');
    }
    
    // Update session expiry
    const now = Date.now();
    session.expiresAt = new Date(now + this.sessionTtlMs).toISOString();
    session.lastHeartbeat = now;
    
    // Update execution context if provided
    if (newContext) {
      session.executionContext = {
        ...session.executionContext,
        ...newContext
      };
    }
    
    // Issue new token
    const token = this._issueToken(agent, session);
    
    return {
      sessionId,
      token,
      expiresAt: session.expiresAt,
      expiresInSeconds: Math.floor(this.sessionTtlMs / 1000)
    };
  }

  /**
   * Invalidate a session
   * @param {string} sessionId - The session to invalidate
   */
  invalidateSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  /**
   * Verify tool access for a session
   * @param {string} sessionId - The session to check
   * @param {string} toolName - The tool being accessed
   * @returns {object} Access verification result
   */
  verifyToolAccess(sessionId, toolName) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { allowed: false, error: 'SESSION_NOT_FOUND' };
    }
    
    const { allowedTools, deniedTools } = session.executionContext;
    
    // Check deny list first
    if (deniedTools.includes(toolName)) {
      return { allowed: false, error: 'TOOL_DENIED', tool: toolName };
    }
    
    // Check allow list
    if (allowedTools.includes('*')) {
      return { allowed: true };
    }
    
    if (!allowedTools.includes(toolName)) {
      return { allowed: false, error: 'TOOL_NOT_ALLOWED', tool: toolName };
    }
    
    return { allowed: true };
  }

  /**
   * Attestation verification for cross-agent communication
   * @param {string} token - The presenting agent's JWT
   * @param {string} targetTrustDomain - The target trust domain
   * @returns {object} Attestation result
   */
  async verifyAttestation(token, targetTrustDomain) {
    // Check attestation cache first
    const cached = this._getCachedAttestation(token);
    if (cached) {
      return cached;
    }
    
    // Verify the JWT
    const verification = this.verifySession(token);
    
    if (!verification.valid) {
      const result = { verified: false, error: verification.error };
      await this._cacheAttestation(token, result);
      return result;
    }
    
    // Verify trustDomain
    if (targetTrustDomain && verification.trustDomain !== targetTrustDomain) {
      const result = { verified: false, error: 'TRUST_DOMAIN_MISMATCH', expected: targetTrustDomain, actual: verification.trustDomain };
      await this._cacheAttestation(token, result);
      return result;
    }
    
    // Check revocation status
    const isRevoked = this._isAgentRevoked(verification.agentId);
    if (isRevoked) {
      const result = { verified: false, error: 'AGENT_REVOKED', agentId: verification.agentId };
      await this._cacheAttestation(token, result);
      return result;
    }
    
    const result = {
      verified: true,
      agentId: verification.agentId,
      declaredTrustScore: verification.declaredTrustScore,
      clearance: verification.clearance,
      trustDomain: verification.trustDomain,
      capabilities: verification.capabilities
    };
    
    await this._cacheAttestation(token, result);
    return result;
  }

  /**
   * Check if an agent is revoked
   * @private
   */
  _isAgentRevoked(agentId) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) return true;
    return agent.state === AgentState.REVOKED;
  }

  /**
   * Get cached attestation result
   * @private
   */
  _getCachedAttestation(token) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const cached = this.attestationCache.get(hash);
    
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }
    
    if (cached) {
      this.attestationCache.delete(hash);
    }
    
    return null;
  }

  /**
   * Cache attestation result
   * @private
   */
  async _cacheAttestation(token, result) {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    this.attestationCache.set(hash, {
      result,
      expiresAt: Date.now() + this.attestationCacheTtlMs
    });
  }

  /**
   * Cleanup expired sessions
   * @private
   */
  _cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (new Date(session.expiresAt).getTime() < now) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Cleanup expired attestation cache entries
   * @private
   */
  _cleanupExpiredAttestations() {
    const now = Date.now();
    for (const [hash, cached] of this.attestationCache.entries()) {
      if (cached.expiresAt < now) {
        this.attestationCache.delete(hash);
      }
    }
  }

  /**
   * Get session info without verification
   * @param {string} sessionId - The session ID
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * List all active sessions
   */
  listSessions() {
    return Array.from(this.sessions.values());
  }

  /**
   * Destroy the identity provider (cleanup)
   */
  destroy() {
    if (this.sessionCleanupInterval) {
      clearInterval(this.sessionCleanupInterval);
    }
    if (this.attestationCleanupInterval) {
      clearInterval(this.attestationCleanupInterval);
    }
    this.sessions.clear();
    this.attestationCache.clear();
  }
}

module.exports = IdentityProviderV2;
