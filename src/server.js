const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { normalizeAnomalies, countBySeverity } = require('./monitoring/severity-contract');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(helmet());
app.use(express.json());

// Load data files
const agentsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/agents.json'), 'utf8'));
const usersData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/users.json'), 'utf8'));

// In-memory stores
const agents = agentsData.agents.map(a => ({
  ...a,
  lastActivity: a.lastSeenAt || a.createdAt,
  status: a.state === 'active' ? 'active' : a.state === 'revoked' ? 'suspended' : a.state === 'decommissioned' ? 'decommissioned' : 'pending',
  credentials: !!a.credentials?.current,
}));

// Add mock agents to make the demo richer
const mockAgents = [
  {
    id: 'agent:researcher:demo-001',
    agentId: 'agent:researcher:demo-001',
    name: 'Researcher (Demo)',
    type: 'researcher',
    model: 'primary-model',
    version: '1.2.0',
    capabilities: ['web_search', 'research', 'reporting', 'data_extract'],
    clearance: 'trusted',
    trustScore: 0.92,
    state: 'active',
    status: 'active',
    credentials: true,
    lastActivity: '2026-05-22T18:45:00Z',
    lastSeenAt: '2026-05-22T18:45:00Z',
    createdAt: '2026-03-15T10:00:00Z',
  },
  {
    id: 'agent:coder:demo-002',
    agentId: 'agent:coder:demo-002',
    name: 'Coder (Demo)',
    type: 'coder',
    model: 'primary-model',
    version: '2.1.0',
    capabilities: ['code_write', 'test_write', 'git_push', 'debug'],
    clearance: 'trusted',
    trustScore: 0.85,
    state: 'active',
    status: 'active',
    credentials: true,
    lastActivity: '2026-05-22T19:00:00Z',
    lastSeenAt: '2026-05-22T19:00:00Z',
    createdAt: '2026-03-20T14:00:00Z',
  },
  {
    id: 'agent:architect:demo-003',
    agentId: 'agent:architect:demo-003',
    name: 'Architect (Demo)',
    type: 'architect',
    model: 'primary-model',
    version: '1.5.0',
    capabilities: ['design', 'specification', 'review', 'architecture'],
    clearance: 'trusted',
    trustScore: 0.88,
    state: 'active',
    status: 'active',
    credentials: true,
    lastActivity: '2026-05-22T18:30:00Z',
    lastSeenAt: '2026-05-22T18:30:00Z',
    createdAt: '2026-03-10T09:00:00Z',
  },
  {
    id: 'agent:designer:demo-004',
    agentId: 'agent:designer:demo-004',
    name: 'Designer (Demo)',
    type: 'designer',
    model: 'primary-model',
    version: '1.0.0',
    capabilities: ['ui_design', 'css', 'prototyping'],
    clearance: 'internal_only',
    trustScore: 0.45,
    state: 'suspended',
    status: 'suspended',
    credentials: false,
    lastActivity: '2026-05-20T09:15:00Z',
    lastSeenAt: '2026-05-20T09:15:00Z',
    createdAt: '2026-04-01T11:00:00Z',
  },
  {
    id: 'agent:tester:demo-005',
    agentId: 'agent:tester:demo-005',
    name: 'Tester (Demo)',
    type: 'tester',
    model: 'primary-model',
    version: '1.1.0',
    capabilities: ['testing', 'validation', 'reporting', 'assertions'],
    clearance: 'trusted',
    trustScore: 0.78,
    state: 'active',
    status: 'active',
    credentials: true,
    lastActivity: '2026-05-22T17:30:00Z',
    lastSeenAt: '2026-05-22T17:30:00Z',
    createdAt: '2026-03-25T16:00:00Z',
  },
  {
    id: 'agent:pr:demo-006',
    agentId: 'agent:pr:demo-006',
    name: 'PR Agent (Demo)',
    type: 'pr',
    model: 'primary-model',
    version: '1.3.0',
    capabilities: ['social_post', 'engagement', 'content_creation'],
    clearance: 'trusted',
    trustScore: 0.72,
    state: 'active',
    status: 'active',
    credentials: true,
    lastActivity: '2026-05-22T18:50:00Z',
    lastSeenAt: '2026-05-22T18:50:00Z',
    createdAt: '2026-04-05T08:00:00Z',
  },
];

