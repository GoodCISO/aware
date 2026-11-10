// src/kill-switch/revocation-service.js
// Phase 1.4: Kill Switch — Core revocation orchestration via Raft consensus
// C-02: Revocations MUST achieve Raft consensus before execution

const EventEmitter = require('events');
const { RevocationEntry, ReinstatementEntry, EntryType } = require('../election/revocation-entry');

/**
 * RevocationService — orchestrates distributed agent revocation via Raft consensus
 * 
 * Key invariant (C-02): Revocation is executed ONLY after commitIndex >= entry.index
 * confirmed by majority of nodes. Leader MUST NOT apply revocation locally before consensus.
 */
class RevocationService extends EventEmitter {
  /**
   * @param {Object} deps
   * @param {ElectionManager} deps.electionManager - Raft election manager
   * @param {StateMachine} deps.stateMachine - Raft state machine
   * @param {AgentRegistry} deps.registry - Agent registry
   * @param {Object} deps.config
   */
  constructor(deps) {
    super();
    this.electionManager = deps.electionManager;
    this.stateMachine = deps.stateMachine;
    this.registry = deps.registry;
    this.config = deps.config || {};

    // Wiring guard (t_8c8cbf64). The kill switch used to be constructed with
    // `stateMachine: undefined, registry: undefined`, so initiateRevocation
    // threw a TypeError on an undefined property and the route answered
    // HTTP 500 - the kill switch was inert. A missing dependency is a
    // CONFIGURATION error, not a crash: record what is missing and let every
    // entry point answer with a structured failure instead.
    this.missingDependencies = ['electionManager', 'stateMachine', 'registry']
      .filter((dep) => !this[dep]);
    
    // Track pending revocations awaiting consensus
    this.pendingRevocations = new Map(); // idempotencyKey -> { entry, resolve, reject }
    
    // Track committed revocations for idempotency
    this.committedRevocations = new Set(); // ids of committed revocations
  }

  /**
   * True when every dependency the revocation path needs is wired.
   * The kill switch degrades to a structured error (not a crash) while this
   * is false - see the constructor's wiring guard.
   */
  isReady() {
    return this.missingDependencies.length === 0;
  }

  /**
   * Initiate a revocation — appends RevocationEntry to Raft log
   * C-02: Waits for majority quorum before execution
   * 
   * @param {string} agentId - Agent to revoke
   * @param {string} reason - 'security_breach' | 'policy_violation' | 'manual'
   * @param {string} issuedBy - Admin identity
   * @returns {Promise<{success: boolean, entry: RevocationEntry}>}
   */
  async initiateRevocation(agentId, reason, issuedBy) {
    // Wiring guard: refuse cleanly instead of throwing on an undefined
    // dependency (the t_8c8cbf64 failure mode).
    if (!this.isReady()) {
      return {
        success: false,
        error: 'NOT_CONFIGURED',
        missing: this.missingDependencies,
        message: `Kill switch is not wired: missing ${this.missingDependencies.join(', ')}`
      };
    }

    // C-02: Only leader can initiate revocations
    if (!this.electionManager.isLeader()) {
      const leaderId = this.electionManager.getLeader();
      return {
        success: false,
        error: 'NOT_LEADER',
        redirect: leaderId,
        message: `Revocation must be initiated by leader. Current leader: ${leaderId || 'unknown'}`
      };
    }

    // Create revocation entry
    const entry = new RevocationEntry(agentId, reason, issuedBy);
    
    // Check idempotency — if already committed, return success
    if (this.committedRevocations.has(entry.id)) {
      return { success: true, entry, idempotent: true };
    }

    // Check if already pending
    if (this.pendingRevocations.has(entry.id)) {
      return { success: true, entry, idempotent: true, pending: true };
    }

    // Create promise that resolves when consensus is reached
    const revocationPromise = new Promise((resolve, reject) => {
      this.pendingRevocations.set(entry.id, { entry, resolve, reject });
    });

    try {
      // C-02: Append to Raft log and wait for majority acknowledgment
      const logEntry = this.stateMachine.addRevocationEntry(entry);
      
      // Propagate to followers via heartbeat
      // The heartbeat will carry this entry in its entries array
      this.electionManager.proposeRevocation(logEntry);
      
      // Wait for commit acknowledgment from majority
      const result = await this.waitForCommit(logEntry);
      
      if (result.committed) {
        // Mark as committed
        this.committedRevocations.add(entry.id);
        this.pendingRevocations.delete(entry.id);
        
        // Apply to local state machine
        this.applyRevocation(entry);
        
        return { success: true, entry, committed: true };
      } else {
        this.pendingRevocations.delete(entry.id);
        return { success: false, error: 'CONSENSUS_NOT_REACHED', entry };
      }
    } catch (error) {
      this.pendingRevocations.delete(entry.id);
      return { success: false, error: error.message, entry };
    }
  }

