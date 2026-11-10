// src/api/index.js
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const clusterRouter = require('./routes/cluster');
const nodesRouter = require('./routes/nodes');
const alertsRouter = require('./routes/alerts');
const resourcesRouter = require('./routes/resources');
const agentsRouter = require('./routes/agents');
const policiesRouter = require('./routes/policies');
const metricsRouter = require('./routes/metrics');
// SC-MOD-015: previously-orphaned routes — see mounting block below.
const complianceRouter = require('./routes/compliance');
const toolsRouter = require('./routes/tools');
const { authenticateToken, authLimiter } = require('./middleware/auth');
const ClusterService = require('./services/cluster-service');

// Phase 1.4: Import kill-switch components
const killSwitchRouter = require('../kill-switch/api/kill-switch-routes');
const { RevocationService } = require('../kill-switch');
const StateMachine = require('../election/state-machine');
const AgentRegistry = require('../agents/registry');

class APIGateway {
  constructor(config = {}) {
    // CRITICAL: Secret key is required - no defaults allowed
    if (!config.secretKey) {
      throw new Error('FATAL: API Gateway requires config.secretKey. No default value allowed.');
    }
    this.app = express();
    this.port = config.port || 3000;
    this.secretKey = config.secretKey;
    this.nodeDiscovery = config.nodeDiscovery;
    this.electionManager = config.electionManager;
    this.server = null;

    // Initialize cluster service
    this.clusterService = new ClusterService({
      nodeDiscovery: this.nodeDiscovery,
      electionManager: this.electionManager
    });
    
    // Phase 1.4: Initialize RevocationService
    // Note: Full Raft infrastructure (ElectionManager, StateMachine) required for proper operation
    // For now, initialize with undefined — routes will return 503 until properly wired
    this.revocationService = new RevocationService({
      electionManager: this.electionManager,
      stateMachine: undefined,
      registry: undefined
    });
    console.log('[KillSwitch] RevocationService initialized (pending Raft setup)');

    // H-01 FIX: Enforce HTTPS in production
    if (process.env.NODE_ENV === 'production') {
      this.app.use((req, res, next) => {
        if (!req.secure && req.get('X-Forwarded-Proto') !== 'https') {
          return res.status(403).json({ error: 'HTTPS required for agent operations' });
        }
        next();
      });
    }

    // Security middleware
    this.app.use(helmet({  // Security headers
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true
      }
    }));

