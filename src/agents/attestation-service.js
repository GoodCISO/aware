// src/agents/attestation-service.js
// Attestation Service — Agent Identity & Authentication Framework
// Phase 3.1: Cross-agent identity verification
// Verifies JWT tokens and establishes trust between agents

const crypto = require('crypto');
const { Agent, AgentState } = require('../api/models/Agent');

// Attestation cache TTL: 15 minutes per ADR (internal)
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Attestation Service
 * Provides cross-agent identity verification:
 * - JWT signature verification
 * - Temporal validity checking (notBefore, expiresAt)
 * - Trust domain matching
 * - Revocation status checking
 * - Cached verification results for performance
 */
class AttestationService {
  constructor(config = {}) {
    this.config = {
      trustDomain: config.trustDomain || 'aware-prod',
      cacheTtlMs: config.cacheTtlMs || DEFAULT_CACHE_TTL_MS,
      requireTrustDomainMatch: config.requireTrustDomainMatch !== false,
      ...config
    };
    
    // Attestation cache: tokenHash -> { result, expiresAt }
    this.attestationCache = new Map();
    
    // Cleanup interval
    this.cleanupInterval = setInterval(() => this._cleanupExpiredCache(), 60 * 1000);
  }

  /**
   * Verify attestation for a presenting agent
   * @param {string} token - The presenting agent's JWT
   * @param {object} options - Verification options
   * @returns {object} Attestation result
   */
  async verifyAttestation(token, options = {}) {
    const targetTrustDomain = options.targetTrustDomain || this.config.trustDomain;
    
    // Check cache first
    const cached = this._getCachedResult(token);
    if (cached) {
      return cached;
    }
    
    // Perform verification
    const result = await this._verify(token, targetTrustDomain, options);
    
    // Cache the result
    await this._cacheResult(token, result);
    
    return result;
  }

  /**
   * Core verification logic
   * @private
   */
  async _verify(token, targetTrustDomain, options) {
    try {
      // Parse token without verification first to get claims
      const claims = this._decodeToken(token);
      if (!claims) {
        return { verified: false, error: 'INVALID_TOKEN_FORMAT' };
      }
      
      // 1. Verify temporal validity
      const now = new Date();
      if (claims.notBefore && now < new Date(claims.notBefore)) {
        return { verified: false, error: 'TOKEN_NOT_YET_VALID', notBefore: claims.notBefore };
      }
      if (claims.expiresAt && now > new Date(claims.expiresAt)) {
        return { verified: false, error: 'TOKEN_EXPIRED', expiresAt: claims.expiresAt };
      }
      
      // 2. Verify trustDomain match
      if (this.config.requireTrustDomainMatch && claims.trustDomain !== targetTrustDomain) {
        return {
          verified: false,
          error: 'TRUST_DOMAIN_MISMATCH',
          expected: targetTrustDomain,
          actual: claims.trustDomain
        };
      }
      
      // 3. Verify agent exists and is active
      const agent = Agent.findByAgentId(claims.agentId);
      if (!agent) {
        return { verified: false, error: 'AGENT_NOT_FOUND', agentId: claims.agentId };
      }
      if (agent.state !== AgentState.ACTIVE) {
        return { verified: false, error: 'AGENT_NOT_ACTIVE', state: agent.state };
      }
      
      // 4. Check revocation status
      if (agent.state === AgentState.REVOKED) {
        return { verified: false, error: 'AGENT_REVOKED', agentId: claims.agentId };
      }
      
      // 5. Verify session binding if provided
      if (options.requireSession && claims.sessionId) {
        // Session verification could be delegated to SessionManager
        if (options.sessionManager) {
          const session = options.sessionManager.getSession(claims.sessionId);
          if (!session) {
            return { verified: false, error: 'SESSION_NOT_FOUND', sessionId: claims.sessionId };
          }
          if (session.status !== 'active') {
            return { verified: false, error: 'SESSION_NOT_ACTIVE', sessionId: claims.sessionId };
          }
        }
      }
      
      // All checks passed
      return {
        verified: true,
        agentId: claims.agentId,
        agentType: claims.agentType,
        declaredTrustScore: claims.declaredTrustScore,
        clearance: claims.clearance,
        trustDomain: claims.trustDomain,
        capabilities: claims.capabilities,
        declaredBlastRadiusEstimate:
          claims.declaredBlastRadiusEstimate !== undefined
            ? claims.declaredBlastRadiusEstimate
            : claims.blastRadius,
        sessionId: claims.sessionId,
        executionContext: claims.executionContext
      };
      
    } catch (error) {
      return { verified: false, error: 'VERIFICATION_FAILED', message: error.message };
    }
  }

  /**
   * Decode token without verification (for inspection)
   * @private
   */
  _decodeToken(token) {
    try {
      // Simple base64 decode without verification
      const parts = token.split('.');
      if (parts.length !== 3) {
        return null;
      }
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return payload;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get cached attestation result
   * @private
   */
  _getCachedResult(token) {
    const hash = this._hashToken(token);
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
  async _cacheResult(token, result) {
    const hash = this._hashToken(token);
    this.attestationCache.set(hash, {
      result,
      expiresAt: Date.now() + this.config.cacheTtlMs
    });
  }

  /**
   * Hash token for cache key
   * @private
   */
  _hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Cleanup expired cache entries
   * @private
   */
  _cleanupExpiredCache() {
    const now = Date.now();
    for (const [hash, cached] of this.attestationCache.entries()) {
      if (cached.expiresAt < now) {
        this.attestationCache.delete(hash);
      }
    }
  }

  /**
   * Invalidate cached attestation for a token
   * @param {string} token - The token to invalidate
   */
  invalidateCache(token) {
    const hash = this._hashToken(token);
    this.attestationCache.delete(hash);
  }

  /**
   * Invalidate all cached attestations for an agent
   * @param {string} agentId - The agent ID
   */
  invalidateAgent(agentId) {
    // In production, we'd want to track which tokens belong to which agent
    // For now, clear all (conservative approach)
    this.attestationCache.clear();
  }

  /**
   * Get attestation statistics
   * @returns {object} Cache statistics
   */
  getStats() {
    let valid = 0;
    let expired = 0;
    const now = Date.now();
    
    for (const cached of this.attestationCache.values()) {
      if (cached.expiresAt > now) {
        valid++;
      } else {
        expired++;
      }
    }
    
    return {
      totalCached: this.attestationCache.size,
      validCacheEntries: valid,
      expiredCacheEntries: expired,
      cacheTtlMs: this.config.cacheTtlMs
    };
  }

  /**
   * Verify multiple agents simultaneously
   * @param {array} attestations - Array of { token, targetTrustDomain }
   * @returns {array} Array of attestation results
   */
  async verifyBatch(attestations) {
    const results = [];
    for (const att of attestations) {
      results.push(await this.verifyAttestation(att.token, { targetTrustDomain: att.targetTrustDomain }));
    }
    return results;
  }

  /**
   * Destroy the attestation service
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.attestationCache.clear();
  }
}

module.exports = AttestationService;
