// src/election/index.js
// Simple implementation of leader election using Raft-inspired algorithm

// C-03 FIX: Static registry for simulation — maps nodeId -> ElectionManager instance
// In real Raft, this would be RPC calls. For simulation, nodes call each other directly.
const crypto = require('crypto');
ElectionManager.registry = {};

class ElectionManager {
  constructor(nodeId, config = {}) {
    this.nodeId = nodeId;
    this.nodes = config.nodes || []; // List of node IDs in the cluster
    this.state = 'follower'; // 'follower', 'candidate', 'leader'
    this.currentTerm = 0;
    this.votedFor = null;
    // Raft log ownership (t_8c8cbf64).
    // When a StateMachine is injected, this instance DELEGATES its log,
    // commitIndex and term to it, so a node has exactly ONE Raft log. The
    // kill-switch path (RevocationService) appends revocation entries
    // through the StateMachine and reads commitIndex back from it; a second
    // private log here would disagree with the StateMachine about what is
    // committed. Without an injected StateMachine the instance keeps its
    // own (empty) fields, exactly as before.
    this.stateMachine = config.stateMachine || null;
    this._log = [];
    this._commitIndex = 0;
    this._lastApplied = 0;
    this._term = 0;
    this.nextIndex = {};
    this.matchIndex = {};
    this.leaderId = null;
    this.timeout = null;
    this.electionTimeout = null;
    this.heartbeatTimeout = null;
    
    // Initialize nextIndex and matchIndex for each node
    this.nodes.forEach(nodeId => {
      this.nextIndex[nodeId] = 0;
      this.matchIndex[nodeId] = 0;
    });
    
    // C-03 FIX: Register this instance in the static registry for simulation
    ElectionManager.registry[this.nodeId] = this;
    
    this.startElectionTimer();
  }

  // Raft log / term accessors. These are getters (not plain fields) because
  // the StateMachine owns the log when one is injected - see the comment in
  // the constructor.
  get log() {
    return this.stateMachine ? this.stateMachine.log : this._log;
  }

  get commitIndex() {
    return this.stateMachine ? this.stateMachine.commitIndex : this._commitIndex;
  }

  get lastApplied() {
    return this.stateMachine ? this.stateMachine.lastApplied : this._lastApplied;
  }

  get currentTerm() {
    return this.stateMachine ? this.stateMachine.term : this._term;
  }

  set currentTerm(term) {
    if (this.stateMachine) {
      this.stateMachine.term = term;
    } else {
      this._term = term;
    }
  }

  // Start the election timer (randomized timeout to prevent conflicts)
  startElectionTimer() {
    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
    }
    
    // Random timeout between 300-600ms for testing, normally 150-300ms
    const timeout = Math.floor(crypto.randomInt(0, 300)) + 300;
    
