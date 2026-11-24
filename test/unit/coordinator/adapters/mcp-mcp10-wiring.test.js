// SPDX-License-Identifier: Apache-2.0
// test/unit/coordinator/adapters/mcp-mcp10-wiring.test.js
//
// AC4 of t_0cb12b17: the OWASP MCP Top 10 classifier must be WIRED into the
// MCP adapter, so that every `mcp_message` source event feeds through
// `classifyAndLog` and the MCP01..MCP10 annotations reach the audit chain.
//
// Before this wiring the classifier module existed and was fully tested, but
// nothing ever called it — it was dead code. These tests pin the wiring, and
// — importantly — pin that it is NON-VACUOUS: the assertions are about
// annotations actually reaching the audit logger, not merely that a function
// was invoked.
//
// node:test + node:assert to match the rest of test/unit/**/*.test.js.
// A fake audit logger is injected via the auditLogger option so tests do
// NOT touch /data/audit/decision-chain.jsonl on disk.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { MCPAdapter } = require('../../../../src/coordinator/adapters/mcp');

/**
 * A fake audit logger that records every decision it is handed.
 */
function fakeLogger() {
  const written = [];
  return {
    written,
    async logDecision(record) {
      written.push(record);
      return { ok: true };
    },
  };
}

/**
 * A `tools/call` envelope whose params carry a credential — the shape the
 * `credential-in-tool-parameters` rule (MCP01) fires on.
 */
function credentialEnvelope() {
  return {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'read_file',
      arguments: {
        path: '/tmp/x',
        token: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
      },
    },
  };
}

test('AC4: an mcp_message emit writes an MCP10 annotation alongside the source event', async () => {
  const logger = fakeLogger();
  const adapter = new MCPAdapter({ auditLogger: logger });

  const res = await adapter.emitMessage(credentialEnvelope(), {
    agentId: 'test-agent',
  });

  assert.strictEqual(res.ok, true, 'the source event must be accepted');

  const annotations = logger.written.filter(
    (r) => r && r.action && r.action.type === 'mcp10_annotation'
  );
  assert.ok(
    annotations.length > 0,
    'no mcp10_annotation was written — the classifier is NOT wired into the emit path'
  );

  const ann = annotations[0].action.annotation;
  assert.ok(
    ann.classes.includes('MCP01'),
    `expected the MCP01 class on a credential rule, got ${JSON.stringify(ann.classes)}`
  );
  assert.strictEqual(ann.rule, 'credential-in-tool-parameters');
});

test('AC4: the annotation chains under the source event decision id', async () => {
  const logger = fakeLogger();
  const adapter = new MCPAdapter({ auditLogger: logger });

  await adapter.emitMessage(credentialEnvelope(), { agentId: 'test-agent' });

  const source = logger.written.find(
    (r) => r && r.action && r.action.type === 'mcp_message'
  );
  const annotation = logger.written.find(
    (r) => r && r.action && r.action.type === 'mcp10_annotation'
  );

  assert.ok(source, 'the source mcp_message event was not written');
  assert.ok(annotation, 'the annotation was not written');
  assert.strictEqual(
    annotation.parentDecisionId,
    source.decisionId,
    'the annotation must chain under the source decision id'
  );
});

test('AC4: a benign message produces the source event and NO annotation', async () => {
  const logger = fakeLogger();
  const adapter = new MCPAdapter({ auditLogger: logger });

  await adapter.emitMessage(
    { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} },
    { agentId: 'test-agent' }
  );

  const annotations = logger.written.filter(
    (r) => r && r.action && r.action.type === 'mcp10_annotation'
  );
  assert.strictEqual(
    annotations.length,
    0,
    'a benign tools/list message must not produce an annotation'
  );
  assert.ok(
    logger.written.some((r) => r.action && r.action.type === 'mcp_message'),
    'the source event must still be written'
  );
});

test('AC4: the classifier is fail-open — a classifier failure never fails the emit', async () => {
  const logger = fakeLogger();
  const adapter = new MCPAdapter({ auditLogger: logger });

  // Force the classifier path to blow up: the adapter's own method is
  // replaced so the emit path's fail-open branch is exercised.
  adapter._classifyAndAnnotate = async () => {
    throw new Error('classifier exploded');
  };

  // The adapter awaits the classifier INSIDE the try that catches
  // logDecision errors. A classifier throw must therefore be contained by
  // the adapter, not escape to the caller.
  const res = await adapter.emitMessage(credentialEnvelope(), {
    agentId: 'test-agent',
  });

  assert.ok(
    res && res.record,
    'emitMessage must still return a record even when the classifier throws'
  );
});

test('AC4: enableClassifierWrites=false suppresses annotation writes', async () => {
  const logger = fakeLogger();
  const adapter = new MCPAdapter({
    auditLogger: logger,
    enableClassifierWrites: false,
  });

  await adapter.emitMessage(credentialEnvelope(), { agentId: 'test-agent' });

  const annotations = logger.written.filter(
    (r) => r && r.action && r.action.type === 'mcp10_annotation'
  );
  assert.strictEqual(
    annotations.length,
    0,
    'writes must be suppressed when enableClassifierWrites is false'
  );
});
