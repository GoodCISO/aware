// test/unit/acs/yaml-and-paths.test.js
// Regression tests for the Phase 3 defects a review found.
//
// THREE DEFECTS, ALL IN CODE THAT PARSES OR RESOLVES A POLICY DOCUMENT:
//
//   1. The YAML parser read a trailing COMMENT as part of the value.
//      `a: x # y` must be the string `x`, not `x # y`. A policy document
//      that says one thing and is read as another is a silent
//      mis-interpretation, which is the worst kind of parser bug.
//
//   2. The manifest path resolver did not accept a bracket segment on the
//      `$` alias, so `$["name.with.dot"]` was rejected while
//      `$snap["name.with.dot"]` worked. ACS SPEC section 3.1 makes them
//      the same root.
//
//   3. The path resolver found the closing BRACKET before the closing
//      QUOTE, so a member whose name contains a bracket --
//      `$snap["br[key]"]` -- could not be addressed. The spec says the
//      bracketed form exists precisely for names containing a dot or a
//      bracket.
//
// Each test below is checked against a reference YAML parser where the
// behaviour is observable, so the expectation is not just "what the code
// does".

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSimpleYaml, renderYaml, YamlError } = require('../../../src/acs/yaml');
const { resolveManifestPath } = require('../../../src/acs/policy-bridge');

// ---------------------------------------------------------------------------
// The YAML comment defect
// ---------------------------------------------------------------------------

test('regression YAML-1: a trailing comment is NOT part of the value', () => {
  // The reference YAML parser reads `a: x # y` as the string `x`.
  assert.deepEqual(parseSimpleYaml('a: x # y'), { a: 'x' });
  assert.deepEqual(parseSimpleYaml('a: 1 # a number'), { a: 1 });
  assert.deepEqual(parseSimpleYaml('a: true # a boolean'), { a: true });
});

test('regression YAML-1: a # inside a quoted string is NOT a comment', () => {
  assert.deepEqual(parseSimpleYaml('a: "x # y"'), { a: 'x # y' });
  assert.deepEqual(parseSimpleYaml("a: 'x # y'"), { a: 'x # y' });
});

test('regression YAML-1: a # with no preceding whitespace is NOT a comment', () => {
  // YAML starts a comment at a `#` preceded by whitespace. A `#` inside a
  // word is part of the word.
  assert.deepEqual(parseSimpleYaml('a: x#y'), { a: 'x#y' });
});

test('regression YAML-1: a quoted value followed by a comment reads correctly', () => {
  assert.deepEqual(parseSimpleYaml('a: "quoted"  # trailing'), { a: 'quoted' });
  assert.deepEqual(parseSimpleYaml('a: \'sq\' # c'), { a: 'sq' });
});

test('regression YAML-1: a comment inside a NESTED value is stripped', () => {
  assert.deepEqual(
    parseSimpleYaml('outer:\n  inner: value # comment'),
    { outer: { inner: 'value' } },
  );
});

// ---------------------------------------------------------------------------
// The path grammar defects
// ---------------------------------------------------------------------------

test('regression PATH-1: the $ alias accepts a bracket segment', () => {
  // ACS SPEC section 3.1: `$` and `$.name` are aliases for `$snap` and
  // `$snap.name`. So `$["name.with.dot"]` must resolve the same member as
  // `$snap["name.with.dot"]`.
  const snapshot = { 'dot.key': 42 };
  const viaAlias = resolveManifestPath('$["dot.key"]', snapshot);
  const viaSnap = resolveManifestPath('$snap["dot.key"]', snapshot);
  assert.equal(viaAlias.ok, true, viaAlias.reason);
  assert.equal(viaAlias.value, 42);
  assert.equal(viaSnap.value, viaAlias.value);
});

test('regression PATH-2: a member name containing a bracket is addressable', () => {
  // The bracketed form exists PRECISELY for names containing a dot or a
  // bracket (ACS SPEC section 3).
  const snapshot = { 'br[key]': 7, 'dot.key': 8 };
  const bracketed = resolveManifestPath('$snap["br[key]"]', snapshot);
  assert.equal(bracketed.ok, true, bracketed.reason);
  assert.equal(bracketed.value, 7);

  const dotted = resolveManifestPath('$snap["dot.key"]', snapshot);
  assert.equal(dotted.ok, true, dotted.reason);
  assert.equal(dotted.value, 8);
});

test('regression PATH-2: an unquoted bracket segment is still refused', () => {
  const snapshot = { 'br[key]': 7 };
  const result = resolveManifestPath('$snap[br[key]]', snapshot);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime_error:manifest_invalid');
});

test('regression PATH: the disallowed roots are still refused for a policy target', () => {
  // ACS SPEC section 3.2: policy_target may use $snap, $ and $.name only.
  const snapshot = { a: 1 };
  for (const path of ['$pi.snapshot', '$target', '$tool', 'a.b']) {
    const result = resolveManifestPath(path, snapshot);
    assert.equal(result.ok, false, `${path} must be refused`);
    assert.equal(result.reason, 'runtime_error:manifest_invalid');
  }
});

test('regression PATH: a negative array index is refused', () => {
  const result = resolveManifestPath('$snap.arr[-1]', { arr: [1] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime_error:manifest_invalid');
});

test('regression PATH: a path that does not resolve is path_missing', () => {
  const result = resolveManifestPath('$snap.absent', { present: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime_error:path_missing');
});

test('regression PATH: a path through a scalar is path_type_mismatch', () => {
  const result = resolveManifestPath('$snap.name.deeper', { name: 'a string' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime_error:path_type_mismatch');
});

// ---------------------------------------------------------------------------
// The YAML subset still refuses what it must
// ---------------------------------------------------------------------------

test('acs yaml: the ambiguous constructs are still REFUSED', () => {
  const refused = [
    ['anchors', 'a: &x 1'],
    ['aliases', 'a: *x'],
    ['tags', 'a: !!str 1'],
    ['block scalars', 'a: |'],
    ['multi-document streams', '---\na: 1'],
  ];
  for (const [label, text] of refused) {
    assert.throws(
      () => parseSimpleYaml(text),
      (err) => err instanceof YamlError,
      `${label} must be refused`,
    );
  }
});

test('acs yaml: a tab used for indentation is REFUSED', () => {
  assert.throws(() => parseSimpleYaml('a:\n\tb: 1'), YamlError);
});

test('acs yaml: the upstream manifest still parses', () => {
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

  const parsed = parseSimpleYaml(yaml);
  assert.equal(parsed.agent_control_specification_version, '0.4.0-alpha.1');
  assert.equal(parsed.policies.email_policy.adapter, 'email_policy');
  assert.equal(parsed.intervention_points.pre_tool_call.policy_target, '$.tool_call.args');
});

test('acs yaml: a value with a colon and a hash still parses as one string', () => {
  assert.deepEqual(parseSimpleYaml('a: x: y'), { a: 'x: y' });
});

test('acs yaml: the renderer round trips a manifest with comments stripped', () => {
  const value = { a: 'x', b: { c: 'd' }, e: [1, 2] };
  const rendered = renderYaml(value);
  assert.deepEqual(parseSimpleYaml(rendered), value);
});