  /**
   * Wait for revocation to be committed by majority
   * C-02: Revieweral — must wait for commitIndex >= entry.index
   */
  async waitForCommit(logEntry) {
    return new Promise((resolve) => {
      const checkInterval = 10; // ms
      
      const check = () => {
        const commitIndex = this.stateMachine.commitIndex;
        
        if (commitIndex >= logEntry.index) {
          resolve({ committed: true, commitIndex });
        } else if (!this.electionManager.isLeader()) {
          // Lost leadership during consensus
          resolve({ committed: false, reason: 'LOST_LEADERSHIP' });
        } else {
          setTimeout(check, checkInterval);
        }
      };
      
      // Start checking
      setTimeout(check, checkInterval);
    });
  }

  /**
   * Apply revocation to local state machine
   * C-02: Called ONLY after majority quorum is confirmed
   */
  applyRevocation(entry) {
    console.log(`[REVOCATION] Applying revocation: ${entry}`);
    
    // Apply to agent registry
    const result = this.registry.revoke(entry.agentId, entry.reason, {
      issuedBy: entry.issuedBy,
      revocationId: entry.id,
      source: 'raft_consensus'
    });
    
    if (result.success) {
      // Emit event for task reassignment
      this.emit('agentRevoked', {
        agentId: entry.agentId,
        reason: entry.reason,
        issuedBy: entry.issuedBy,
        timestamp: entry.issuedAt
      });
    }
    
    return result;
  }

  /**
   * Handle revocation entry received via heartbeat (follower side)
   * C-02: Followers apply revocation after receiving committed entry
   */
  handleRevocationEntry(logEntry) {
    // Check idempotency
    if (this.committedRevocations.has(logEntry.id)) {
      return { applied: false, reason: 'ALREADY_APPLIED', id: logEntry.id };
    }
    
    // Apply to local state machine
    const entry = new RevocationEntry(logEntry.agentId, logEntry.reason, logEntry.issuedBy, logEntry.issuedAt);
    entry.id = logEntry.id;
    
    const result = this.applyRevocation(entry);
    this.committedRevocations.add(logEntry.id);
    
    return { applied: true, id: logEntry.id, result };
  }

  /**
   * Reinstate a previously revoked agent (rollback mechanism)
   * M-03: Revocation rollback
   */
  async reinstate(agentId, reason, issuedBy, originalRevocationId) {
    // Wiring guard: refuse cleanly instead of throwing on an undefined
    // dependency (the t_8c8cbf64 failure mode).
    if (!this.isReady()) {
      return {
        success: false,
        error: 'NOT_CONFIGURED',
        missing: this.missingDependencies,
        message: `Kill switch is not wired: missing ${this.missingDependencies.join(', ')}`
      };
    }

    if (!this.electionManager.isLeader()) {
      const leaderId = this.electionManager.getLeader();
      return {
        success: false,
        error: 'NOT_LEADER',
        redirect: leaderId
      };
    }
    
    // Create reinstatement entry
    const entry = new ReinstatementEntry(agentId, reason, issuedBy, originalRevocationId);
    
    // Add to Raft log and wait for commit
    const logEntry = this.stateMachine.addReinstatementEntry(entry);
    this.electionManager.proposeRevocation(logEntry);
    
    // Wait for commit
    const result = await this.waitForCommit(logEntry);
    
    if (result.committed) {
      this.applyReinstatement(entry);
      return { success: true, entry };
    }
    
    return { success: false, error: 'CONSENSUS_NOT_REACHED' };
  }

  /**
   * Apply reinstatement to local registry
   */
  applyReinstatement(entry) {
    console.log(`[REVOCATION] Applying reinstatement: ${entry}`);
    return this.registry.reinstate(entry.agentId, {
      issuedBy: entry.issuedBy,
      originalRevocationId: entry.originalRevocationId,
      source: 'raft_consensus'
    });
  }

  /**
   * Check if an agent is currently revoked
   */
  isRevoked(agentId) {
    if (!this.registry) return false;
    return this.registry.isRevoked(agentId);
  }

  /**
   * Get revocation status for an agent
   */
  getRevocationStatus(agentId) {
    return {
      revoked: this.isRevoked(agentId),
      revocationId: this.registry ? this.registry.getRevocationId(agentId) : null
    };
  }

  /**
   * Get count of committed revocations (for metrics)
   */
  getCommittedRevocationCount() {
    return this.committedRevocations.size;
  }
}

module.exports = RevocationService;
