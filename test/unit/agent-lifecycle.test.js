/**
 * Regression tests for the two agent-lifecycle defects fixed in 2.12.3.
 *
 * 1. A revoked agent had no path back to ACTIVE, so reinstatement always
 *    failed. `Agent.transitionTo` allowed only REVOKED -> DECOMMISSIONED.
 * 2. `registry.verify()` compared `agent.credentials.current` (a PBKDF2
 *    hash) against the raw credential, so it could never succeed.
 *
 * See Gitea issues #22 and #23.
 *
 * Isolation: `Agent.js` hardcodes its store path to `src/data/agents.json`
 * at module load, and that file is gitignored runtime state. These tests
 * therefore shim `fs.readFileSync` / `fs.writeFileSync` to redirect every
 * `data/agents.json` access to a temp file — the same pattern used by
 * `test/unit/compliance/admissible-intervention.test.js`. The repository's
 * own runtime data file is never read or written.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.join(__dirname, '..', '..');
const AGENT_MODEL = path.join(REPO_ROOT, 'src', 'api', 'models', 'Agent.js');
const REGISTRY = path.join(REPO_ROOT, 'src', 'agents', 'registry.js');

// The Agent model derives its pepper from AWARE_CREDENTIAL_PEPPER or
// SECRET_KEY and calls process.exit(1) if neither is present.
process.env.AWARE_CREDENTIAL_PEPPER=process.env.AWARE_CREDENTIAL_PEPPER
  || 'test-pepper-for-agent-lifecycle-regression-tests';

// Redirect the agents store to a temp file before the model is required.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aware-agent-lifecycle-'));
const TMP_AGENTS = path.join(TMP_DIR, 'agents.json');
fs.writeFileSync(TMP_AGENTS, JSON.stringify({ agents: [] }, null, 2));

const origReadFileSync = fs.readFileSync;
const origWriteFileSync = fs.writeFileSync;

fs.readFileSync = function (p, ...rest) {
  if (typeof p === 'string' && p.endsWith('data/agents.json')) {
    return origReadFileSync.call(fs, TMP_AGENTS, ...rest);
  }
  return origReadFileSync.call(fs, p, ...rest);
};

fs.writeFileSync = function (p, ...rest) {
  if (typeof p === 'string' && p.endsWith('data/agents.json')) {
    return origWriteFileSync.call(fs, TMP_AGENTS, ...rest);
  }
  return origWriteFileSync.call(fs, p, ...rest);
};

const { Agent, AgentState } = require(AGENT_MODEL);
const AgentRegistry = require(REGISTRY);
const registry = new AgentRegistry();

test.after(() => {
  fs.readFileSync = origReadFileSync;
  fs.writeFileSync = origWriteFileSync;
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function freshAgent(agentId, overrides = {}) {
  return new Agent({
    agentId,
    name: `Test ${agentId}`,
    type: 'worker',
    ...overrides,
  });
}

test('REVOKED -> ACTIVE is an allowed transition', () => {
  const agent = freshAgent('agent:test:revive');
  agent.state = AgentState.REVOKED;

  assert.doesNotThrow(
    () => agent.transitionTo(AgentState.ACTIVE),
    'a revoked agent must be able to return to ACTIVE',
  );
  assert.strictEqual(agent.state, AgentState.ACTIVE);
});

test('REVOKED -> DECOMMISSIONED remains allowed', () => {
  const agent = freshAgent('agent:test:decommission');
  agent.state = AgentState.REVOKED;

  assert.doesNotThrow(() => agent.transitionTo(AgentState.DECOMMISSIONED));
  assert.strictEqual(agent.state, AgentState.DECOMMISSIONED);
});

test('DECOMMISSIONED remains terminal', () => {
  const agent = freshAgent('agent:test:terminal');
  agent.state = AgentState.DECOMMISSIONED;

  assert.throws(
    () => agent.transitionTo(AgentState.ACTIVE),
    /Invalid state transition/,
  );
});

test('SUSPENDED -> ACTIVE still works', () => {
  const agent = freshAgent('agent:test:unsuspend');
  agent.state = AgentState.SUSPENDED;

  assert.doesNotThrow(() => agent.transitionTo(AgentState.ACTIVE));
  assert.strictEqual(agent.state, AgentState.ACTIVE);
});

test('registry.verify accepts the correct raw credential', () => {
  const agent = freshAgent('agent:test:verify');
  const raw = agent.generateCredential();
  agent.state = AgentState.ACTIVE;
  Agent.saveAgent(agent);

  const result = registry.verify(agent.agentId, raw);

  assert.strictEqual(
    result.valid,
    true,
    `expected a correct credential to verify, got ${JSON.stringify(result)}`,
  );
  assert.strictEqual(result.agentId, agent.agentId);
});

test('registry.verify rejects an incorrect credential', () => {
  const agent = freshAgent('agent:test:verify-bad');
  agent.generateCredential();
  agent.state = AgentState.ACTIVE;
  Agent.saveAgent(agent);

  const result = registry.verify(agent.agentId, 'not-the-credential');

  assert.strictEqual(result.valid, false);
});

test('registry.verify rejects a correct credential on a non-ACTIVE agent', () => {
  const agent = freshAgent('agent:test:verify-suspended');
  const raw = agent.generateCredential();
  agent.state = AgentState.SUSPENDED;
  Agent.saveAgent(agent);

  const result = registry.verify(agent.agentId, raw);

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.state, AgentState.SUSPENDED);
});

test('registry.verify reports an unknown agent', () => {
  const result = registry.verify('agent:test:does-not-exist', 'anything');

  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error, 'Agent not found');
});

test('the stored credential is a hash, not the raw secret', () => {
  const agent = freshAgent('agent:test:hash-shape');
  const raw = agent.generateCredential();

  assert.notStrictEqual(
    agent.credentials.current,
    raw,
    'credentials.current must not hold the raw credential',
  );
  assert.match(agent.credentials.current, /^[0-9a-f]+:[0-9a-f]+$/);
});

test('the repository runtime data file is untouched by this suite', () => {
  const repoAgents = path.join(REPO_ROOT, 'src', 'data', 'agents.json');
  const raw = origReadFileSync.call(fs, repoAgents, 'utf8');
  const parsed = JSON.parse(raw);
  const ids = parsed.agents.map((a) => a.agentId);

  assert.ok(
    !ids.some((id) => id && id.startsWith('agent:test:')),
    `test agents leaked into the repo data file: ${ids.join(', ')}`,
  );
});
