// test/unit/acs/manifest.test.js
// ACS manifest import, export, `extends` resolution, and the round trip.
//
// THE ROUND TRIP
// --------------
// The task requires: "Round-trip test: AWARE -> ACS manifest -> AWARE must
// produce identical verdicts on the test corpus."
//
// So this suite:
//   1. exports AWARE's policy binding as an ACS manifest
//   2. parses that manifest back
//   3. validates it against the PINNED manifest schema
//   4. binds it to a fresh engine through the policy bridge
//   5. evaluates the SAME corpus and requires IDENTICAL verdicts
//
// The corpus is the point. A round trip over one case proves nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateManifest,
  exportManifest,
  parseManifest,
  loadManifestFile,
  mergeManifests,
  structurallyIdentical,
  hasAllowedRoot,
  resolveExtends,
  toYaml,
  AWARE_ADAPTER,
} = require('../../../src/acs/manifest');
const { AcsDecisionEngine } = require('../../../src/acs/decision-engine');
const { PolicyBridge } = require('../../../src/acs/policy-bridge');
const { getSchema } = require('../../../src/acs/schemas');
const { validate } = require('../../../src/acs/validator');

/**
 * The corpus the round trip runs over.
 *
 * Each entry is a policy decision the stub engine returns, so the corpus
 * exercises every verdict and every failure path.
 *
 * @returns {Array} The corpus.
 */
function corpus() {
  return [
    { label: 'allow', decision: 'ALLOW', reason: 'within policy' },
    { label: 'deny', decision: 'DENY', reason: 'blocked by policy' },
    { label: 'audit', decision: 'AUDIT', reason: 'noted for review' },
    { label: 'no_policy', decision: 'NO_POLICY', reason: 'no policy matched' },
    {
      label: 'transform',
      decision: 'ALLOW',
      reason: 'redacted',
      transform: { path: '$target.body', value: '[REDACTED]' },
    },
    {
      label: 'deny with approval',
      decision: 'DENY',
      reason: 'approval needed',
      requiresApproval: true,
    },
  ];
}

/**
 * A snapshot for the corpus.
 *
 * @returns {Object} The snapshot.
 */
function snapshot() {
  return {
    tool_call: { name: 'send_email', args: { to: 'customer@example.com', body: 'hello' } },
  };
}

/**
 * A policy input for the corpus.
 *
 * @returns {Object} The policy input.
 */
