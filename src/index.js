// src/index.js
const NodeDiscovery = require('./node-discovery');
const ElectionManager = require('./election');
const StateMachine = require('./election/state-machine');
const APIGateway = require('./api');
const { resolveSecretKey } = require('./engine-secret.js');

class AWAREEngine {
  constructor(config = {}) {
    // SEC-001: SECRET_KEY must
    // be supplied via config or env, and must be ≥32 chars. Mirrors the
    // v2 fail-secure pattern (identity-provider-v2.js: "FATAL: ... requires
    // config.secretKey. No default value allowed.") and the v1
    // auth.js:6-12 pattern. The previous `|| 'default_secret'` fallback
    // was a fail-open path: a fresh deployment with no env vars ran with
    // a publicly-known signing key, allowing forged JWTs.
    const suppliedSecret = resolveSecretKey({
      configSecretKey: config.secretKey,
      envSecretKey: process.env.SECRET_KEY,
    });
    this.config = {
      nodeId: config.nodeId,
      discoveryPort: config.discoveryPort || 41234,
      broadcastPort: config.broadcastPort || 41235,
      apiPort: config.apiPort || process.env.API_PORT || 3000,
      nodes: config.nodes || [], // Other nodes in the cluster
      secretKey: suppliedSecret,
      ...config
    };
    
    this.nodeDiscovery = null;
    this.electionManager = null;
    this.stateMachine = null;
    this.apiGateway = null;
  }

  async initialize() {
    console.log('Initializing AWARE Engine...');
    
    // Initialize node discovery
    this.nodeDiscovery = new NodeDiscovery({
      nodeId: this.config.nodeId,
      port: this.config.discoveryPort,
      broadcastPort: this.config.broadcastPort
    });
    
    // Initialize the shared Raft log (t_8c8cbf64). The election manager and
    // the kill switch must append to the SAME log, so it is created here and
    // handed to both.
    this.stateMachine = new StateMachine(this.config.nodeId);

    // Initialize election manager
    this.electionManager = new ElectionManager(
      this.config.nodeId,
      { nodes: this.config.nodes, stateMachine: this.stateMachine }
    );
    
    // Initialize API gateway
    this.apiGateway = new APIGateway({
      port: this.config.apiPort,
      nodeId: this.config.nodeId,
      nodeDiscovery: this.nodeDiscovery,
      electionManager: this.electionManager,
      stateMachine: this.stateMachine,
      secretKey: this.config.secretKey
    });
    
    // Start services in order
    await this.nodeDiscovery.start();
    console.log('Node discovery service started');
    
    await this.apiGateway.start();
    console.log('API gateway started');
    
    console.log('AWARE Engine initialized successfully');
  }

  async shutdown() {
    console.log('Shutting down AWARE Engine...');
    
    if (this.nodeDiscovery) {
      this.nodeDiscovery.stop();
    }
    
    if (this.apiGateway) {
      this.apiGateway.stop();
    }
    
    if (this.electionManager) {
      // Stop the election timer so the process can exit cleanly.
      if (typeof this.electionManager.stop === 'function') {
        this.electionManager.stop();
      }
    }
    
    console.log('AWARE Engine shutdown complete');
  }
}

// If running directly, start the engine
if (require.main === module) {
  const engine = new AWAREEngine({
    nodeId: process.env.NODE_ID || require('uuid').v4(),
    secretKey: process.env.SECRET_KEY,
    nodes: process.env.NODE_LIST ? process.env.NODE_LIST.split(',') : []
  });
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await engine.shutdown();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await engine.shutdown();
    process.exit(0);
  });
  
  // Initialize the engine
  engine.initialize().catch(err => {
    console.error('Failed to initialize AWARE Engine:', err);
    process.exit(1);
  });
}

module.exports = AWAREEngine;
