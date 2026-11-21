// src/policies/store.js
// Policy Store — CRUD operations for policies, loaded from policies.json
// Phase 1.2: Per-Agent Sandbox Policies

const fs = require('fs');
const path = require('path');
const { createPolicy, validatePolicy, generatePolicyId } = require('./model');

/**
 * Default policy store configuration
 */
const DEFAULT_CONFIG = {
  storePath: path.join(__dirname, '../../data/policies.json'),
  backupPath: path.join(__dirname, '../../data/policies.backup.json'),
  maxPolicies: 10000,
  autoBackup: true,
  backupIntervalMs: 5 * 60 * 1000 // 5 minutes
};

class PolicyStore {
  /**
   * @param {Object} config - Configuration
   * @param {string} config.storePath - Path to policies.json
   * @param {string} config.backupPath - Path for backups
   * @param {number} config.maxPolicies - Maximum number of policies
   * @param {boolean} config.autoBackup - Whether to auto-backup
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.policies = new Map();
    this.policyIndex = new Map(); // agentId -> policyId[]
    this.backupTimer = null;
    
    // Load policies on initialization
    this._load();
    
    // Start auto-backup if enabled
    if (this.config.autoBackup) {
      this._startAutoBackup();
    }
  }

  /**
   * Load policies from file
   * @private
   */
  _load() {
    try {
      if (fs.existsSync(this.config.storePath)) {
        const data = fs.readFileSync(this.config.storePath, 'utf8');
        const parsed = JSON.parse(data);
        
        if (parsed.policies && Array.isArray(parsed.policies)) {
          for (const policyData of parsed.policies) {
            try {
              const policy = createPolicy(policyData);
              this._addToMemory(policy);
            } catch (error) {
              console.error(`[POLICY_STORE] Failed to load policy ${policyData.policyId}: ${error.message}`);
            }
          }
        }
        
        console.log(`[POLICY_STORE] Loaded ${this.policies.size} policies`);
      } else {
        console.log('[POLICY_STORE] No policies file found, starting fresh');
      }
    } catch (error) {
      console.error(`[POLICY_STORE] Failed to load policies: ${error.message}`);
    }
  }