// Merge mock agents with existing
const allAgents = [...mockAgents, ...agents];

// Compliance frameworks data
const complianceFrameworks = [
  {
    id: 'iso-27001',
    name: 'ISO 27001',
    status: 'partial',
    controlsPassing: 42,
    controlsTotal: 93,
    lastAudit: '2026-04-15T10:00:00Z',
    evidence: [
      { control: 'A.5.1', status: 'pass', description: 'Information security policies defined' },
      { control: 'A.6.1', status: 'pass', description: 'Internal organization established' },
      { control: 'A.8.1', status: 'partial', description: 'Asset inventory partially complete' },
      { control: 'A.9.1', status: 'pass', description: 'Access control policy in place' },
      { control: 'A.12.1', status: 'pass', description: 'Operational procedures documented' },
    ],
  },
  {
    id: 'soc2',
    name: 'SOC 2 Type II',
    status: 'partial',
    controlsPassing: 28,
    controlsTotal: 64,
    lastAudit: '2026-03-20T14:00:00Z',
    evidence: [
      { control: 'CC1.1', status: 'pass', description: 'Control environment established' },
      { control: 'CC2.1', status: 'pass', description: 'Communication of controls documented' },
      { control: 'CC3.1', status: 'partial', description: 'Risk assessment process in place' },
      { control: 'CC6.1', status: 'pass', description: 'Logical access controls implemented' },
      { control: 'CC7.1', status: 'partial', description: 'System monitoring operational' },
    ],
  },
  {
    id: 'nist-ai',
    name: 'NIST AI RMF',
    status: 'in-progress',
    controlsPassing: 15,
    controlsTotal: 48,
    lastAudit: '2026-05-01T09:00:00Z',
    evidence: [
      { control: 'GOV-1', status: 'pass', description: 'AI governance policy established' },
      { control: 'MAP-1', status: 'pass', description: 'AI system context mapped' },
      { control: 'MEASURE-1', status: 'partial', description: 'Metrics collection in progress' },
      { control: 'MANAGE-1', status: 'in-progress', description: 'Risk management framework developing' },
    ],
  },
  {
    id: 'gdpr',
    name: 'GDPR',
    status: 'partial',
    controlsPassing: 35,
    controlsTotal: 68,
    lastAudit: '2026-04-01T11:00:00Z',
    evidence: [
      { control: 'Art.5', status: 'pass', description: 'Data processing principles documented' },
      { control: 'Art.6', status: 'pass', description: 'Lawful basis established' },
      { control: 'Art.25', status: 'partial', description: 'Data protection by design in progress' },
      { control: 'Art.35', status: 'in-progress', description: 'DPIA process being established' },
    ],
  },
  {
    id: 'eu-ai-act',
    name: 'EU AI Act',
    status: 'in-progress',
    controlsPassing: 8,
    controlsTotal: 42,
    lastAudit: '2026-05-10T10:00:00Z',
    evidence: [
      { control: 'Art.9', status: 'pass', description: 'Risk management system implemented' },
      { control: 'Art.10', status: 'partial', description: 'Data governance framework developing' },
      { control: 'Art.13', status: 'in-progress', description: 'Transparency obligations in progress' },
      { control: 'Art.15', status: 'in-progress', description: 'Accuracy and robustness testing developing' },
    ],
  },
];

