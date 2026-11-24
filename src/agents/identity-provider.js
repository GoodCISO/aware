// src/agents/identity-provider.js
// Identity Provider for Non-Human Identities (NHIs)
// Issues and rotates short-lived JWTs for agents
// Phase 1.1: Agent Identity Layer

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const AgentRegistry = require('./registry');

// Default credential TTL: 1 hour
const DEFAULT_TTL_SECONDS = 3600;

class IdentityProvider {
  constructor(config = {}) {
    // CRITICAL: Secret key is required - no defaults allowed
    if (!config.secretKey) {
      throw new Error('FATAL: identity-provider requires config.secretKey. No default value allowed.');
    }
    this.secretKey = config.secretKey;
    this.issuer = config.issuer || 'aware-ca';
    this.ttlSeconds = config.ttlSeconds || DEFAULT_TTL_SECONDS;
    this.registry = new AgentRegistry(config.registryConfig);
    
    // Cache for issued tokens (agentId -> { token, expiresAt })
    this.tokenCache = new Map();
    
    // Cleanup interval (runs every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanupExpiredTokens(), 5 * 60 * 1000);
  }

  // Clean up expired tokens from cache
  cleanupExpiredTokens() {
    const now = Date.now();
    for (const [agentId, tokenData] of this.tokenCache.entries()) {
      if (tokenData.expiresAt < now) {
        this.tokenCache.delete(agentId);
      }
    }
  }

  // Destroy the identity provider (cleanup)
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  // Issue a new JWT for an agent
  issueToken(agentId, options = {}) {
    const agent = this.registry.lookup(agentId);
    
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    
    if (agent.state !== 'active') {
      throw new Error(`Cannot issue token for agent in ${agent.state} state`);
    }
    
    // Verify credential if provided
    if (options.credential) {
      const verification = this.registry.verify(agentId, options.credential);
      if (!verification.valid) {
        throw new Error('Invalid agent credentials');
      }
    }
    
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (options.ttlSeconds || this.ttlSeconds);
    
    // Build JWT claims
    const payload = {
      sub: agent.agentId,
      iss: this.issuer,
      type: 'agent',
      agentId: agent.agentId,
      name: agent.name,
      agentType: agent.type,
      capabilities: agent.capabilities,
      clearance: agent.clearance,
      declaredTrustScore: agent.declaredTrustScore,
      validUntil: new Date(expiresAt * 1000).toISOString(),
      rotatedFrom: agent.credentials.previous || null,
      iat: now,
      exp: expiresAt
    };
    
    // Sign the token
    const token = jwt.sign(payload, this.secretKey, {
      algorithm: 'HS256',
      keyid: agent.id
    });
    
    // Cache the token
    this.tokenCache.set(agentId, {
      token,
      expiresAt: expiresAt * 1000,
      payload
    });
    
    return {
      token,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      expiresInSeconds: expiresAt - now
    };
  }

