// test/unit/acs/transform.test.js
// The $target-rooted transform.
//
// THE RULES BEING TESTED
// -----------------------
// ACS SPEC section 3.2: a transform path MUST be rooted at $target.
//
//   "A `transform` path MUST be rooted at `$target`. The pre-0.4
//   `$policy_target` root names the same value under a retired spelling and
//   MUST fail closed with `runtime_error:transform_invalid`; a path rooted
//   anywhere else MUST fail closed with
//   `runtime_error:transform_target_forbidden`."
//
// ACS SPEC section 14 adds:
//   - a path under $target that cannot be parsed -> transform_invalid
//   - a missing path or value member             -> policy_output_invalid
//   - a path that does not resolve against the policy target -> found when
//     the HOST applies the transform
//
// The two roots get DIFFERENT reserved reasons. That distinction is the
// whole point of this suite: a retired root is a malformed path, and any
// other root is a forbidden one.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateTransformPath,
  resolveTransform,
  applyTransform,
  parseSegments,
} = require('../../../src/acs/transform');

test('acs transform: a $target path is accepted', () => {
  const result = validateTransformPath('$target.body');
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, ['body']);
});

test('acs transform: the bare $target root is accepted', () => {
  const result = validateTransformPath('$target');
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, []);
});

test('acs transform: a nested path is accepted', () => {
  const result = validateTransformPath('$target.user.email');
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, ['user', 'email']);
});

test('acs transform: an array index segment is accepted', () => {
  const result = validateTransformPath('$target.items[0].name');
  assert.equal(result.ok, true);
  assert.deepEqual(result.segments, ['items', 0, 'name']);
});

test('acs transform: the RETIRED $policy_target root fails closed with transform_invalid', () => {
  // This is the root AGT's shipped acs-email-tool example uses. Under the
  // pinned spec it MUST fail closed. See docs/acs/DESIGN.md finding F-2.
  const result = validateTransformPath('$policy_target.body');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime_error:transform_invalid');
});

test('acs transform: any other root fails closed with transform_target_forbidden', () => {
  for (const path of [
    '$snap.tool_call.args',
    '$pi.snapshot',
    '$tool',
    '$.tool_call',
    'tool_call.args',
    '$targetfoo.body',
  ]) {
    const result = validateTransformPath(path);
    assert.equal(result.ok, false, `${path} must be rejected`);
    assert.equal(
      result.reason,
      'runtime_error:transform_target_forbidden',
      `${path} must use the forbidden-root reason`,
    );
  }
});

test('acs transform: an unparsable path under $target fails closed with transform_invalid', () => {
  for (const path of ['$target.', '$target[', '$target[]', '$target[-1]']) {
    const result = validateTransformPath(path);
    assert.equal(result.ok, false, `${path} must be rejected`);
    assert.equal(result.reason, 'runtime_error:transform_invalid');
  }
});

test('acs transform: parseSegments reads the documented grammar', () => {
  assert.deepEqual(parseSegments('.a.b'), ['a', 'b']);
  assert.deepEqual(parseSegments('[0].x'), [0, 'x']);
  assert.deepEqual(parseSegments('["a.b"].c'), ['a.b', 'c']);
  assert.throws(() => parseSegments('.a['));
});

test('acs transform: applying a transform replaces the value in place', () => {
  const target = { to: 'customer@example.com', body: 'Tracking token: TRACK-123' };
  const result = resolveTransform({ path: '$target.body', value: '[REDACTED]' }, target);
  assert.equal(result.ok, true);
  assert.equal(result.value.body, '[REDACTED]');
  assert.equal(result.value.to, 'customer@example.com');
});

test('acs transform: applying a transform does NOT mutate the original target', () => {
  const target = { body: 'original' };
  const result = resolveTransform({ path: '$target.body', value: 'changed' }, target);
  assert.equal(result.ok, true);
  assert.equal(target.body, 'original', 'the original target must be untouched');
});

test('acs transform: a nested path is applied at the right depth', () => {
  const target = { user: { email: 'a@b.c', name: 'x' }, other: 1 };
  const result = resolveTransform({ path: '$target.user.email', value: '[REDACTED]' }, target);
  assert.equal(result.ok, true);
  assert.equal(result.value.user.email, '[REDACTED]');
  assert.equal(result.value.user.name, 'x', 'siblings must survive');
  assert.equal(result.value.other, 1);
});

test('acs transform: an array element is replaced in place', () => {
  const target = { items: [{ name: 'a' }, { name: 'b' }] };
  const result = resolveTransform({ path: '$target.items[1].name', value: 'X' }, target);
  assert.equal(result.ok, true);
  assert.equal(result.value.items[1].name, 'X');
  assert.equal(result.value.items[0].name, 'a');
});

test('acs transform: the whole target can be replaced', () => {
  const result = resolveTransform({ path: '$target', value: { replaced: true } }, { a: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { replaced: true });
});

test('acs transform: a path that does not resolve fails closed', () => {
  // ACS SPEC section 14: a path that does not resolve against the policy
  // target is found when the host applies the transform, and fails closed.
  const result = resolveTransform({ path: '$target.absent', value: 'x' }, { present: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime_error:transform_invalid');
});

test('acs transform: a missing path or value member fails closed with policy_output_invalid', () => {
  for (const body of [
    {},
    { path: '$target.body' },
    { value: 'x' },
    { path: '$target.body', value: 'x', extra: true },
  ]) {
    const result = resolveTransform(body, { body: 'b' });
    if (body.extra) {
      // An extra member is rejected by the verdict schema, not by the
      // transform resolver. The resolver still fails closed.
      assert.equal(result.ok, false);
      continue;
    }
    assert.equal(result.ok, false, JSON.stringify(body) + ' must be rejected');
    assert.equal(result.reason, 'runtime_error:policy_output_invalid');
  }
});

test('acs transform: a non-object transform body fails closed', () => {
  for (const body of [null, undefined, 'string', 42, ['array']]) {
    const result = resolveTransform(body, { body: 'b' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'runtime_error:policy_output_invalid');
  }
});

test('acs transform: the failure verdict carries the reserved reason', () => {
  const result = resolveTransform({ path: '$policy_target.body', value: 'x' }, { body: 'b' });
  assert.equal(result.ok, false);
  assert.ok(result.verdict, 'a failure must carry a verdict');
  assert.equal(result.verdict.decision, 'deny');
  assert.equal(result.verdict.reason, 'runtime_error:transform_invalid');
});

test('acs transform: applyTransform on a missing path fails closed', () => {
  const result = applyTransform({ a: 1 }, ['absent'], 'x');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime_error:transform_invalid');
});