function policyInput() {
  return {
    intervention_point: 'pre_tool_call',
    policy_target: { kind: 'tool_args', path: '$snap.tool_call.args', value: { to: 'customer@example.com', body: 'hello' } },
    snapshot: snapshot(),
    annotations: {},
    tool: { name: 'send_email' },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test('acs manifest: the exported manifest validates against the PINNED manifest schema', () => {
  const manifest = exportManifest({ name: 'aware-policy', version: '1.0.0' });
  const result = validate(manifest, getSchema('manifest'));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('acs manifest: the exported manifest passes the adapter rules', () => {
  const manifest = exportManifest({ name: 'aware-policy' });
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('acs manifest: the exported manifest binds AWARE through the custom adapter', () => {
  const manifest = exportManifest({ name: 'aware-policy' });
  const policies = Object.values(manifest.policies);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].type, 'custom');
  assert.equal(policies[0].adapter, AWARE_ADAPTER);
});

test('acs manifest: the exported manifest binds the three enforced intervention points', () => {
  const manifest = exportManifest({});
  assert.deepEqual(
    Object.keys(manifest.intervention_points).sort(),
    ['output', 'post_tool_call', 'pre_tool_call'],
  );
});

test('acs manifest: the exported manifest renders as YAML and reparses to the same value', () => {
  const manifest = exportManifest({ name: 'aware-policy', version: '2.0.0' });
  const yaml = toYaml(manifest);
  const reparsed = parseManifest(yaml);
  assert.equal(reparsed.ok, true, JSON.stringify(reparsed.errors));
  assert.deepEqual(reparsed.manifest, manifest);
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

test('acs manifest: the upstream acs-email-tool manifest parses', () => {
  // The real manifest from microsoft/agent-governance-toolkit, reproduced
  // here so the suite does not depend on a checkout.
  const yaml = [
    'agent_control_specification_version: "0.4.0-alpha.1"',
    'metadata:',
    '  name: acs-email-tool',
    '  version: "0.1.0"',
    'extends: []',
    'policies:',
    '  email_policy:',
    '    type: custom',
    '    adapter: email_policy',
    'intervention_points:',
    '  pre_tool_call:',
    '    policy_target: $.tool_call.args',
    '    policy_target_kind: tool_args',
    '    tool_name_from: $.tool_call.name',
    '    policy:',
    '      id: email_policy',
    'tools:',
    '  send_email:',
    '    clearance: internal',
    '',
  ].join('\n');

  const parsed = parseManifest(yaml);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.manifest.agent_control_specification_version, '0.4.0-alpha.1');
  assert.equal(parsed.manifest.policies.email_policy.type, 'custom');
  assert.equal(parsed.manifest.intervention_points.pre_tool_call.policy_target, '$.tool_call.args');
  assert.equal(parsed.manifest.tools.send_email.clearance, 'internal');
});

test('acs manifest: a manifest naming an unknown adapter is REFUSED', () => {
  // Binding a manifest to the wrong engine is exactly the silent mismatch
  // that produces a wrong verdict. It must be refused, not ignored.
  const manifest = exportManifest({});
  manifest.policies.aware_policy.adapter = 'some_other_engine';
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path.endsWith('.adapter')));
});

test('acs manifest: a manifest binding an undefined policy is REFUSED', () => {
  const manifest = exportManifest({});
  manifest.intervention_points.pre_tool_call.policy.id = 'not_defined';
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes('not_defined')));
});

test('acs manifest: a manifest with a disallowed path root is REFUSED', () => {
  const manifest = exportManifest({});
  manifest.intervention_points.pre_tool_call.policy_target = '$pi.snapshot';
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path.includes('policy_target')));
});

test('acs manifest: a manifest with an unsupported spec version is REFUSED', () => {
  const manifest = exportManifest({});
  manifest.agent_control_specification_version = '9.9.9';
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path.includes('agent_control_specification_version')));
});

test('acs manifest: hasAllowedRoot enforces the documented roots', () => {
  assert.equal(hasAllowedRoot('$snap.tool_call.args', ['$snap', '$']), true);
  assert.equal(hasAllowedRoot('$.tool_call.args', ['$snap', '$']), true);
  assert.equal(hasAllowedRoot('$', ['$snap', '$']), true);
  assert.equal(hasAllowedRoot('$pi.snapshot', ['$snap', '$']), false);
  assert.equal(hasAllowedRoot('$target', ['$target']), true);
  assert.equal(hasAllowedRoot('$snap.x', ['$target']), false);
});

// ---------------------------------------------------------------------------
// The extends chain
// ---------------------------------------------------------------------------

test('acs manifest: a child manifest merges over a parent', () => {
  const parent = {
    agent_control_specification_version: '0.5.0-alpha.1',
    policies: { base: { type: 'custom', adapter: AWARE_ADAPTER } },
    intervention_points: { pre_tool_call: { policy_target: '$snap.tool_call.args', policy: { id: 'base' } } },
    tools: { t1: { clearance: 'internal' } },
  };
  const child = {
    agent_control_specification_version: '0.5.0-alpha.1',
    policies: { extra: { type: 'custom', adapter: AWARE_ADAPTER } },
    intervention_points: { output: { policy_target: '$snap.output', policy: { id: 'extra' } } },
    tools: { t2: { clearance: 'public' } },
  };

  const merged = mergeManifests(parent, child);
  assert.equal(merged.ok, true, JSON.stringify(merged.errors));
  assert.equal(Object.keys(merged.manifest.policies).length, 2);
  assert.equal(Object.keys(merged.manifest.intervention_points).length, 2);
  assert.equal(Object.keys(merged.manifest.tools).length, 2);
});

