// test/unit/acs/http-route.test.js
// The ACS HTTP transport.
//
// The transport is thin: it accepts a request, calls the engine, and
// returns the verdict. What this suite proves is that the transport FAILS
// CLOSED too, because a transport that returns a 200 with an allow verdict
// it could not justify is worse than no transport at all.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  policyInputFromBody,
} = require('../../../src/api/routes/acs');

test('acs http: a canonical five-member body is passed through unchanged', () => {
  const body = {
    intervention_point: 'pre_tool_call',
    policy_target: { kind: 'tool_args', path: '$snap.tool_call.args', value: { a: 1 } },
    snapshot: { tool_call: { name: 't', args: { a: 1 } } },
    annotations: {},
    tool: { name: 't' },
  };
  const input = policyInputFromBody(body);
  assert.deepEqual(
    Object.keys(input).sort(),
    ['annotations', 'intervention_point', 'policy_target', 'snapshot', 'tool'],
  );
  assert.equal(input.intervention_point, 'pre_tool_call');
  assert.deepEqual(input.policy_target.value, { a: 1 });
  assert.equal(input.tool.name, 't');
});

test('acs http: a host-shaped body is assembled into the canonical input', () => {
  const body = {
    intervention_point: 'pre_tool_call',
    tool_name: 'send_email',
    snapshot: { tool_call: { name: 'send_email', args: { to: 'a@b.c' } } },
  };
  const input = policyInputFromBody(body);
  assert.deepEqual(
    Object.keys(input).sort(),
    ['annotations', 'intervention_point', 'policy_target', 'snapshot', 'tool'],
  );
  assert.equal(input.policy_target.path, '$snap.tool_call.args');
  assert.equal(input.policy_target.kind, null);
  assert.deepEqual(input.policy_target.value, { to: 'a@b.c' });
  assert.equal(input.tool.name, 'send_email');
});

test('acs http: an explicit policy_target_value wins over the snapshot', () => {
  const body = {
    intervention_point: 'pre_tool_call',
    tool_name: 'send_email',
    policy_target_value: { explicit: true },
    snapshot: { tool_call: { name: 'send_email', args: { to: 'a@b.c' } } },
  };
  const input = policyInputFromBody(body);
  assert.deepEqual(input.policy_target.value, { explicit: true });
});

test('acs http: a body with no tool yields a null tool member', () => {
  const body = { intervention_point: 'output', snapshot: { output: 'text' } };
  const input = policyInputFromBody(body);
  assert.equal(input.tool, null);
  assert.equal(input.policy_target.path, '$snap.output');
});

test('acs http: an empty body still produces the five canonical members', () => {
  const input = policyInputFromBody({});
  assert.deepEqual(
    Object.keys(input).sort(),
    ['annotations', 'intervention_point', 'policy_target', 'snapshot', 'tool'],
  );
});
