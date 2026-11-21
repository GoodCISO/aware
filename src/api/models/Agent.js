// src/api/models/Agent.js
// Agent (Non-Human Identity) model for AWARE Phase 1.1

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Credential hashing configuration
const CREDENTIAL_HASH_ITERATIONS = 100000;
const CREDENTIAL_HASH_KEYLEN = 64;
const CREDENTIAL_HASH_DIGEST = 'sha512';
const CREDENTIAL_SALT_LEN = 32;

// M-01 FIX: No static fallback for pepper — derive from SECRET_KEY if not provided
const CREDENTIALPepper = process.env.AWARE_CREDENTIAL_PEPPER 
  || (process.env.SECRET_KEY 
    ? crypto.createHash('sha256').update(process.env.SECRET_KEY).digest('hex')
    : (() => { 
        console.error('FATAL: Either AWARE_CREDENTIAL_PEPPER or SECRET_KEY must be set'); 
        process.exit(1); 
      })()
    );

// Hash a credential using PBKDF2
function hashCredential(credential) {
  const salt = crypto.randomBytes(CREDENTIAL_SALT_LEN);
  const hash = crypto.pbkdf2Sync(
    credential + CREDENTIALPepper,
    salt,
    CREDENTIAL_HASH_ITERATIONS,
    CREDENTIAL_HASH_KEYLEN,
    CREDENTIAL_HASH_DIGEST
  );
  return salt.toString('hex') + ':' + hash.toString('hex');
}

// Verify a credential against a stored hash
function verifyCredential(credential, storedHash) {
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const salt = Buffer.from(parts[0], 'hex');
  const originalHash = parts[1];
  const hash = crypto.pbkdf2Sync(
    credential + CREDENTIALPepper,
    salt,
    CREDENTIAL_HASH_ITERATIONS,
    CREDENTIAL_HASH_KEYLEN,
    CREDENTIAL_HASH_DIGEST
  );
  return crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), hash);
}

// Define the path for the agents data file
const AGENTS_DATA_FILE = path.join(__dirname, '..', '..', 'data', 'agents.json');