  // Verify a JWT token
  verifyToken(token) {
    try {
      const decoded = jwt.verify(token, this.secretKey, {
        algorithms: ['HS256']
      });
      
      // Verify agent still exists and is active
      const agent = this.registry.lookup(decoded.agentId);
      if (!agent) {
        return { valid: false, error: 'Agent not found' };
      }
      
      if (agent.state !== 'active') {
        return { valid: false, error: `Agent not operational (state: ${agent.state})` };
      }
      
      // Check if credential has rotated since token was issued.
      //
      // The token's `rotatedFrom` claim carries the credential hash that was
      // current when the token was minted (src/agents/identity-provider.js:83
      // sets it from `agent.credentials.previous`). If the agent's CURRENT
      // credential differs from that hash, the credential has been rotated
      // since this token was issued, and the token must be rejected.
      //
      // The previous form of this guard was:
      //
      //   if (decoded.rotatedFrom && agent.credentials.current !== decoded.rotatedFrom && !decoded.rotatedFrom)
      //
      // whose third conjunct is false whenever `decoded.rotatedFrom` is
      // truthy — so the conjunction was never satisfiable and the
      // rotation-rejection branch was unreachable. A stale token survived a
      // rotation indefinitely.
      //
      // The check below is the reachable equivalent: the claim is present AND
      // the current credential differs from it.
      if (decoded.rotatedFrom && agent.credentials.current !== decoded.rotatedFrom) {
        // Credential was rotated after this token was issued.
        // Allow if the token was issued before the rotation.
        const rotatedAt = agent.credentials.rotatedAt ? new Date(agent.credentials.rotatedAt).getTime() : 0;
        const issuedAt = decoded.iat * 1000;
        if (rotatedAt > issuedAt) {
          return { valid: false, error: 'Credential rotation detected' };
        }
      }
      
      return {
        valid: true,
        agent: {
          agentId: decoded.agentId,
          name: decoded.name,
          type: decoded.agentType,
          capabilities: decoded.capabilities,
          clearance: decoded.clearance,
          // Back-compat: tokens issued before the rename carry `trustScore`.
          // Prefer the new claim, fall back to the legacy one so in-flight
          // tokens keep verifying across the rename.
          declaredTrustScore:
            decoded.declaredTrustScore !== undefined
              ? decoded.declaredTrustScore
              : decoded.trustScore
        },
        claims: decoded
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // Refresh a token (issue new token with extended expiry)
  refreshToken(oldToken) {
    const verification = this.verifyToken(oldToken);
    
    if (!verification.valid) {
      throw new Error(`Cannot refresh invalid token: ${verification.error}`);
    }
    
    // Issue new token with fresh expiry
    return this.issueToken(verification.claims.agentId);
  }

  // Rotate agent credentials and invalidate existing tokens
  rotateCredentials(agentId) {
    const result = this.registry.rotateCredentials(agentId);
    
    if (!result.success) {
      throw new Error(result.error);
    }
    
    // Invalidate cached token for this agent
    this.tokenCache.delete(agentId);
    
    // Issue new token with new credential
    return this.issueToken(agentId);
  }

  // Revoke an agent's tokens (by revoking their credentials)
  revokeAgent(agentId, reason = 'manual') {
    const result = this.registry.revoke(agentId, reason);
    
    if (!result.success) {
      throw new Error(result.error);
    }
    
    // Invalidate cached token
    this.tokenCache.delete(agentId);
    
    return {
      success: true,
      agentId,
      state: result.agent.state
    };
  }

  // Get token info without verifying (for debugging)
  inspectToken(token) {
    try {
      const decoded = jwt.decode(token);
      return {
        valid: true,
        claims: decoded,
        expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null,
        issuedAt: decoded.iat ? new Date(decoded.iat * 1000).toISOString() : null
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  // Middleware factory for Express routes
  authenticateAgent(options = {}) {
    return (req, res, next) => {
      const authHeader = req.headers.authorization;
      
      if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
      }
      
      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({ error: 'Invalid authorization format. Use: Bearer <token>' });
      }
      
      const token = parts[1];
      const verification = this.verifyToken(token);
      
      if (!verification.valid) {
        return res.status(401).json({ error: verification.error });
      }
      
      // Attach agent info to request
      req.agent = verification.agent;
      req.agentCredentials = verification.claims;
      
      // Optional: Check clearance level
      if (options.requiredClearance && verification.agent.clearance !== options.requiredClearance) {
        // Check if agent has equal or higher clearance
        const clearanceLevels = ['internal_only', 'trusted', 'elevated'];
        const requiredLevel = clearanceLevels.indexOf(options.requiredClearance);
        const agentLevel = clearanceLevels.indexOf(verification.agent.clearance);
        
        if (agentLevel < requiredLevel) {
          return res.status(403).json({ error: 'Insufficient clearance level' });
        }
      }
      
      next();
    };
  }
}

module.exports = IdentityProvider;
