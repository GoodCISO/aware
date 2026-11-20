// src/api/routes/agents.js
// REST API routes for Agent (NHI) lifecycle management
// Phase 1.1: Agent Identity Layer

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { Agent, AgentState } = require('../models/Agent');

const router = express.Router();

// M-02 FIX: Rate limiting for agent routes
const agentRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute per source IP
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// Authorization middleware - requires admin role for sensitive operations
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required for this operation' });
  }
  next();
};

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Helper to check if agent is in a valid operational state
const isOperational = (agent) => {
  return agent.state === AgentState.ACTIVE;
};

// GET /api/agents - List all agents (with optional state filter)
router.get('/', (req, res) => {
  try {
    const { state, type, limit } = req.query;
    
    let agents = Agent.findAll(state);
    
    // Filter by type if specified
    if (type) {
      agents = agents.filter(a => a.type === type);
    }
    
    // Sort by trust score descending
    agents.sort((a, b) => b.declaredTrustScore - a.declaredTrustScore);
    
    // Apply limit if specified
    if (limit) {
      agents = agents.slice(0, parseInt(limit, 10));
    }
    
    // Strip credentials from response
    const safeAgents = agents.map(a => ({
      ...a.toJSON(),
      credentials: undefined // Never expose credentials in list
    }));
    
    res.json({
      agents: safeAgents,
      count: safeAgents.length
    });
  } catch (error) {
    console.error('Error listing agents:', error);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// GET /api/agents/:id - Get agent by ID
router.get('/:id',
  param('id').isUUID(),
  validate,
  (req, res) => {
    try {
      const agent = Agent.findById(req.params.id);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      // Strip credentials from response
      const safeAgent = {
        ...agent.toJSON(),
        credentials: undefined
      };
      
      res.json(safeAgent);
    } catch (error) {
      console.error('Error getting agent:', error);
      res.status(500).json({ error: 'Failed to get agent' });
    }
  }
);

// GET /api/agents/agentId/:agentId - Get agent by agentId (e.g., "agent:coder:instance-7f3a")
router.get('/agentId/:agentId',
  (req, res) => {
    try {
      const agent = Agent.findByAgentId(req.params.agentId);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      // Strip credentials from response
      const safeAgent = {
        ...agent.toJSON(),
        credentials: undefined
      };
      
      res.json(safeAgent);
    } catch (error) {
      console.error('Error getting agent by agentId:', error);
      res.status(500).json({ error: 'Failed to get agent' });
    }
  }
);

// POST /api/agents - Register a new agent (onboarding)
// SC-HIGH-007: requireAdmin gate — only compliance-admin /
// compliance-officer may register new agents. Without this, any
// authenticated user could mint a new agent identity with elevated
// capabilities (clearance, declaredTrustScore) and operate as that identity.
router.post('/',
  agentRateLimit, // M-02: Rate limiting
  requireAdmin,
  [
    body('agentId').isString().notEmpty().withMessage('agentId is required'),
    body('name').isString().notEmpty().withMessage('name is required'),
    body('type').isString().notEmpty().withMessage('type is required'),
    body('model').optional().isString(),
    body('version').optional().isString(),
    body('capabilities').optional().isArray(),
    body('clearance').optional().isString(),
    body('metadata').optional().isObject()
  ],
  validate,
  (req, res) => {
    try {
      const { agentId, name, type, model, version, capabilities, clearance, metadata } = req.body;
      
      // Check if agent with this agentId already exists
      const existing = Agent.findByAgentId(agentId);
      if (existing) {
        return res.status(409).json({ error: 'Agent with this agentId already exists', existingId: existing.id });
      }
      
      // Create new agent
      const agent = Agent.create({
        agentId,
        name,
        type,
        model: model || 'unknown',
        version: version || '1.0.0',
        capabilities: capabilities || [],
        clearance: clearance || 'internal_only',
        metadata: metadata || {},
        state: AgentState.ACTIVE // Agents are active on creation
      });
      
      // Strip credentials from response
      const safeAgent = {
        ...agent.toJSON(),
        credentials: undefined
      };
      
      res.status(201).json({
        message: 'Agent registered successfully',
        agent: safeAgent
      });
    } catch (error) {
      console.error('Error registering agent:', error);
      res.status(500).json({ error: 'Failed to register agent' });
    }
  }
);

// PUT /api/agents/:id - Update agent
// SC-HIGH-007: requireAdmin gate — only compliance-admin may change
// another agent's clearance, declaredTrustScore, or capabilities. Without this,
// any authenticated user could escalate the privilege of any agent
// (including themselves) by updating its fields.
router.put('/:id',
  requireAdmin,
  param('id').isUUID(),
  validate,
  (req, res) => {
    try {
      const { name, capabilities, clearance, metadata, declaredTrustScore } = req.body;
      
      const agent = Agent.findById(req.params.id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      // Build update object
      const updates = {};
      if (name !== undefined) updates.name = name;
      if (capabilities !== undefined) updates.capabilities = capabilities;
      if (clearance !== undefined) updates.clearance = clearance;
      if (metadata !== undefined) updates.metadata = metadata;
      if (declaredTrustScore !== undefined) updates.declaredTrustScore = declaredTrustScore;
      
      const updated = Agent.update(req.params.id, updates);
      
      // Strip credentials from response
      const safeAgent = {
        ...updated.toJSON(),
        credentials: undefined
      };
      
      res.json({
        message: 'Agent updated successfully',
        agent: safeAgent
      });
    } catch (error) {
      console.error('Error updating agent:', error);
      res.status(500).json({ error: 'Failed to update agent' });
    }
  }
);

// POST /api/agents/:id/rotate-credentials - Rotate agent credentials (admin only)
router.post('/:id/rotate-credentials',
  param('id').isUUID(),
  validate,
  requireAdmin,
  (req, res) => {
    try {
      const agent = Agent.findById(req.params.id);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      if (!isOperational(agent)) {
        return res.status(403).json({ error: `Cannot rotate credentials for agent in ${agent.state} state` });
      }
      
      const newCredential = agent.rotateCredentials();
      Agent.saveAgent(agent);
      
      res.json({
        message: 'Credentials rotated successfully',
        agentId: agent.agentId,
        rotatedAt: agent.credentials.rotatedAt
      });
    } catch (error) {
      console.error('Error rotating credentials:', error);
      res.status(500).json({ error: 'Failed to rotate credentials' });
    }
  }
);

// POST /api/agents/:id/heartbeat - Agent heartbeat (update last seen)
// H-02 FIX: Agent must authenticate with its own JWT; agentId in JWT must match :id
router.post('/:id/heartbeat',
  agentRateLimit, // M-02: Rate limiting
  param('id').isUUID(),
  validate,
  (req, res) => {
    try {
      // H-02: Verify the JWT is for an agent, and agentId matches the requested agent
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (req.user.type !== 'agent') {
        return res.status(403).json({ error: 'Agents only' });
      }
      if (req.user.agentId !== req.params.id) {
        return res.status(403).json({ error: 'Cannot heartbeat for another agent' });
      }
      
      const agent = Agent.findById(req.params.id);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      if (!isOperational(agent)) {
        return res.status(403).json({ error: `Agent is not operational (state: ${agent.state})` });
      }
      
      agent.touch();
      Agent.saveAgent(agent);
      
      res.json({
        message: 'Heartbeat recorded',
        agentId: agent.agentId,
        lastSeenAt: agent.lastSeenAt,
        declaredTrustScore: agent.declaredTrustScore
      });
    } catch (error) {
      console.error('Error recording heartbeat:', error);
      res.status(500).json({ error: 'Failed to record heartbeat' });
    }
  }
);

// POST /api/agents/:id/suspend - Suspend agent (admin only)
router.post('/:id/suspend',
  param('id').isUUID(),
  validate,
  requireAdmin,
  (req, res) => {
    try {
      const agent = Agent.findById(req.params.id);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      try {
        agent.transitionTo(AgentState.SUSPENDED);
        Agent.saveAgent(agent);
        
        res.json({
          message: 'Agent suspended',
          agentId: agent.agentId,
          state: agent.state
        });
      } catch (stateError) {
        return res.status(400).json({ error: stateError.message });
      }
    } catch (error) {
      console.error('Error suspending agent:', error);
      res.status(500).json({ error: 'Failed to suspend agent' });
    }
  }
);

// POST /api/agents/:id/activate - Activate/reinstate agent
router.post('/:id/activate',
  param('id').isUUID(),
  validate,
  (req, res) => {
    try {
      const agent = Agent.findById(req.params.id);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      try {
        agent.transitionTo(AgentState.ACTIVE);
        Agent.saveAgent(agent);
        
        res.json({
          message: 'Agent activated',
          agentId: agent.agentId,
          state: agent.state
        });
      } catch (stateError) {
        return res.status(400).json({ error: stateError.message });
      }
    } catch (error) {
      console.error('Error activating agent:', error);
      res.status(500).json({ error: 'Failed to activate agent' });
    }
  }
);

// POST /api/agents/:id/revoke - Revoke agent (admin only)
router.post('/:id/revoke',
  [
    param('id').isUUID(),
    body('reason').optional().isString()
  ],
  validate,
  requireAdmin,
  (req, res) => {
    try {
      const agent = Agent.findById(req.params.id);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      const reason = req.body.reason || 'manual';
      
      try {
        const revoked = Agent.revoke(req.params.id, reason);
        
        res.json({
          message: 'Agent revoked',
          agentId: revoked.agentId,
          state: revoked.state,
          reason: reason
        });
      } catch (stateError) {
        return res.status(400).json({ error: stateError.message });
      }
    } catch (error) {
      console.error('Error revoking agent:', error);
      res.status(500).json({ error: 'Failed to revoke agent' });
    }
  }
);

// DELETE /api/agents/:id - Decommission agent (soft delete, admin only)
router.delete('/:id',
  param('id').isUUID(),
  validate,
  requireAdmin,
  (req, res) => {
    try {
      const agent = Agent.findById(req.params.id);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      const decommissioned = Agent.decommission(req.params.id);
      
      res.json({
        message: 'Agent decommissioned',
        agentId: decommissioned.agentId,
        state: decommissioned.state,
        decommissionedAt: decommissioned.decommissionedAt
      });
    } catch (error) {
      console.error('Error decommissioning agent:', error);
      res.status(500).json({ error: 'Failed to decommission agent' });
    }
  }
);

// GET /api/agents/:id/verify - Verify agent credentials
router.post('/:id/verify',
  [
    param('id').isUUID(),
    body('credential').isString().notEmpty().withMessage('credential is required')
  ],
  validate,
  (req, res) => {
    try {
      const agent = Agent.findById(req.params.id);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      
      const { credential } = req.body;
      const isValid = agent.checkCredential(credential);
      
      if (isValid) {
        agent.touch();
        Agent.saveAgent(agent);
      }
      
      res.json({
        valid: isValid,
        agentId: agent.agentId,
        state: agent.state
      });
    } catch (error) {
      console.error('Error verifying agent:', error);
      res.status(500).json({ error: 'Failed to verify agent' });
    }
  }
);

module.exports = router;