    this.electionTimeout = setTimeout(() => {
      if (this.state !== 'leader') {
        this.startElection();
      }
    }, timeout);
  }

  // Start an election
  startElection() {
    console.log(`Node ${this.nodeId} starting election for term ${this.currentTerm + 1}`);
    
    this.state = 'candidate';
    this.syncStateMachineRole('candidate');
    this.currentTerm++;
    this.votedFor = this.nodeId;
    let votes = 1; // Vote for self
    
    console.log(`Node ${this.nodeId} requesting votes for term ${this.currentTerm}`);
    
    // Request votes from all other nodes
    this.nodes.forEach(nodeId => {
      if (nodeId !== this.nodeId) {
        this.requestVote(nodeId, (result) => {
          if (result && this.state === 'candidate') {
            votes++;
            console.log(`Node ${this.nodeId} received vote, total: ${votes}`);
            
            // Check if we have majority
            if (votes > Math.floor(this.nodes.length / 2)) {
              this.becomeLeader();
            }
          }
        });
      }
    });
    
    // Restart election timer
    this.startElectionTimer();
  }

  // Request vote from another node (candidate side)
  // C-03 FIX: Proper Raft vote request with term and log info
  requestVote(nodeId, callback) {
    console.log(`Requesting vote from node ${nodeId}, term ${this.currentTerm}`);
    
    // Get last log info to include in vote request
    const lastLogIndex = this.log.length - 1;
    const lastLogTerm = lastLogIndex >= 0 ? this.log[lastLogIndex].term : 0;
    
    // Simulate network request to other node
    setTimeout(() => {
      // C-03 FIX: Actually call the remote node's requestVote handler
      // In real Raft, this would be an RPC call
      // For simulation, nodes are in the same process and can call each other directly
      const remote = ElectionManager.registry[nodeId];
      
      if (!remote) {
        // Remote node not found in registry — deny vote (node may have been removed)
        console.log(`[RPC] Node ${nodeId} not found in registry, denying vote`);
        callback(false);
        return;
      }
      
      // Call the remote node's requestVote handler with proper Raft RPC parameters
      // This invokes the proper vote granting logic in ElectionManager.requestVote()
      remote.requestVote(this.nodeId, this.currentTerm, lastLogIndex, lastLogTerm)
        .then((result) => {
          console.log(`[RPC] Vote from ${nodeId}: granted=${result.granted}`);
          callback(result.granted);
        })
        .catch((err) => {
          console.error(`[RPC] Error requesting vote from ${nodeId}:`, err.message);
          callback(false);
        });
    }, crypto.randomInt(0, 100)); // Random network delay (SC-HIGH-005)
  }

  // Become the leader
  becomeLeader() {
    console.log(`Node ${this.nodeId} becoming leader for term ${this.currentTerm}`);
    
    this.state = 'leader';
    this.leaderId = this.nodeId;
    this.syncStateMachineRole('leader');
    
    // Initialize nextIndex and matchIndex for each node
    this.nodes.forEach(nodeId => {
      if (nodeId !== this.nodeId) {
        this.nextIndex[nodeId] = this.log.length;
        this.matchIndex[nodeId] = 0;
      }
    });
    
    // Start sending heartbeats
    this.sendHeartbeats();
  }

  // Send heartbeats to maintain leadership
  sendHeartbeats() {
    if (this.state !== 'leader') return;
    
    console.log(`Leader ${this.nodeId} sending heartbeat`);
    
    // Send AppendEntries RPCs to all other nodes
    this.nodes.forEach(nodeId => {
      if (nodeId !== this.nodeId) {
        this.sendHeartbeatToNode(nodeId);
      }
    });
    
    // Schedule next heartbeat in 100ms
    this.heartbeatTimeout = setTimeout(() => {
      this.sendHeartbeats();
    }, 100);
  }

  // Send heartbeat to a specific node
  sendHeartbeatToNode(nodeId) {
    // Simulate sending heartbeat to another node
    console.log(`Sending heartbeat to node ${nodeId}`);
    
    // In a real implementation, this would be an RPC call
  }

  // Handle incoming vote requests from other nodes
  handleRequestVote(term, candidateId, lastLogIndex, lastLogTerm) {
    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.state = 'follower';
      this.leaderId = null;
      this.startElectionTimer();
    }
    
    if (this.state !== 'leader' && 
        (this.votedFor === null || this.votedFor === candidateId) && 
        this.isLogUpToDate(lastLogIndex, lastLogTerm)) {
      this.votedFor = candidateId;
      console.log(`Node ${this.nodeId} voted for ${candidateId}`);
      return true;
    }
    
    return false;
  }

  // Check if candidate's log is at least as up-to-date as voter's
  // C-03 FIX: Proper Raft log up-to-date check
  // Per Raft paper: log is up-to-date if:
  // - candidateLastLogTerm > voter's last log term, OR
  // - candidateLastLogTerm === voter's last log term AND candidateLastLogIndex >= voter's last log index
  isLogUpToDate(candidateLastLogIndex, candidateLastLogTerm) {
    const voterLastLogIndex = this.log.length - 1;
    const voterLastLogTerm = voterLastLogIndex >= 0 ? this.log[voterLastLogIndex].term : 0;
    
    if (candidateLastLogTerm > voterLastLogTerm) {
      return true;
    }
    if (candidateLastLogTerm === voterLastLogTerm && candidateLastLogIndex >= voterLastLogIndex) {
      return true;
    }
    return false;
  }

  // Handle incoming heartbeat from leader
  handleAppendEntries(term, leaderId) {
    if (term >= this.currentTerm) {
      this.currentTerm = term;
      this.state = 'follower';
      this.leaderId = leaderId;
      this.votedFor = null;
      
      // Reset election timer
      this.startElectionTimer();
      
      return true;
    }
    
    return false;
  }

  // Check if this node is the leader
  isLeader() {
    return this.state === 'leader';
  }

  // Get the current leader
  getLeader() {
    return this.leaderId;
  }

  // Handle leader failure
  handleLeaderFailure() {
    console.log(`Handling leader failure, node ${this.nodeId} starting new election`);
    this.state = 'follower';
    this.leaderId = null;
    this.startElectionTimer();
  }
}

module.exports = ElectionManager;