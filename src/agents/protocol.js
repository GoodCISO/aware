// src/agents/protocol.js
// Agent Discovery Protocol Extensions for Node Discovery
// Adds AGENT_ANNOUNCE and AGENT_REVOKE message types
// Phase 1.1: Agent Identity Layer

const dgram = require('dgram');
const crypto = require('crypto');

// Message types
const MessageType = {
  AGENT_ANNOUNCE: 'AGENT_ANNOUNCE',
  AGENT_REVOKE: 'AGENT_REVOKE',
  AGENT_HEARTBEAT: 'AGENT_HEARTBEAT',
  AGENT_QUERY: 'AGENT_QUERY',
  AGENT_RESPONSE: 'AGENT_RESPONSE'
};

// Default broadcast address for agent discovery
const DEFAULT_AGENT_BROADCAST_PORT = 41236;
const DEFAULT_AGENT_MULTICAST_GROUP = '239.255.255.250';

class AgentProtocol {
  constructor(config = {}) {
    this.agentId = config.agentId;
    this.port = config.port || DEFAULT_AGENT_BROADCAST_PORT;
    this.multicastGroup = config.multicastGroup || DEFAULT_AGENT_MULTICAST_GROUP;
    this.socket = null;
    this.messageHandlers = new Map();
    this.isListening = false;
    
    // CRITICAL: Shared secret is required for HMAC signing - no defaults allowed
    if (!config.sharedSecret) {
      throw new Error('FATAL: AgentProtocol requires config.sharedSecret for HMAC signing. No default value allowed.');
    }
    this.sharedSecret = config.sharedSecret;
    
    // Callbacks for different message types
    this.onAgentAnnounce = config.onAgentAnnounce || null;
    this.onAgentRevoke = config.onAgentRevoke || null;
    this.onAgentHeartbeat = config.onAgentHeartbeat || null;
  }

  // Generate HMAC-SHA256 signature for a message
  signMessage(message) {
    const payload = JSON.stringify(message);
    const hmac = crypto.createHmac('sha256', this.sharedSecret);
    hmac.update(payload);
    return hmac.digest('hex');
  }