test('acs manifest: a conflicting intervention point is a MERGE CONFLICT', () => {
  // ACS SPEC section 2.2: a repeated binding must be structurally
  // identical. A difference is a merge conflict, not a silent override.
  const parent = {
    agent_control_specification_version: '0.5.0-alpha.1',
    intervention_points: { pre_tool_call: { policy_target: '$snap.tool_call.args', policy: { id: 'base' } } },
  };
  const child = {
    agent_control_specification_version: '0.5.0-alpha.1',
    intervention_points: { pre_tool_call: { policy_target: '$snap.other', policy: { id: 'base' } } },
  };

  const merged = mergeManifests(parent, child);
  assert.equal(merged.ok, false);
  assert.equal(merged.manifest, null);
  assert.ok(merged.errors.some((e) => e.path.includes('pre_tool_call')));
});

test('acs manifest: structurallyIdentical compares deeply', () => {
  assert.equal(structurallyIdentical({ a: [1, 2] }, { a: [1, 2] }), true);
  assert.equal(structurallyIdentical({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(structurallyIdentical({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(structurallyIdentical([], {}), false);
});

test('acs manifest: a local extends chain resolves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aware-acs-extends-'));
  const parentPath = path.join(dir, 'parent.yaml');
  fs.writeFileSync(parentPath, toYaml({
    agent_control_specification_version: '0.5.0-alpha.1',
    policies: { base: { type: 'custom', adapter: AWARE_ADAPTER } },
    intervention_points: { pre_tool_call: { policy_target: '$snap.tool_call.args', policy: { id: 'base' } } },
  }));
  const childPath = path.join(dir, 'child.yaml');
  fs.writeFileSync(childPath, toYaml({
    agent_control_specification_version: '0.5.0-alpha.1',
    extends: ['./parent.yaml'],
    policies: { extra: { type: 'custom', adapter: AWARE_ADAPTER } },
    intervention_points: { output: { policy_target: '$snap.output', policy: { id: 'extra' } } },
  }));

  const loaded = loadManifestFile(childPath);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));

  const resolved = await resolveExtends(loaded.manifest, { baseDir: dir });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors));
  assert.equal(Object.keys(resolved.manifest.policies).length, 2);
  assert.equal(Object.keys(resolved.manifest.intervention_points).length, 2);
});

test('acs manifest: an UNPINNED remote parent is REFUSED', async () => {
  // A remote parent with no pin cannot be verified. Fetching it would mean
  // trusting an unverifiable document, so it is refused.
  const manifest = {
    agent_control_specification_version: '0.5.0-alpha.1',
    extends: ['https://example.com/policy.yaml'],
    policies: { p: { type: 'custom', adapter: AWARE_ADAPTER } },
    intervention_points: { pre_tool_call: { policy_target: '$snap.tool_call.args', policy: { id: 'p' } } },
  };
  const resolved = await resolveExtends(manifest, {});
  assert.equal(resolved.ok, false);
  assert.ok(resolved.errors.some((e) => e.message.includes('pin')));
});

test('acs manifest: a remote parent with no fetcher is REFUSED', async () => {
  const manifest = {
    agent_control_specification_version: '0.5.0-alpha.1',
    extends: [{ url: 'https://example.com/policy.yaml', sha256: 'a'.repeat(64) }],
    policies: { p: { type: 'custom', adapter: AWARE_ADAPTER } },
    intervention_points: { pre_tool_call: { policy_target: '$snap.tool_call.args', policy: { id: 'p' } } },
  };
  const resolved = await resolveExtends(manifest, {});
  assert.equal(resolved.ok, false);
  assert.ok(resolved.errors.some((e) => e.message.includes('fetcher')));
});

test('acs manifest: an unreadable local parent is REFUSED', async () => {
  const manifest = {
    agent_control_specification_version: '0.5.0-alpha.1',
    extends: ['./no-such-file.yaml'],
    policies: { p: { type: 'custom', adapter: AWARE_ADAPTER } },
    intervention_points: { pre_tool_call: { policy_target: '$snap.tool_call.args', policy: { id: 'p' } } },
  };
  const resolved = await resolveExtends(manifest, { baseDir: '/tmp' });
  assert.equal(resolved.ok, false);
  assert.ok(resolved.errors.some((e) => e.message.includes('unreadable')));
});

