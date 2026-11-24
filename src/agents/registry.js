// src/agents/registry.js
// Agent Registry Service - Central registry for all Non-Human Identities (NHIs)
// Phase 1.1: Agent Identity Layer

const { Agent, AgentState } = require('../api/models/Agent');
const crypto = require('crypto');

// M-03 FIX: Audit logging for agent lifecycle events
const auditLog = [];
const audit = (event, initiator, target, result, metadata = {}) => {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    initiator,
    target,
    result,
    metadata
  };
  auditLog.push(entry);
  // In production, this would also integrate with the AWARE alert system
  console.log(`[AUDIT] ${entry.timestamp} ${event} ${result} target=${target} initiator=${initiator}`);
  return entry;
};

// Get audit log (for testing/verification)
const getAuditLog = () => [...auditLog];

class AgentRegistry {
  constructor(config = {}) {
    this.config = {
      defaultClearance: config.defaultClearance || 'internal_only',
      defaultCapabilities: config.defaultCapabilities || [],
      ...config
    };
  }

  // Register a new agent (onboarding)
  register(agentData) {
    const agent = Agent.create({
      agentId: agentData.agentId,
      name: agentData.name,
      type: agentData.type,
      model: agentData.model,
      version: agentData.version,
      capabilities: agentData.capabilities || this.config.defaultCapabilities,
      clearance: agentData.clearance || this.config.defaultClearance,
      metadata: {
        ...agentData.metadata,
        registeredBy: agentData.registeredBy || 'system',
        registrationSource: agentData.registrationSource || 'api'
      },
      state: AgentState.ACTIVE
    });

    // M-03: Audit AGENT_REGISTERED
    audit('AGENT_REGISTERED', agentData.registeredBy || 'system', agent.agentId, 'SUCCESS', {
      type: agent.type,
      clearance: agent.clearance
    });

    return agent;
  }

  // Look up agent by agentId
  lookup(agentId) {
    return Agent.findByAgentId(agentId);
  }

  // Look up agent by internal ID
  lookupById(id) {
    return Agent.findById(id);
  }

  // List all agents (optionally filtered)
  list(filter = {}) {
    let agents = Agent.findAll(filter.state);
    
    if (filter.type) {
      agents = agents.filter(a => a.type === filter.type);
    }
    
    if (filter.clearance) {
      agents = agents.filter(a => a.clearance === filter.clearance);
    }
    
    return agents;
  }

  // Update agent capabilities
  updateCapabilities(id, capabilities) {
    const agent = Agent.findById(id);
    if (!agent) {
      return null;
    }
    
    return Agent.update(id, { capabilities });
  }

  // Update trust score
  updateTrustScore(id, newScore) {
    const agent = Agent.findById(id);
    if (!agent) {
      return null;
    }
    
    agent.updateTrustScore(newScore);
    Agent.saveAgent(agent);
    return agent;
  }