    // Rate limiting for all requests
    const generalLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per windowMs
      message: 'Too many requests from this IP, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
    });
    this.app.use(generalLimiter);

    // CORS middleware
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') || [process.env.FRONTEND_URL || 'http://localhost:3001'],
      credentials: true,
      optionsSuccessStatus: 200
    }));

    // Body parsing middleware
    this.app.use(express.json({
      limit: '10mb'  // Limit request size
    }));
    this.app.use(express.urlencoded({
      extended: true,
      limit: '10mb'  // Limit request size
    }));

    // Make services available to routes
    this.app.set('nodeDiscovery', this.nodeDiscovery);
    this.app.set('electionManager', this.electionManager);
    this.app.set('clusterService', this.clusterService);
    this.app.set('revocationService', this.revocationService);
    this.app.set('stateMachine', this.stateMachine);
    this.app.set('agentRegistry', this.agentRegistry);

    // Public routes (no authentication required)
    this.app.use('/health', (req, res) => {
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    });

    // Login route with rate limiting
    this.app.post('/login', authLimiter, (req, res) => {
      const { username, password } = req.body;

      // Import User model locally to avoid circular dependencies
      const User = require('./models/User');

      // Validate user credentials against the user database
      const user = User.validateCredentials(username, password);

      if (user) {
        const token = jwt.sign(
          {
            userId: user.id,
            username: user.username,
            permissions: user.role === 'admin' ? ['read', 'write', 'admin'] : ['read', 'write'],
            role: user.role
          },
          this.secretKey,
          { expiresIn: process.env.TOKEN_EXPIRY || '24h' }
        );

        res.json({
          token,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            email: user.email
          }
        });
      } else {
        // Invalid credentials
        res.status(401).json({
          error: 'Invalid username or password'
        });
      }
    });

    // User registration route with rate limiting
    this.app.post('/register', authLimiter, (req, res) => {
      const { username, email, password, role } = req.body;

      // Import User model locally to avoid circular dependencies
      const User = require('./models/User');

      // Validate input
      if (!username || !email || !password) {
        return res.status(400).json({
          error: 'Username, email, and password are required'
        });
      }

      // Check if user already exists
      const existingUser = User.findByUsername(username);
      if (existingUser) {
        return res.status(409).json({
          error: 'Username already exists'
        });
      }

      try {
        // Create new user (default role is 'user')
        const newUser = User.create(username, email, password, role || 'user');

        // Generate token for the new user
        const token = jwt.sign(
          {
            userId: newUser.id,
            username: newUser.username,
            permissions: newUser.role === 'admin' ? ['read', 'write', 'admin'] : ['read', 'write'],
            role: newUser.role
          },
          this.secretKey,
          { expiresIn: process.env.TOKEN_EXPIRY || '24h' }
        );

        res.status(201).json({
          message: 'User registered successfully',
          token,
          user: {
            id: newUser.id,
            username: newUser.username,
            role: newUser.role,
            email: newUser.email
          }
        });
      } catch (error) {
        console.error('Error registering user:', error);
        res.status(500).json({
          error: 'Failed to register user'
        });
      }
    });

    // Protected routes (authentication required)
    this.app.use(authenticateToken);

    // API routes
    this.app.use('/api/cluster', clusterRouter);
    this.app.use('/api/nodes', nodesRouter);
    this.app.use('/api/alerts', alertsRouter);
    this.app.use('/api/resources', resourcesRouter);
    this.app.use('/api/agents', agentsRouter);
    this.app.use('/api/policies', policiesRouter);
    this.app.use('/api/metrics', metricsRouter);

    // Phase 1.4: Kill Switch routes
    this.app.use('/api/kill-switch', killSwitchRouter);

    // AWARE v2: POST /v2/tier-promotions — openapi.yaml defines this at the
    // root path (NOT under /api/), so we mount it at the root with bearer auth
    // supplied by the upstream `this.app.use(authenticateToken)` above. The
    // handler module is lazily-required (mirrors the identity-v2 pattern) so a
    // missing SECRET_KEY doesn't take down the whole gateway.
    this.app.use('/v2', (req, res, next) => {
      if (!this._tierPromotionsRouter) {
        try {
          const { createTierPromotionsRouter } = require('../v2/tier_promotions_handler');
          this._tierPromotionsRouter = createTierPromotionsRouter();
        } catch (err) {
          return res.status(503).json({
            success: false,
            error: 'v2 tier-promotions routes unavailable: ' + err.message,
          });
        }
      }
      this._tierPromotionsRouter(req, res, next);
    });

    // SC-MOD-015: Mount the previously-orphaned route files.
    // five (compliance.js, tools.js) export Express routers directly
    // and mount as-is. The other three (identity-v2.js, audit.js,
    // hot-reload-policies.js) export collections of route handlers
    // and need a small adapter — see src/api/routes/identity-v2.js,
    // audit.js, hot-reload-policies.js for the adapter wrappers.
    this.app.use('/api/compliance', complianceRouter);
    this.app.use('/api/tools', toolsRouter);

    // SC-MOD-015: lazy-require identity-v2 because its module-load
    // chain (auth.js + Agent.js) calls process.exit(1) if SECRET_KEY
    // is missing or <32 chars. Defer to first request so the gateway
    // can boot with config.secretKey but still surface clear errors
    // if the env validation fails at runtime.
    this.app.use('/api/identity-v2', (req, res, next) => {
      if (!this._identityV2Router) {
        try {
          const { router } = require('./routes/identity-v2');
          this._identityV2Router = router;
        } catch (err) {
          return res.status(503).json({
            success: false,
            error: 'identity-v2 routes unavailable: ' + err.message,
          });
        }
      }
      this._identityV2Router(req, res, next);
    });

    // SC-MOD-015: audit.js exports 5 route handlers (not a router).
    // Wrap them in a router with the canonical /api/audit paths
    // matching the inline comments in src/api/routes/audit.js.
    const auditHandlers = require('./routes/audit');
    const auditAdapter = require('express').Router();
    auditAdapter.post('/log', auditHandlers.logDecisionRoute);
    auditAdapter.get('/chain/:decisionId', auditHandlers.getChainRoute);
    auditAdapter.get('/verify', auditHandlers.verifyChainRoute);
    auditAdapter.get('/export', auditHandlers.exportChainRoute);
    auditAdapter.get('/records/:decisionId', auditHandlers.getRecordRoute);
    this.app.use('/api/audit', auditAdapter);

    // SC-MOD-015: hot-reload-policies.js exports 6 route handlers.
    // Wrap them with canonical /api/policies/* paths.
    const policyHandlers = require('./routes/hot-reload-policies');
    const policyAdapter = require('express').Router();
    policyAdapter.post('/validate', policyHandlers.validatePolicyRoute);
    policyAdapter.put('/:policyId', policyHandlers.updatePolicyRoute);
    policyAdapter.get('/', policyHandlers.listPoliciesRoute);
    policyAdapter.get('/:policyId', policyHandlers.getPolicyRoute);
    policyAdapter.post('/:policyId/reload', policyHandlers.reloadPolicyRoute);
    policyAdapter.get('/:policyId/history', policyHandlers.getPolicyHistoryRoute);
    this.app.use('/api/policies/hot', policyAdapter);

    // Catch-all for undefined routes
    this.app.use('*', (req, res) => {
      res.status(404).json({ error: 'Route not found' });
    });

    // Error handling middleware
    this.app.use((err, req, res, next) => {
      console.error(err.stack);

      // Don't expose stack traces in production
      if (process.env.NODE_ENV === 'production') {
        res.status(500).json({ error: 'Internal server error' });
      } else {
        res.status(500).json({ error: 'Something went wrong!', details: err.message });
      }
    });
  }

  // Start the API server
  start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`API Gateway listening on port ${this.port}`);
        console.log(`API endpoints available at http://localhost:${this.port}/api/`);
        resolve();
      }).on('error', (err) => {
        console.error('API Gateway error:', err);
        reject(err);
      });
    });
  }

  // Stop the API server
  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