test('acs manifest: an extends chain deeper than the limit is REFUSED', async () => {
  const manifest = {
    agent_control_specification_version: '0.5.0-alpha.1',
    extends: ['./a.yaml'],
    policies: { p: { type: 'custom', adapter: AWARE_ADAPTER } },
    intervention_points: { pre_tool_call: { policy_target: '$snap.tool_call.args', policy: { id: 'p' } } },
  };
  const resolved = await resolveExtends(manifest, { maxDepth: 0, baseDir: '/tmp' });
  assert.equal(resolved.ok, false);
  assert.ok(resolved.errors.some((e) => e.message.includes('deeper')));
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test('acs manifest ROUND TRIP: AWARE -> manifest -> AWARE gives IDENTICAL verdicts on the corpus', async () => {
  // The whole corpus, exported, re-imported and re-evaluated.
  const manifest = exportManifest({ name: 'round-trip' });

  // 1. The manifest validates against the pinned schema.
  const schemaResult = validate(manifest, getSchema('manifest'));
  assert.equal(schemaResult.valid, true, JSON.stringify(schemaResult.errors));

  // 2. It survives a YAML round trip.
  const reparsed = parseManifest(toYaml(manifest));
  assert.equal(reparsed.ok, true);
  const roundTripped = reparsed.manifest;

  // 3. It passes the adapter rules.
  assert.equal(validateManifest(roundTripped).ok, true);

  // 4. It binds to a fresh engine.
  const bridged = new PolicyBridge({
    manifest: roundTripped,
    engine: new AcsDecisionEngine({
      policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
      killSwitch: { isRevoked: () => false },
    }),
  });

  // 5. The corpus produces IDENTICAL verdicts before and after.
  for (const entry of corpus()) {
    const engine = new AcsDecisionEngine({
      policyEngine: { evaluate: () => ({ decision: entry.decision, reason: entry.reason, requiresApproval: entry.requiresApproval, transform: entry.transform }) },
      killSwitch: { isRevoked: () => false },
    });

    const direct = await engine.evaluate({
      policyInput: policyInput(),
      agentId: 'a1',
    });

    const bridgedEngine = new AcsDecisionEngine({
      policyEngine: { evaluate: () => ({ decision: entry.decision, reason: entry.reason, requiresApproval: entry.requiresApproval, transform: entry.transform }) },
      killSwitch: { isRevoked: () => false },
    });
    const throughManifest = await new PolicyBridge({
      manifest: roundTripped,
      engine: bridgedEngine,
    }).evaluate('pre_tool_call', snapshot(), { agentId: 'a1' });

    assert.equal(
      throughManifest.verdict.decision,
      direct.verdict.decision,
      `the ${entry.label} case must produce the same decision`,
    );
    assert.equal(
      throughManifest.verdict.reason,
      direct.verdict.reason,
      `the ${entry.label} case must produce the same reason`,
    );
  }
});

test('acs manifest: the bridge REFUSES a manifest binding an unenforced point', async () => {
  const manifest = exportManifest({ interventionPoints: ['agent_startup'] });
  const bridge = new PolicyBridge({
    manifest,
    engine: new AcsDecisionEngine({
      policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
      killSwitch: { isRevoked: () => false },
    }),
  });

  const compatibility = bridge.checkCompatibility();
  assert.equal(compatibility.ok, false);
  assert.equal(compatibility.reason, 'runtime_error:intervention_point_unknown');

  const result = await bridge.evaluate('pre_tool_call', snapshot(), { agentId: 'a1' });
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:intervention_point_unknown');
});

test('acs manifest: the bridge FAILS CLOSED when the manifest target does not resolve', async () => {
  const manifest = exportManifest({});
  manifest.intervention_points.pre_tool_call.policy_target = '$snap.tool_call.absent';

  const result = await new PolicyBridge({
    manifest,
    engine: new AcsDecisionEngine({
      policyEngine: { evaluate: () => ({ decision: 'ALLOW', reason: 'ok' }) },
      killSwitch: { isRevoked: () => false },
    }),
  }).evaluate('pre_tool_call', snapshot(), { agentId: 'a1' });

  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:path_missing');
});