  // Verify HMAC signature of a message
  verifySignature(message, signature) {
    if (!signature) return false;
    const expectedSignature = this.signMessage(message);
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
    } catch (e) {
      return false;
    }
  }

  // Initialize the socket
  async initialize() {
    return new Promise((resolve, reject) => {
      try {
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        
        this.socket.on('error', (err) => {
          console.error('AgentProtocol socket error:', err);
          this.emit('error', err);
        });
        
        this.socket.on('message', (msg, rinfo) => {
          this.handleMessage(msg, rinfo);
        });
        
        this.socket.on('listening', () => {
          this.isListening = true;
          try {
            this.socket.addMembership(this.multicastGroup);
          } catch (err) {
            // Multicast membership might fail in some environments
            console.warn('Could not join multicast group:', err.message);
          }
          
          const address = this.socket.address();
          console.log(`AgentProtocol listening on ${address.address}:${address.port}`);
          resolve();
        });
        
        this.socket.bind(this.port, () => {
          // Binding completes asynchronously
        });
        
        this.socket.bind(() => {
          this.socket.setBroadcast(true);
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }

  // Handle incoming messages
  handleMessage(msg, rinfo) {
    try {
      const message = JSON.parse(msg.toString());
      
      // Don't process our own messages
      if (message.agentId === this.agentId) {
        return;
      }
      
      // CRITICAL: Verify HMAC signature before processing any message
      const signature = message.signature;
      const messageForVerification = { ...message };
      delete messageForVerification.signature;
      
      if (!this.verifySignature(messageForVerification, signature)) {
        console.warn(`Rejected message from ${rinfo.address}:${rinfo.port} - invalid signature`);
        return;
      }
      
      switch (message.type) {
        case MessageType.AGENT_ANNOUNCE:
          this.handleAgentAnnounce(message, rinfo);
          break;
          
        case MessageType.AGENT_REVOKE:
          this.handleAgentRevoke(message, rinfo);
          break;
          
        case MessageType.AGENT_HEARTBEAT:
          this.handleAgentHeartbeat(message, rinfo);
          break;
          
        case MessageType.AGENT_QUERY:
          this.handleAgentQuery(message, rinfo);
          break;
          
        case MessageType.AGENT_RESPONSE:
          this.handleAgentResponse(message, rinfo);
          break;
          
        default:
          console.warn(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  // Handle AGENT_ANNOUNCE message
  handleAgentAnnounce(message, rinfo) {
    console.log(`Agent announced: ${message.agentId} from ${rinfo.address}:${rinfo.port}`);
    
    if (this.onAgentAnnounce) {
      this.onAgentAnnounce(message, rinfo);
    }
    
    this.emit(MessageType.AGENT_ANNOUNCE, message, rinfo);
  }

  // Handle AGENT_REVOKE message
  handleAgentRevoke(message, rinfo) {
    console.log(`Agent revocation: ${message.agentId} - ${message.reason || 'no reason'}`);
    
    if (this.onAgentRevoke) {
      this.onAgentRevoke(message, rinfo);
    }
    
    this.emit(MessageType.AGENT_REVOKE, message, rinfo);
  }

  // Handle AGENT_HEARTBEAT message
  handleAgentHeartbeat(message, rinfo) {
    if (this.onAgentHeartbeat) {
      this.onAgentHeartbeat(message, rinfo);
    }
    
    this.emit(MessageType.AGENT_HEARTBEAT, message, rinfo);
  }

  // Handle AGENT_QUERY message (request for agent info)
  handleAgentQuery(message, rinfo) {
    if (message.targetAgentId && message.targetAgentId !== this.agentId) {
      // Not for us
      return;
    }
    
    // Send AGENT_RESPONSE with our info
    this.sendAgentResponse(rinfo);
  }

  // Handle AGENT_RESPONSE message
  handleAgentResponse(message, rinfo) {
    this.emit(MessageType.AGENT_RESPONSE, message, rinfo);
  }

  // Sign and broadcast a message
  signAndBroadcast(message) {
    const signature = this.signMessage(message);
    const signedMessage = { ...message, signature };
    return this.broadcast(signedMessage);
  }

  // Send AGENT_ANNOUNCE broadcast
  sendAgentAnnounce(agentInfo) {
    const message = {
      type: MessageType.AGENT_ANNOUNCE,
      agentId: this.agentId,
      timestamp: Date.now(),
      name: agentInfo.name || '',
      capabilities: agentInfo.capabilities || [],
      model: agentInfo.model || 'unknown',
      version: agentInfo.version || '1.0.0',
      clearance: agentInfo.clearance || 'internal_only',
      trustScore: agentInfo.trustScore || 0.5
    };
    
    return this.signAndBroadcast(message);
  }

  // Send AGENT_REVOKE broadcast
  sendAgentRevoke(reason = 'manual', initiator = 'system') {
    const message = {
      type: MessageType.AGENT_REVOKE,
      agentId: this.agentId,
      timestamp: Date.now(),
      reason,
      initiator,
      // A severity LABEL, not a computed radius. Named to say so; see
      // `calculateBlastRadius()` for the deferral note.
      protocolBlastRadiusSeverity: this.calculateBlastRadius()
    };
    
    return this.signAndBroadcast(message);
  }

  // Send AGENT_HEARTBEAT broadcast
  sendAgentHeartbeat(status = 'healthy') {
    const message = {
      type: MessageType.AGENT_HEARTBEAT,
      agentId: this.agentId,
      timestamp: Date.now(),
      status,
      trustScore: 0.5 // Would get this from registry
    };
    
    return this.signAndBroadcast(message);
  }

  // Query for agents (broadcast AGENT_QUERY and wait for responses)
  queryAgents(timeoutMs = 2000) {
    return new Promise((resolve) => {
      const responses = [];
      const timer = setTimeout(() => {
        resolve(responses);
      }, timeoutMs);
      
      const handler = (message, rinfo) => {
        responses.push({ ...message, from: rinfo });
      };
      
      this.on(MessageType.AGENT_RESPONSE, handler);
      
      // Send query
      const message = {
        type: MessageType.AGENT_QUERY,
        agentId: this.agentId,
        timestamp: Date.now(),
        targetAgentId: null // Broadcast query
      };
      
      this.signAndBroadcast(message);
    });
  }

  // Send AGENT_RESPONSE (unicast response to query)
  sendAgentResponse(targetRinfo) {
    const message = {
      type: MessageType.AGENT_RESPONSE,
      agentId: this.agentId,
      timestamp: Date.now(),
      name: 'unknown', // Would get from registry
      capabilities: [],
      model: 'unknown',
      version: '1.0.0'
    };
    
    return this.sendSignedMessage(message, targetRinfo);
  }

  // Sign and send a unicast message
  sendSignedMessage(message, targetRinfo) {
    const signature = this.signMessage(message);
    const signedMessage = { ...message, signature };
    return this.send(signedMessage, targetRinfo);
  }
  // Broadcast a message to all agents
  broadcast(message) {
    const msgBuffer = Buffer.from(JSON.stringify(message));
    
    return new Promise((resolve, reject) => {
      this.socket.send(
        msgBuffer,
        0,
        msgBuffer.length,
        this.port,
        this.multicastGroup,
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Send a unicast message to a specific address
  send(message, targetRinfo) {
    const msgBuffer = Buffer.from(JSON.stringify(message));
    
    return new Promise((resolve, reject) => {
      this.socket.send(
        msgBuffer,
        0,
        msgBuffer.length,
        targetRinfo.port,
        targetRinfo.address,
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  // Calculate blast radius for revocation
  //
  // DEFERRED — this is a placeholder, not a computation. It returns a
  // constant severity label, so it is a DECLARED quantity with no producer.
  // The name says so, and the value is deliberately not a number: a numeric
  // radius here would be indistinguishable from the real radius-shaped
  // quantity (`emergencyImpactEstimate`) or from the numeric estimates.
  //
  // When a real implementation lands it must return an object of the
  // emergency-impact shape, and this method should be renamed
  // `estimateEmergencyImpact` to match. See src/governance/registry.js
  // (`protocolBlastRadiusSeverity`).
  calculateBlastRadius() {
    // Simplified blast radius calculation
    // In production, this would analyze active tasks, connections, etc.
    return 'low';
  }

  // Register event handler
  on(eventType, handler) {
    if (!this.messageHandlers.has(eventType)) {
      this.messageHandlers.set(eventType, []);
    }
    this.messageHandlers.get(eventType).push(handler);
  }

  // Emit event
  emit(eventType, ...args) {
    const handlers = this.messageHandlers.get(eventType) || [];
    handlers.forEach(handler => handler(...args));
  }

  // Remove event handler
  off(eventType, handler) {
    const handlers = this.messageHandlers.get(eventType) || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
    }
  }

  // Stop the protocol
  close() {
    if (this.socket) {
      try {
        this.socket.dropMembership(this.multicastGroup);
      } catch (err) {
        // Ignore
      }
      this.socket.close();
      this.socket = null;
    }
    this.isListening = false;
  }
}

// Export MessageType for use elsewhere
AgentProtocol.MessageType = MessageType;

module.exports = AgentProtocol;