// Anomaly data
//
// Severity is the canonical 4-level enum from
// src/monitoring/severity-contract.js, matching the detector's z-score
// ladder (the real producer). These literals previously used a lowercase
// 3-level vocabulary ('high'|'medium'|'low') that no consumer understood --
// see card t_517be819 / t_775073b4. normalizeAnomalies() is applied below so
// the stored values can never drift from the enum, even if a literal is
// edited later.
const anomalies = [
  {
    id: 'anom-001',
    agentId: 'agent:writer:live-004',
    type: 'behavioral_deviation',
    severity: 'HIGH',
    description: 'Agent Designer accessed unauthorized tool endpoints outside clearance scope',
    detectedAt: '2026-05-20T09:10:00Z',
    acknowledged: false,
    baseline: { toolCallRate: 12, avgLatency: 340, errorRate: 0.02 },
    actual: { toolCallRate: 47, avgLatency: 890, errorRate: 0.18 },
  },
  {
    id: 'anom-002',
    agentId: 'agent:coder:live-002',
    type: 'token_spike',
    severity: 'MEDIUM',
    description: 'Coder token consumption 3.2x above baseline for code_write operations',
    detectedAt: '2026-05-22T14:30:00Z',
    acknowledged: true,
    baseline: { tokenRate: 45000, avgLatency: 2100, errorRate: 0.01 },
    actual: { tokenRate: 144000, avgLatency: 3800, errorRate: 0.03 },
  },
  {
    id: 'anom-003',
    agentId: 'agent:researcher:live-001',
    type: 'latency_anomaly',
    severity: 'LOW',
    description: 'Researcher research queries showing 2.1x latency increase vs baseline',
    detectedAt: '2026-05-22T16:00:00Z',
    acknowledged: false,
    baseline: { avgLatency: 1200, errorRate: 0.01 },
    actual: { avgLatency: 2520, errorRate: 0.02 },
  },
  {
    // CRITICAL is the only seed at the top of the ladder, and it is
    // deliberately UNACKNOWLEDGED. The canonical enum has 4 levels but the
    // original seed covered only 3, which left the CRITICAL branch of both
    // /api/anomalies/stats and /api/dashboard/summary completely unexercised:
    // a broken `severity === 'CRITICAL'` predicate there still reported 0 and
    // still satisfied a test that compared it against a recomputed 0. Seed
    // data exists to be exercised -- this record is what makes the top level
    // testable. (Card t_517be819.)
    id: 'anom-004',
    agentId: 'agent:writer:live-004',
    type: 'security_violation',
    severity: 'CRITICAL',
    description: 'Writer agent attempted to escalate clearance outside its authorisation scope',
    detectedAt: '2026-05-23T08:41:00Z',
    acknowledged: false,
    baseline: { unauthorizedCalls: 0, errorRate: 0.01 },
    actual: { unauthorizedCalls: 9, errorRate: 0.44 },
  },
];

// Normalise the seed data through the canonical contract at load time. The
// literals above are already canonical, so this is a no-op today -- it exists
// so that a future edit reintroducing 'high' or 'warning' is coerced at the
// boundary instead of silently reaching a consumer that cannot read it (the
// exact failure mode of card t_517be819). Mutated in place because every
// route below closes over this array.
for (const anomaly of anomalies) {
  anomaly.severity = normalizeAnomalies([anomaly])[0].severity;
}

