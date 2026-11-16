/**
 * AWARE extension contract — unit tests.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The failure this guards against is the one from the skill
 * "static-site-release-verification": a feature that is declared but never
 * called looks exactly like a feature that works. Every test here EXERCISES
 * the seam rather than asserting that a symbol exists.
 *
 * The last group is the important one. It drives the real PolicyEngine and
 * proves that a registered extension actually RECEIVES a decision, that it
 * cannot alter one, and that an engine with no registry behaves identically.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AWARE_EXTENSION_CONTRACT_VERSION,
  validateExtension,
  ExtensionRegistry,
  registry: globalRegistry,
} = require('../../../src/extension');

const { PolicyEngine } = require('../../../src/policies/engine');
const { getPolicyStore } = require('../../../src/policies/store');

// The policy store is a SINGLETON (src/policies/store.js:408) whose auto-
// backup interval is started when it is first constructed. Constructing a
// PolicyEngine constructs it. The store exposes stop() (store.js:166) for
// exactly this purpose, and the repo's existing tests use the same pattern
// for their timers (test/unit/coordinator/lora-reloader.test.js).
//
// The interval is also unref'd at the source, so this cleanup is belt and
// braces rather than the only defence.
test.after(() => {
  try {
    getPolicyStore().stop();
  } catch (_e) {
    // The store may never have been constructed. Nothing to clean up.
  }
});

// ── contract version ───────────────────────────────────────────────────────

test('contract version is a positive integer', () => {
  assert.equal(typeof AWARE_EXTENSION_CONTRACT_VERSION, 'number');
  assert.ok(AWARE_EXTENSION_CONTRACT_VERSION > 0);
  assert.ok(Number.isInteger(AWARE_EXTENSION_CONTRACT_VERSION));
});

// ── validation ─────────────────────────────────────────────────────────────

test('validateExtension accepts a minimal conforming extension', () => {
  const { valid, problems } = validateExtension({
    onDecision() {},
    onAuditAppend() {},
  });
  assert.deepEqual(problems, []);
  assert.equal(valid, true);
});

test('validateExtension rejects an extension missing a required method', () => {
  const { valid, problems } = validateExtension({ onDecision() {} });
  assert.equal(valid, false);
  assert.match(problems.join(' '), /onAuditAppend/);
});

test('validateExtension rejects a non-object', () => {
  for (const bad of [null, undefined, 'nope', 42]) {
    assert.equal(validateExtension(bad).valid, false);
  }
});

test('validateExtension rejects an optional method that is not a function', () => {
  const { valid, problems } = validateExtension({
    onDecision() {},
    onAuditAppend() {},
    onShutdown: 'not a function',
  });
  assert.equal(valid, false);
  assert.match(problems.join(' '), /onShutdown/);
});

test('validateExtension rejects a mismatched contract version', () => {
  const { valid, problems } = validateExtension({
    onDecision() {},
    onAuditAppend() {},
    contractVersion: AWARE_EXTENSION_CONTRACT_VERSION + 1,
  });
  assert.equal(valid, false);
  assert.match(problems.join(' '), /contract version/i);
});

// ── registry delivery ──────────────────────────────────────────────────────

test('registry delivers an event to every registered extension', async () => {
  const reg = new ExtensionRegistry();
  let aCount = 0;
  let bCount = 0;
  reg.register({ name: 'a', onDecision: () => { aCount += 1; }, onAuditAppend() {} });
  reg.register({ name: 'b', onDecision: () => { bCount += 1; }, onAuditAppend() {} });

  const result = await reg.dispatch('onDecision', { decision: 'ALLOW' });

  assert.equal(result.delivered, 2);
  assert.equal(result.failed, 0);
  assert.equal(aCount, 1);
  assert.equal(bCount, 1);
});

test('registry passes the event argument through', async () => {
  const reg = new ExtensionRegistry();
  let seen = null;
  reg.register({ name: 'capture', onDecision: (evt) => { seen = evt; }, onAuditAppend() {} });
  await reg.dispatch('onDecision', { request: { tool: 'read' }, decision: { decision: 'DENY' } });
  assert.equal(seen.decision.decision, 'DENY');
  assert.equal(seen.request.tool, 'read');
});

test('registry skips an extension that does not implement an optional method', async () => {
  const reg = new ExtensionRegistry();
  reg.register({ name: 'minimal', onDecision() {}, onAuditAppend() {} });
  const result = await reg.dispatch('onShutdown');
  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 0);
});

test('registry CONTAINS a throwing extension without failing the dispatch', async () => {
  const reg = new ExtensionRegistry();
  let goodCalled = 0;
  reg.register({
    name: 'broken',
    onDecision() { throw new Error('extension exploded'); },
    onAuditAppend() {},
  });
  reg.register({ name: 'good', onDecision: () => { goodCalled += 1; }, onAuditAppend() {} });

  const result = await reg.dispatch('onDecision', {});

  assert.equal(goodCalled, 1, 'the healthy extension must still receive the event');
  assert.equal(result.failed, 1);
  assert.equal(result.delivered, 1);

  const failures = reg.getFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].extension, 'broken');
  assert.match(failures[0].error, /extension exploded/);
});

test('a throwing extension never propagates out of dispatch', async () => {
  const reg = new ExtensionRegistry();
  reg.register({
    name: 'broken',
    onDecision() { throw new Error('boom'); },
    onAuditAppend() { throw new Error('boom'); },
  });
  await reg.dispatch('onDecision', {});
  await reg.dispatch('onAuditAppend', {});
});

test('registry refuses to register an invalid extension', () => {
  const reg = new ExtensionRegistry();
  const result = reg.register({ onDecision() {} });
  assert.equal(result.ok, false);
  assert.equal(result.name, null);
  assert.equal(reg.size, 0);
});

test('registry unregisters by name', () => {
  const reg = new ExtensionRegistry();
  reg.register({ name: 'x', onDecision() {}, onAuditAppend() {} });
  assert.equal(reg.size, 1);
  assert.equal(reg.unregister('x'), true);
  assert.equal(reg.size, 0);
  assert.equal(reg.unregister('x'), false);
});

test('registry rejects an unknown dispatch method', async () => {
  const reg = new ExtensionRegistry();
  await assert.rejects(
    () => reg.dispatch('onSomethingElse', {}),
    /unknown extension method/
  );
});

test('registry exposes the contract version', () => {
  const reg = new ExtensionRegistry();
  assert.equal(reg.contractVersion, AWARE_EXTENSION_CONTRACT_VERSION);
});

test('a process-wide registry is exposed', () => {
  assert.ok(globalRegistry instanceof ExtensionRegistry);
});

// ── engine integration: the extension point is EXERCISED ──────────────────

test('a registered extension RECEIVES a decision from the real engine', async () => {
  const reg = new ExtensionRegistry();
  const seen = [];
  reg.register({
    name: 'probe',
    onDecision: (evt) => { seen.push(evt); },
    onAuditAppend() {},
  });

  const engine = new PolicyEngine({ extensions: reg });
  const result = engine.evaluate({ agentId: 'test-agent', tool: 'unknown-tool-xyz' });

  assert.ok(result, 'the engine must still return a decision');
  assert.ok(result.decision, 'the decision must have a verdict');

  // The dispatch is fire-and-forget. Let the microtask queue drain.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(seen.length, 1, 'the extension must have received the decision');
  assert.deepEqual(seen[0].decision, result);
  assert.equal(seen[0].request.tool, 'unknown-tool-xyz');
});

test('an extension CANNOT change the decision', async () => {
  const reg = new ExtensionRegistry();
  reg.register({
    name: 'mutator',
    // Deliberately tries to rewrite the verdict.
    onDecision: (evt) => {
      evt.decision.decision = 'ALLOW';
      evt.decision.reason = 'hacked';
    },
    onAuditAppend() {},
  });

  const engine = new PolicyEngine({ extensions: reg });
  const result = engine.evaluate({ agentId: 'test-agent', tool: 'unknown-tool-xyz' });

  // An unknown tool must not be allowed. An extension must not be able to
  // flip that, even by mutating the object it is handed.
  assert.notEqual(result.decision, 'ALLOW');
  assert.notEqual(result.reason, 'hacked');
});

test('a throwing extension CANNOT break a decision', () => {
  const reg = new ExtensionRegistry();
  reg.register({
    name: 'broken',
    onDecision() { throw new Error('boom'); },
    onAuditAppend() { throw new Error('boom'); },
  });

  const engine = new PolicyEngine({ extensions: reg });
  let result;
  assert.doesNotThrow(() => {
    result = engine.evaluate({ agentId: 'test-agent', tool: 'unknown-tool-xyz' });
  });
  assert.ok(result.decision);
});

test('an engine with an EMPTY registry behaves exactly as one with none', () => {
  const withEmptyRegistry = new PolicyEngine({ extensions: new ExtensionRegistry() });
  const without = new PolicyEngine();
  const req = { agentId: 'test-agent', tool: 'unknown-tool-xyz' };
  assert.deepEqual(withEmptyRegistry.evaluate(req), without.evaluate(req));
});

test('an engine with no registry exposes the untouched evaluate', () => {
  const engine = new PolicyEngine();
  assert.equal(engine.extensions, null);
});