  /**
   * Save policies to file
   * @private
   */
  _save() {
    try {
      const dir = path.dirname(this.config.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const policiesArray = Array.from(this.policies.values());
      const data = {
        version: '1.0',
        updatedAt: new Date().toISOString(),
        policyCount: policiesArray.length,
        policies: policiesArray
      };
      
      fs.writeFileSync(this.config.storePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(`[POLICY_STORE] Failed to save policies: ${error.message}`);
    }
  }

  /**
   * Add policy to in-memory store
   * @private
   */
  _addToMemory(policy) {
    this.policies.set(policy.policyId, policy);
    
    // Update index
    if (!this.policyIndex.has(policy.agentId)) {
      this.policyIndex.set(policy.agentId, []);
    }
    this.policyIndex.get(policy.agentId).push(policy.policyId);
  }

  /**
   * Remove policy from in-memory store
   * @private
   */
  _removeFromMemory(policyId) {
    const policy = this.policies.get(policyId);
    if (policy) {
      this.policies.delete(policyId);
      
      // Update index
      const agentPolicies = this.policyIndex.get(policy.agentId);
      if (agentPolicies) {
        const idx = agentPolicies.indexOf(policyId);
        if (idx !== -1) {
          agentPolicies.splice(idx, 1);
        }
        if (agentPolicies.length === 0) {
          this.policyIndex.delete(policy.agentId);
        }
      }
    }
  }

  /**
   * Start auto-backup timer
   * @private
   */
  _startAutoBackup() {
    this.backupTimer = setInterval(() => {
      this._backup();
    }, this.config.backupIntervalMs);

    // unref(): a periodic file-backup timer must not keep the process alive.
    // Without this, any process that constructs a PolicyEngine (including
    // every unit test) holds the event loop open until the timer is
    // explicitly cleared, so the process never exits on its own.
    //
    // The timer still fires normally while the process is alive for other
    // reasons. unref only removes it from the set of handles that keep the
    // loop running.
    //
    // Found while adding the extension contract test: the suite reported
    // "Promise resolution is still pending but the event loop has already
    // resolved" and ran for 139 seconds.
    if (this.backupTimer && typeof this.backupTimer.unref === 'function') {
      this.backupTimer.unref();
    }
  }

  /**
   * Create backup
   * @private
   */
  _backup() {
    try {
      if (fs.existsSync(this.config.storePath)) {
        const dir = path.dirname(this.config.backupPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.copyFileSync(this.config.storePath, this.config.backupPath);
      }
    } catch (error) {
      console.error(`[POLICY_STORE] Backup failed: ${error.message}`);
    }
  }

  /**
   * Stop auto-backup timer
   */
  stop() {
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }

  /**
   * Create a new policy
   * @param {Object} policyData - Policy data
   * @returns {Object} Created policy
   */
  create(policyData) {
    // Check max policies limit
    if (this.policies.size >= this.config.maxPolicies) {
      throw new Error(`Policy store full (max ${this.config.maxPolicies})`);
    }
    
    const policy = createPolicy(policyData);
    this._addToMemory(policy);
    this._save();
    
    return policy;
  }

  /**
   * Get a policy by ID
   * @param {string} policyId - Policy ID
   * @returns {Object|null} Policy or null
   */
  get(policyId) {
    return this.policies.get(policyId) || null;
  }

  /**
   * Update a policy
   * @param {string} policyId - Policy ID
   * @param {Object} updates - Fields to update
   * @returns {Object|null} Updated policy or null
   */
  update(policyId, updates) {
    const policy = this.policies.get(policyId);
    if (!policy) {
      return null;
    }
    
    // Validate updates
    const updatedPolicy = {
      ...policy,
      ...updates,
      policyId: policy.policyId, // Don't allow changing policyId
      createdAt: policy.createdAt, // Don't allow changing createdAt
      updatedAt: new Date().toISOString()
    };
    
    // Remove old version
    this._removeFromMemory(policyId);
    
    // Validate new version
    const errors = validatePolicy(updatedPolicy);
    if (errors.length > 0) {
      // Restore old policy
      this._addToMemory(policy);
      throw new Error(`Invalid policy updates: ${errors.join(', ')}`);
    }
    
    // Add updated policy
    this._addToMemory(updatedPolicy);
    this._save();
    
    return updatedPolicy;
  }

  /**
   * Delete a policy
   * @param {string} policyId - Policy ID
   * @returns {boolean} Whether policy was deleted
   */
  delete(policyId) {
    const policy = this.policies.get(policyId);
    if (!policy) {
      return false;
    }
    
    this._removeFromMemory(policyId);
    this._save();
    
    return true;
  }

  /**
   * List policies for an agent
   * @param {string} agentId - Agent ID
   * @param {Object} filter - Optional filters
   * @returns {Array} Array of policies
   */
  listForAgent(agentId, filter = {}) {
    const policyIds = this.policyIndex.get(agentId) || [];
    let policies = policyIds
      .map(id => this.policies.get(id))
      .filter(p => p !== undefined);
    
    // Apply filters
    if (filter.tool) {
      policies = policies.filter(p => p.tool === filter.tool);
    }
    
    if (filter.action) {
      policies = policies.filter(p => p.action === filter.action);
    }
    
    if (filter.enabled !== undefined) {
      policies = policies.filter(p => p.enabled === filter.enabled);
    }
    
    // Sort by priority (descending)
    policies.sort((a, b) => b.priority - a.priority);
    
    return policies;
  }

  /**
   * Find policies matching a tool for an agent
   * @param {string} agentId - Agent ID
   * @param {string} tool - Tool name
   * @returns {Array} Matching policies sorted by priority
   */
  findForTool(agentId, tool) {
    const policies = this.listForAgent(agentId);
    
    // Filter to matching policies (including wildcard '*')
    return policies.filter(p => 
      p.enabled && 
      (p.tool === tool || p.tool === '*')
    );
  }

  /**
   * Get all policies (for admin purposes)
   * @returns {Array} All policies
   */
  listAll() {
    return Array.from(this.policies.values());
  }

  /**
   * Get policy count
   * @returns {number}
   */
  count() {
    return this.policies.size;
  }

  /**
   * Enable a policy
   * @param {string} policyId - Policy ID
   * @returns {Object|null} Updated policy or null
   */
  enable(policyId) {
    return this.update(policyId, { enabled: true });
  }

  /**
   * Disable a policy
   * @param {string} policyId - Policy ID
   * @returns {Object|null} Updated policy or null
   */
  disable(policyId) {
    return this.update(policyId, { enabled: false });
  }

  /**
   * Delete all policies for an agent
   * @param {string} agentId - Agent ID
   * @returns {number} Number of policies deleted
   */
  deleteForAgent(agentId) {
    const policyIds = [...(this.policyIndex.get(agentId) || [])];
    let deleted = 0;
    
    for (const policyId of policyIds) {
      if (this.delete(policyId)) {
        deleted++;
      }
    }
    
    return deleted;
  }

  /**
   * Bulk create policies
   * @param {Array} policiesData - Array of policy data
   * @returns {Array} Created policies
   */
  bulkCreate(policiesData) {
    const created = [];
    
    for (const policyData of policiesData) {
      try {
        const policy = this.create(policyData);
        created.push(policy);
      } catch (error) {
        console.error(`[POLICY_STORE] Bulk create failed for ${JSON.stringify(policyData)}: ${error.message}`);
      }
    }
    
    return created;
  }

  /**
   * Get store statistics
   * @returns {Object} Statistics
   */
  getStats() {
    const agentCounts = new Map();
    
    for (const policy of this.policies.values()) {
      agentCounts.set(policy.agentId, (agentCounts.get(policy.agentId) || 0) + 1);
    }
    
    return {
      totalPolicies: this.policies.size,
      totalAgents: agentCounts.size,
      enabledPolicies: Array.from(this.policies.values()).filter(p => p.enabled).length,
      disabledPolicies: Array.from(this.policies.values()).filter(p => !p.enabled).length,
      topAgents: Array.from(agentCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([agentId, count]) => ({ agentId, policyCount: count })),
      updatedAt: new Date().toISOString()
    };
  }
}

// Singleton instance
let policyStoreInstance = null;

/**
 * Get or create the policy store singleton
 * @param {Object} config - Configuration
 * @returns {PolicyStore}
 */
function getPolicyStore(config = {}) {
  if (!policyStoreInstance) {
    policyStoreInstance = new PolicyStore(config);
  }
  return policyStoreInstance;
}

module.exports = {
  PolicyStore,
  getPolicyStore,
  DEFAULT_CONFIG
};