// Ensure the data directory exists
const dataDir = path.dirname(AGENTS_DATA_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Create the agents file if it doesn't exist
if (!fs.existsSync(AGENTS_DATA_FILE)) {
  fs.writeFileSync(AGENTS_DATA_FILE, JSON.stringify({ agents: [] }, null, 2));
}

// Agent lifecycle states
const AgentState = {
  PENDING: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DECOMMISSIONED: 'decommissioned',
  REVOKED: 'revoked'
};

class Agent {
  constructor(agentData) {
    this.id = agentData.id || crypto.randomUUID();
    this.agentId = agentData.agentId; // e.g., "agent:coder:instance-7f3a"
    this.name = agentData.name || '';
    this.type = agentData.type || 'unknown'; // e.g., "coder", "researcher", "tester"
    this.model = agentData.model || 'unknown';
    this.version = agentData.version || '1.0.0';
    this.capabilities = agentData.capabilities || [];
    this.clearance = agentData.clearance || 'internal_only'; // e.g., "internal_only", "trusted", "elevated"
    this.trustScore = agentData.trustScore !== undefined ? agentData.trustScore : 0.5;
    this.state = agentData.state || AgentState.PENDING;
    this.credentials = agentData.credentials || {
      current: null,
      previous: null,
      rotatedAt: null
    };
    this.metadata = agentData.metadata || {};
    this.createdAt = agentData.createdAt || new Date().toISOString();
    this.updatedAt = agentData.updatedAt || new Date().toISOString();
    this.lastSeenAt = agentData.lastSeenAt || null;
    this.decommissionedAt = agentData.decommissionedAt || null;
  }

  // Generate a new credential for this agent
  generateCredential() {
    const rawCredential = crypto.randomBytes(32).toString('hex');
    const hashedCredential = hashCredential(rawCredential);
    const previous = this.credentials.current;
    
    this.credentials = {
      current: hashedCredential, // Store HASH, not plaintext
      previous: previous,
      rotatedAt: new Date().toISOString()
    };
    this.updatedAt = new Date().toISOString();
    
    return rawCredential; // Return raw for initial provisioning only
  }

  // Rotate credentials
  rotateCredentials() {
    return this.generateCredential();
  }

  // Verify a raw credential against stored hash
  static verifyCredential(rawCredential, storedHash) {
    return verifyCredential(rawCredential, storedHash);
  }

  // Check if raw credential matches stored hash
  checkCredential(rawCredential) {
    return verifyCredential(rawCredential, this.credentials.current);
  }

  // Update trust score
  updateTrustScore(newScore) {
    this.trustScore = Math.max(0, Math.min(1, newScore));
    this.updatedAt = new Date().toISOString();
  }

  // Transition state
  transitionTo(newState) {
    const validTransitions = {
      [AgentState.PENDING]: [AgentState.ACTIVE, AgentState.DECOMMISSIONED],
      [AgentState.ACTIVE]: [AgentState.SUSPENDED, AgentState.REVOKED, AgentState.DECOMMISSIONED],
      [AgentState.SUSPENDED]: [AgentState.ACTIVE, AgentState.REVOKED, AgentState.DECOMMISSIONED],
      [AgentState.REVOKED]: [AgentState.ACTIVE, AgentState.DECOMMISSIONED],
      [AgentState.DECOMMISSIONED]: []
    };

    const allowed = validTransitions[this.state] || [];
    if (!allowed.includes(newState)) {
      throw new Error(`Invalid state transition from ${this.state} to ${newState}`);
    }

    this.state = newState;
    this.updatedAt = new Date().toISOString();

    if (newState === AgentState.DECOMMISSIONED) {
      this.decommissionedAt = new Date().toISOString();
    }
  }

  // Touch last seen timestamp
  touch() {
    this.lastSeenAt = new Date().toISOString();
  }

  // Serialize for JSON storage
  toJSON() {
    return {
      id: this.id,
      agentId: this.agentId,
      name: this.name,
      type: this.type,
      model: this.model,
      version: this.version,
      capabilities: this.capabilities,
      clearance: this.clearance,
      trustScore: this.trustScore,
      state: this.state,
      credentials: this.credentials,
      metadata: this.metadata,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastSeenAt: this.lastSeenAt,
      decommissionedAt: this.decommissionedAt
    };
  }

  // Create a new agent
  static create(agentData) {
    const newAgent = new Agent({
      ...agentData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    
    // Generate initial credential
    newAgent.generateCredential();
    
    this.saveAgent(newAgent);
    return newAgent;
  }

  // Save agent to data file
  static saveAgent(agent) {
    const agentsData = JSON.parse(fs.readFileSync(AGENTS_DATA_FILE, 'utf8'));
    const index = agentsData.agents.findIndex(a => a.id === agent.id);
    
    if (index >= 0) {
      agentsData.agents[index] = agent.toJSON();
    } else {
      agentsData.agents.push(agent.toJSON());
    }
    
    fs.writeFileSync(AGENTS_DATA_FILE, JSON.stringify(agentsData, null, 2));
  }

  // Find agent by id
  static findById(id) {
    const agentsData = JSON.parse(fs.readFileSync(AGENTS_DATA_FILE, 'utf8'));
    const agentData = agentsData.agents.find(a => a.id === id);
    return agentData ? new Agent(agentData) : null;
  }

  // Find agent by agentId (e.g., "agent:coder:instance-7f3a")
  static findByAgentId(agentId) {
    const agentsData = JSON.parse(fs.readFileSync(AGENTS_DATA_FILE, 'utf8'));
    const agentData = agentsData.agents.find(a => a.agentId === agentId);
    return agentData ? new Agent(agentData) : null;
  }

  // Find all agents (optionally filter by state)
  static findAll(stateFilter = null) {
    const agentsData = JSON.parse(fs.readFileSync(AGENTS_DATA_FILE, 'utf8'));
    let agents = agentsData.agents.map(a => new Agent(a));
    
    if (stateFilter) {
      agents = agents.filter(a => a.state === stateFilter);
    }
    
    return agents;
  }

  // Update agent
  static update(id, updates) {
    const agent = this.findById(id);
    if (!agent) {
      return null;
    }

    // Apply updates (except id, createdAt)
    Object.assign(agent, {
      ...updates,
      id: agent.id,
      agentId: updates.agentId || agent.agentId,
      createdAt: agent.createdAt,
      updatedAt: new Date().toISOString()
    });

    this.saveAgent(agent);
    return agent;
  }

  // Delete agent (permanent removal)
  static delete(id) {
    const agentsData = JSON.parse(fs.readFileSync(AGENTS_DATA_FILE, 'utf8'));
    const index = agentsData.agents.findIndex(a => a.id === id);
    
    if (index < 0) {
      return false;
    }

    agentsData.agents.splice(index, 1);
    fs.writeFileSync(AGENTS_DATA_FILE, JSON.stringify(agentsData, null, 2));
    return true;
  }

  // Decommission agent (soft delete - transitions to DECOMMISSIONED state)
  static decommission(id) {
    const agent = this.findById(id);
    if (!agent) {
      return null;
    }

    agent.transitionTo(AgentState.DECOMMISSIONED);
    this.saveAgent(agent);
    return agent;
  }

  // Revoke agent (hard revoke - transitions to REVOKED state)
  static revoke(id, reason = 'manual') {
    const agent = this.findById(id);
    if (!agent) {
      return null;
    }

    agent.transitionTo(AgentState.REVOKED);
    agent.metadata = agent.metadata || {};
    agent.metadata.revocationReason = reason;
    this.saveAgent(agent);
    return agent;
  }
}

// Export both Agent class and AgentState enum
module.exports = { Agent, AgentState };