// --- Standalone entrypoint -------------------------------------------
//
// `npm start` runs `node src/api/index.js` (package.json "start"), and the
// Dockerfile does `EXPOSE 3000` + `CMD ["npm", "start"]`. Before this
// block existed the file was module-only: it exported the APIGateway class
// and exited without binding anything, so the container exposed a port and
// served nothing. Verified by execution, not by reading — the port was
// CLOSED (ECONNREFUSED) 4s after `npm start`.
//
// This block mirrors the house pattern in src/gateway/server.js: the file is
// both a module (exported for tests and for src/index.js) and a server
// (when run directly).
//
// SCOPE — why the API gateway alone and not the full engine:
//   `src/index.js` (the package `main`) also constructs an APIGateway, but
//   it additionally starts node discovery (UDP 41234/41235) and an
//   ElectionManager. The ElectionManager starts a 300-600ms election timer
//   in its constructor and a solo node never wins a quorum, so it spins
//   elections forever: measured 11 terms in 5s, state stuck at 'candidate',
//   isLeader() false. That is both wasted CPU and a misleading network
//   surface for a single-node API container. The API gateway itself needs
//   neither — every route it mounts degrades correctly without them:
//   ClusterService null-checks nodeDiscovery/electionManager, and the
//   nodes route returns 500 "Node discovery service not available" rather
//   than throwing.
//
// The Raft kill-switch path IS wired now (t_8c8cbf64): the gateway builds a
// StateMachine and an AgentRegistry and hands them to the RevocationService.
// This entrypoint starts no ElectionManager - the gateway alone is not part
// of a Raft cluster - so the kill switch reports that it is not wired (HTTP
// 503 with the missing dependency) instead of crashing on an undefined
// property. The full engine (src/index.js) supplies an ElectionManager and
// shares one StateMachine with it.
//
// Config resolution (fail-closed, matching src/index.js and SEC-001):
//   - SECRET_KEY: required, >= 32 chars. Reuses resolveSecretKey() from
//     src/engine-secret.js so the rule has one canonical home. A missing or
//     short key must fail the boot loudly, not start a server that signs
//     JWTs with an empty key.
//   - API_PORT: the port to bind. docker-compose.yml already exports
//     API_PORT=${API_PORT:-3000} and maps it, so honouring it here is what
//     makes the compose stack actually reach the server it starts. Default
//     3000, matching the Dockerfile's EXPOSE.
//
// Note NODE_ID / DISCOVERY_PORT / BROADCAST_PORT / NODE_LIST are also
// exported by docker-compose.yml, but they are consumed by src/index.js
// (the full engine), not by the API gateway. They are deliberately not
// honoured here: this entrypoint does not start discovery or an election.

if (require.main === module) {
  const { resolveSecretKey } = require('../engine-secret.js');

  let secretKey;
  try {
    secretKey = resolveSecretKey({
      envSecretKey: process.env.SECRET_KEY,
      minLength: 32,
    });
  } catch (err) {
    console.error(`[aware-api] FATAL: ${err.message}`);
    process.exit(1);
  }

  // API_PORT is a string from the environment; parse it so a malformed
  // value fails loudly here rather than being handed to app.listen().
  const rawPort = process.env.API_PORT || '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[aware-api] FATAL: API_PORT must be an integer between 0 and 65535 (got "${rawPort}").`);
    process.exit(1);
  }

  const gateway = new APIGateway({ port, secretKey });

  gateway.start().catch((err) => {
    console.error('[aware-api] FATAL: failed to start API gateway:', err.message);
    process.exit(1);
  });

  // Graceful shutdown: `docker stop` sends SIGTERM, and the compose file
  // uses `restart: unless-stopped`, so the container must exit cleanly
  // rather than be SIGKILLed. Same shape as src/gateway/server.js: drain
  // in-flight requests, then exit; force-exit if the drain stalls.
  const shutdown = (signal) => () => {
    console.log(`[aware-api] received ${signal}, draining...`);
    gateway.stop(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

module.exports = APIGateway;