// Audit trail data
const auditTrail = [
  {
    id: 'evt-001',
    type: 'agent_register',
    agentId: 'agent:researcher:live-001',
    decision: 'Registration approved',
    timestamp: '2026-05-22T18:45:00Z',
    details: { trustScore: 0.92, clearance: 'trusted', model: 'primary-model' },
  },
  {
    id: 'evt-002',
    type: 'policy_eval',
    agentId: 'agent:coder:live-002',
    decision: 'Tool call authorized',
    timestamp: '2026-05-22T19:00:00Z',
    details: { tool: 'code_write', policy: 'coder-allowlist', result: 'pass' },
  },
  {
    id: 'evt-003',
    type: 'anomaly_detected',
    agentId: 'agent:writer:live-004',
    decision: 'Agent suspended',
    timestamp: '2026-05-20T09:15:00Z',
    details: { anomaly: 'behavioral_deviation', action: 'auto_suspend' },
  },
  {
    id: 'evt-004',
    type: 'constraint_enforce',
    agentId: 'agent:coder:live-002',
    decision: 'Token rate limit applied',
    timestamp: '2026-05-22T14:35:00Z',
    details: { constraint: 'T2', limit: 100000, action: 'rate_limit' },
  },
  {
    id: 'evt-005',
    type: 'kill_switch',
    agentId: 'agent:writer:live-004',
    decision: 'Emergency revocation issued',
    timestamp: '2026-05-20T09:16:00Z',
    details: { reason: 'unauthorized_tool_access', propagation: 'raft_consensus' },
  },
  {
    id: 'evt-006',
    type: 'compliance_check',
    agentId: 'agent:architect:live-003',
    decision: 'SOC 2 control CC6.1 verified',
    timestamp: '2026-05-22T18:00:00Z',
    details: { framework: 'SOC 2', control: 'CC6.1', result: 'pass' },
  },
  {
    id: 'evt-007',
    type: 'credential_rotation',
    agentId: 'agent:auditor:live-006',
    decision: 'Credentials rotated successfully',
    timestamp: '2026-05-22T12:00:00Z',
    details: { previous: '***a7f2', current: '***d3c1', algorithm: 'sha256' },
  },
  {
    id: 'evt-008',
    type: 'routing_decision',
    agentId: 'agent:researcher:live-001',
    decision: 'Pheromone path selected: researcher → web_search',
    timestamp: '2026-05-22T18:50:00Z',
    details: { pheromoneWeight: 0.87, qualityScore: 0.92, route: 'researcher→web_search' },
  },
];

// Constraint enforcement data
const constraints = [
  { id: 'T0', name: 'Audit Trail', level: 'foundational', enforced: true, agents: allAgents.length },
  { id: 'T1', name: 'Crypto Identity', level: 'foundational', enforced: true, agents: allAgents.length },
  { id: 'T2', name: 'Guardrailed', level: 'operational', enforced: true, agents: 5 },
  { id: 'T3', name: 'Policy-Driven', level: 'advanced', enforced: false, agents: 3 },
  { id: 'T4', name: 'Autonomous', level: 'full-control', enforced: false, agents: 1 },
];

// ============================================================
// API Routes
// ============================================================

// --- Agents ---
app.get('/api/agents', (req, res) => {
  res.json(allAgents);
});