  // Record heartbeat for agent
  heartbeat(agentId) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }
    
    if (agent.state !== AgentState.ACTIVE) {
      return { success: false, error: `Agent not operational (state: ${agent.state})` };
    }
    
    agent.touch();
    Agent.saveAgent(agent);
    
    return { success: true, lastSeenAt: agent.lastSeenAt, declaredTrustScore: agent.declaredTrustScore };
  }

  // Revoke agent (kill switch)
  // Extended to support Raft consensus options (Phase 1.4 C-02)
  revoke(agentId, reason = 'manual', options = {}) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) {
      audit('AGENT_REVOKED', 'system', agentId, 'FAILURE', { error: 'Agent not found' });
      return { success: false, error: 'Agent not found' };
    }
    
    try {
      const revoked = Agent.revoke(agent.id, reason);
      
      // Store revocation metadata if provided
      if (options.revocationId) {
        revoked.revocationId = options.revocationId;
        Agent.saveAgent(revoked);
      }
      
      // Extended audit with Raft metadata
      audit('AGENT_REVOKED', options.issuedBy || 'system', agent.agentId, 'SUCCESS', { 
        reason,
        revocationId: options.revocationId,
        source: options.source || 'direct'
      });
      return { success: true, agent: revoked };
    } catch (error) {
      audit('AGENT_REVOKED', options.issuedBy || 'system', agent.agentId, 'FAILURE', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  // Check if agent is revoked (Phase 1.4)
  isRevoked(agentId) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) return false;
    return agent.state === AgentState.REVOKED;
  }

  // Get revocation ID for an agent (Phase 1.4)
  getRevocationId(agentId) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) return null;
    return agent.revocationId || null;
  }

  // Reinstate a revoked agent (Phase 1.4 M-03)
  reinstate(agentId, options = {}) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) {
      audit('AGENT_REINSTATED', options.issuedBy || 'system', agentId, 'FAILURE', { error: 'Agent not found' });
      return { success: false, error: 'Agent not found' };
    }
    
    if (agent.state !== AgentState.REVOKED) {
      return { success: false, error: 'Agent is not revoked' };
    }
    
    try {
      agent.transitionTo(AgentState.ACTIVE);
      delete agent.revocationId;
      Agent.saveAgent(agent);
      audit('AGENT_REINSTATED', options.issuedBy || 'system', agent.agentId, 'SUCCESS', {
        originalRevocationId: options.originalRevocationId
      });
      return { success: true, agent };
    } catch (error) {
      audit('AGENT_REINSTATED', options.issuedBy || 'system', agent.agentId, 'FAILURE', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  // Suspend agent
  suspend(agentId) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) {
      audit('AGENT_SUSPENDED', 'system', agentId, 'FAILURE', { error: 'Agent not found' });
      return { success: false, error: 'Agent not found' };
    }
    
    try {
      agent.transitionTo(AgentState.SUSPENDED);
      Agent.saveAgent(agent);
      audit('AGENT_SUSPENDED', 'system', agent.agentId, 'SUCCESS');
      return { success: true, agent };
    } catch (error) {
      audit('AGENT_SUSPENDED', 'system', agent.agentId, 'FAILURE', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  // Activate/reinstate agent
  activate(agentId) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) {
      audit('AGENT_ACTIVATED', 'system', agentId, 'FAILURE', { error: 'Agent not found' });
      return { success: false, error: 'Agent not found' };
    }
    
    try {
      agent.transitionTo(AgentState.ACTIVE);
      Agent.saveAgent(agent);
      audit('AGENT_ACTIVATED', 'system', agent.agentId, 'SUCCESS');
      return { success: true, agent };
    } catch (error) {
      audit('AGENT_ACTIVATED', 'system', agent.agentId, 'FAILURE', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  // Decommission agent
  decommission(agentId) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) {
      audit('AGENT_DECOMMISSIONED', 'system', agentId, 'FAILURE', { error: 'Agent not found' });
      return { success: false, error: 'Agent not found' };
    }
    
    const decommissioned = Agent.decommission(agent.id);
    audit('AGENT_DECOMMISSIONED', 'system', agent.agentId, 'SUCCESS');
    return { success: true, agent: decommissioned };
  }

  // Verify agent credentials
  verify(agentId, credential) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) {
      return { valid: false, error: 'Agent not found' };
    }
    
    const isValid = agent.checkCredential(credential);
    
    return {
      valid: isValid && agent.state === AgentState.ACTIVE,
      agentId: agent.agentId,
      state: agent.state,
      clearance: agent.clearance,
      capabilities: agent.capabilities
    };
  }

  // Rotate agent credentials
  rotateCredentials(agentId) {
    const agent = Agent.findByAgentId(agentId);
    if (!agent) {
      audit('CREDENTIAL_ROTATED', 'system', agentId, 'FAILURE', { error: 'Agent not found' });
      return { success: false, error: 'Agent not found' };
    }
    
    if (agent.state !== AgentState.ACTIVE) {
      audit('CREDENTIAL_ROTATED', 'system', agent.agentId, 'FAILURE', { error: `Cannot rotate for ${agent.state} agent` });
      return { success: false, error: `Cannot rotate credentials for agent in ${agent.state} state` };
    }
    
    const newCredential = agent.rotateCredentials();
    Agent.saveAgent(agent);
    audit('CREDENTIAL_ROTATED', 'system', agent.agentId, 'SUCCESS');
    
    return {
      success: true,
      agentId: agent.agentId,
      rotatedAt: agent.credentials.rotatedAt
    };
  }

  // Get operational agents (ACTIVE state only)
  getOperationalAgents() {
    return Agent.findAll(AgentState.ACTIVE);
  }

  // Get agents by type
  getAgentsByType(type) {
    return Agent.findAll().filter(a => a.type === type && a.state === AgentState.ACTIVE);
  }

  // Get trust scores for all agents
  getTrustScores() {
    const agents = Agent.findAll();
    return agents.map(a => ({
      agentId: a.agentId,
      type: a.type,
      declaredTrustScore: a.declaredTrustScore,
      state: a.state,
      lastSeenAt: a.lastSeenAt
    }));
  }
}

module.exports = AgentRegistry;
module.exports.getAuditLog = getAuditLog;