app.get('/api/agents/:id', (req, res) => {
  const agent = allAgents.find(a => a.id === req.params.id || a.agentId === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

app.get('/api/agents/:id/identity', (req, res) => {
  const agent = allAgents.find(a => a.id === req.params.id || a.agentId === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({
    agentId: agent.id,
    name: agent.name,
    type: agent.type,
    model: agent.model,
    version: agent.version,
    clearance: agent.clearance,
    credentials: agent.credentials,
    state: agent.state,
  });
});

app.get('/api/agents/:id/trust-score', (req, res) => {
  const agent = allAgents.find(a => a.id === req.params.id || a.agentId === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ agentId: agent.id, trustScore: agent.trustScore, updatedAt: agent.lastSeenAt });
});

app.get('/api/agents/:id/capabilities', (req, res) => {
  const agent = allAgents.find(a => a.id === req.params.id || a.agentId === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ agentId: agent.id, capabilities: agent.capabilities, clearance: agent.clearance });
});

// --- Constraints ---
app.get('/api/constraints', (req, res) => {
  res.json(constraints);
});

app.get('/api/agents/:agentId/constraints/status', (req, res) => {
  res.json({
    agentId: req.params.agentId,
    enforced: constraints.filter(c => c.enforced).map(c => c.id),
    pending: constraints.filter(c => !c.enforced).map(c => c.id),
    level: 'T2+',
  });
});

app.post('/api/agents/:agentId/constraints/:constraintId/enforce', (req, res) => {
  res.json({ agentId: req.params.agentId, constraintId: req.params.constraintId, status: 'enforced' });
});

// --- Kill Switch ---
app.post('/api/agents/:agentId/revoke', (req, res) => {
  const agent = allAgents.find(a => a.id === req.params.agentId || a.agentId === req.params.agentId);
  if (agent) {
    agent.state = 'revoked';
    agent.status = 'suspended';
  }
  res.json({ agentId: req.params.agentId, action: 'revoked', reason: req.body.reason || 'manual' });
});

app.post('/api/agents/:agentId/emergency-shutdown', (req, res) => {
  res.json({ agentId: req.params.agentId, action: 'emergency_shutdown', propagation: 'raft_consensus' });
});

app.post('/api/agents/bulk-revoke', (req, res) => {
  const ids = req.body.agentIds || [];
  ids.forEach(id => {
    const agent = allAgents.find(a => a.id === id || a.agentId === id);
    if (agent) { agent.state = 'revoked'; agent.status = 'suspended'; }
  });
  res.json({ revoked: ids.length, agentIds: ids });
});

app.get('/api/agents/revoked', (req, res) => {
  res.json(allAgents.filter(a => a.state === 'revoked' || a.status === 'suspended'));
});

app.post('/api/agents/:agentId/restore', (req, res) => {
  const agent = allAgents.find(a => a.id === req.params.agentId || a.agentId === req.params.agentId);
  if (agent) { agent.state = 'active'; agent.status = 'active'; }
  res.json({ agentId: req.params.agentId, action: 'restored' });
});

// --- Anomalies ---
// NOTE: /stats MUST come before /:id or it gets caught by the wildcard
app.get('/api/anomalies/stats', (req, res) => {
  // Keys are the canonical enum (card t_517be819). `critical` previously
  // counted severity === 'high' AND unacknowledged, which conflated the
  // top level with the second level and with ack state; it now means
  // exactly "CRITICAL, still unacknowledged", and the full per-level
  // breakdown is exposed under the same shape the UI counts.
  const counts = countBySeverity(anomalies);
  res.json({
    critical: anomalies.filter(a => a.severity === 'CRITICAL' && !a.acknowledged).length,
    total: counts.total,
    bySeverity: {
      CRITICAL: counts.CRITICAL,
      HIGH: counts.HIGH,
      MEDIUM: counts.MEDIUM,
      LOW: counts.LOW,
    },
    acknowledged: counts.acknowledged,
    unacknowledged: counts.total - counts.acknowledged,
  });
});

app.get('/api/anomalies', (req, res) => {
  res.json(anomalies);
});

app.get('/api/anomalies/:id', (req, res) => {
  const anomaly = anomalies.find(a => a.id === req.params.id);
  if (!anomaly) return res.status(404).json({ error: 'Anomaly not found' });
  res.json(anomaly);
});

app.get('/api/agents/:agentId/baseline', (req, res) => {
  const agentAnomalies = anomalies.filter(a => a.agentId === req.params.agentId);
  res.json({
    agentId: req.params.agentId,
    baseline: agentAnomalies[0]?.baseline || { toolCallRate: 10, avgLatency: 500, errorRate: 0.01 },
    updatedAt: new Date().toISOString(),
  });
});

app.post('/api/anomalies/:id/acknowledge', (req, res) => {
  const anomaly = anomalies.find(a => a.id === req.params.id);
  if (anomaly) anomaly.acknowledged = true;
  res.json({ anomalyId: req.params.id, acknowledged: true });
});

// --- Compliance ---
app.get('/api/compliance/coverage', (req, res) => {
  const totalPassing = complianceFrameworks.reduce((sum, f) => sum + f.controlsPassing, 0);
  const totalControls = complianceFrameworks.reduce((sum, f) => sum + f.controlsTotal, 0);
  res.json({
    overall: Math.round((totalPassing / totalControls) * 100),
    overallScore: Math.round((totalPassing / totalControls) * 100),
    frameworks: complianceFrameworks.map(f => ({
      id: f.id,
      name: f.name,
      status: f.status,
      score: Math.round((f.controlsPassing / f.controlsTotal) * 100),
    })),
  });
});

app.get('/api/compliance/frameworks', (req, res) => {
  res.json(complianceFrameworks);
});

app.get('/api/compliance/frameworks/:framework/evidence', (req, res) => {
  const fw = complianceFrameworks.find(f => f.id === req.params.framework);
  if (!fw) return res.status(404).json({ error: 'Framework not found' });
  res.json(fw.evidence);
});

app.get('/api/compliance/readiness', (req, res) => {
  res.json({
    overall: 'partial',
    frameworks: complianceFrameworks.map(f => ({
      id: f.id,
      name: f.name,
      status: f.status,
      readiness: Math.round((f.controlsPassing / f.controlsTotal) * 100),
    })),
  });
});

app.get('/api/compliance/reports/:id', (req, res) => {
  res.json({ reportId: req.params.id, generated: '2026-05-22T19:00:00Z', status: 'complete' });
});

// --- Audit Trail ---
app.get('/api/audit/trail', (req, res) => {
  res.json(auditTrail);
});

app.get('/api/agents/:agentId/audit', (req, res) => {
  res.json(auditTrail.filter(e => e.agentId === req.params.agentId));
});

app.get('/api/audit/decisions/:eventId/chain', (req, res) => {
  const event = auditTrail.find(e => e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json({
    eventId: req.params.eventId,
    chain: [
      { step: 1, type: 'request', timestamp: event.timestamp, details: event.details },
      { step: 2, type: 'decision', timestamp: event.timestamp, details: { decision: event.decision } },
      { step: 3, type: 'enforcement', timestamp: event.timestamp, details: { result: 'completed' } },
    ],
  });
});

app.get('/api/agents/:agentId/routing', (req, res) => {
  res.json(auditTrail.filter(e => e.agentId === req.params.agentId && e.type === 'routing_decision'));
});

// --- Dashboard Summary ---
app.get('/api/dashboard/summary', (req, res) => {
  const activeAgents = allAgents.filter(a => a.state === 'active').length;
  const criticalAlerts = anomalies.filter(a => a.severity === 'CRITICAL' && !a.acknowledged).length;
  const totalPassing = complianceFrameworks.reduce((sum, f) => sum + f.controlsPassing, 0);
  const totalControls = complianceFrameworks.reduce((sum, f) => sum + f.controlsTotal, 0);
  const enforcedLevel = 'T2+';

  res.json({
    activeAgents,
    totalAgents: allAgents.length,
    criticalAlerts,
    complianceScore: Math.round((totalPassing / totalControls) * 100),
    constraintsEnforced: enforcedLevel,
  });
});

// ============================================================
// Start Server
// ============================================================
// Only auto-listen when run directly (`node src/server.js`). Tests require this
// module and bind to an ephemeral port themselves (card t_517be819).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  AWARE API Server — Security Control Plane              ║
║  Listening on port ${PORT}                                ║
╠══════════════════════════════════════════════════════════╣
║  Agents:     ${allAgents.length} registered                        ║
║  Constraints: T0-T4 engine loaded                      ║
║  Compliance:  ${complianceFrameworks.length} frameworks loaded                       ║
║  Anomalies:  ${anomalies.length} active alerts                         ║
║  Audit:      ${auditTrail.length} trail entries                      ║
║  Kill Switch: Raft consensus ready                     ║
╚══════════════════════════════════════════════════════════╝
  `);
  });
}

module.exports = { app };
