// test/unit/acs/validator.test.js
// The JSON Schema subset validator.
//
// THE POINT OF THIS SUITE
// -----------------------
// A validator that silently ignores a keyword it does not implement is a
// FAIL-OPEN validator: it passes documents it never really checked. That is
// the same class as ACS issue #83.
//
// So the validator has two obligations, and this suite proves both:
//
//   1. It implements the keywords the PINNED ACS schemas use, and it
//      validates them correctly.
//   2. It REFUSES a schema that uses a keyword it does not implement,
//      rather than ignoring the keyword.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validate,
  assertValid,
  SchemaError,
  SUPPORTED_KEYWORDS,
} = require('../../../src/acs/validator');
const { getSchema } = require('../../../src/acs/schemas');

test('acs validator: a valid document passes', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const result = validate({ a: 'x' }, schema);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('acs validator: a wrong type fails', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  const result = validate({ a: 1 }, schema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('acs validator: a missing required member fails', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: {} } };
  const result = validate({}, schema);
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /required/);
});

test('acs validator: additionalProperties false rejects an unknown member', () => {
  const schema = {
    type: 'object',
    properties: { a: {} },
    additionalProperties: false,
  };
  assert.equal(validate({ a: 1 }, schema).valid, true);
  const result = validate({ a: 1, b: 2 }, schema);
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /not an allowed property/);
});

test('acs validator: enum and const are enforced', () => {
  assert.equal(validate('a', { enum: ['a', 'b'] }).valid, true);
  assert.equal(validate('c', { enum: ['a', 'b'] }).valid, false);
  assert.equal(validate(1, { const: 1 }).valid, true);
  assert.equal(validate(2, { const: 1 }).valid, false);
});

test('acs validator: pattern is enforced', () => {
  const schema = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
  assert.equal(validate('sha256:' + 'a'.repeat(64), schema).valid, true);
  assert.equal(validate('SHA256:' + 'a'.repeat(64), schema).valid, false);
  assert.equal(validate('nope', schema).valid, false);
});

test('acs validator: minLength counts unicode code points, not utf-16 units', () => {
  // A single astral character is TWO utf-16 units but ONE code point.
  //
  // With minLength 2, a naive value.length would see 2 units and ACCEPT
  // the string, while a correct code-point count sees 1 and REJECTS it.
  // The test asserts the correct behaviour.
  assert.equal(
    validate('\u{1F600}', { type: 'string', minLength: 2 }).valid,
    false,
    'one code point is under a minLength of 2',
  );

  // With minLength 1, a naive value.length would see 2 units and ACCEPT.
  // The correct count also accepts, so this case does not discriminate.
  assert.equal(validate('\u{1F600}', { type: 'string', minLength: 1 }).valid, true);

  // The discriminating pair: two astral characters are four utf-16 units
  // and two code points.
  assert.equal(
    validate('\u{1F600}\u{1F600}', { type: 'string', minLength: 3 }).valid,
    false,
    'two code points are under a minLength of 3',
  );
  assert.equal(validate('\u{1F600}\u{1F600}', { type: 'string', minLength: 2 }).valid, true);

  assert.equal(validate('ab', { type: 'string', minLength: 2 }).valid, true);
  assert.equal(validate('a', { type: 'string', minLength: 2 }).valid, false);
});

test('acs validator: oneOf requires exactly one match', () => {
  const schema = {
    oneOf: [
      { type: 'null' },
      { type: 'object', required: ['a'] },
    ],
  };
  assert.equal(validate(null, schema).valid, true);
  assert.equal(validate({ a: 1 }, schema).valid, true);
  assert.equal(validate('string', schema).valid, false);
});

test('acs validator: anyOf requires at least one match', () => {
  const schema = { anyOf: [{ type: 'string' }, { type: 'number' }] };
  assert.equal(validate('x', schema).valid, true);
  assert.equal(validate(1, schema).valid, true);
  assert.equal(validate(true, schema).valid, false);
});

test('acs validator: allOf requires every match', () => {
  const schema = { allOf: [{ type: 'object' }, { required: ['a'] }] };
  assert.equal(validate({ a: 1 }, schema).valid, true);
  assert.equal(validate({}, schema).valid, false);
});

test('acs validator: not rejects a matching document', () => {
  const schema = { not: { type: 'string' } };
  assert.equal(validate('x', schema).valid, false);
  assert.equal(validate(1, schema).valid, true);
});

test('acs validator: if/then/else are honoured', () => {
  const schema = {
    if: { properties: { kind: { const: 'a' } }, required: ['kind'] },
    then: { required: ['a'] },
    else: { required: ['b'] },
  };
  assert.equal(validate({ kind: 'a', a: 1 }, schema).valid, true);
  assert.equal(validate({ kind: 'a' }, schema).valid, false);
  assert.equal(validate({ kind: 'z', b: 1 }, schema).valid, true);
  assert.equal(validate({ kind: 'z' }, schema).valid, false);
});

test('acs validator: a local $ref resolves', () => {
  const schema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/leaf' } },
    $defs: { leaf: { type: 'string' } },
  };
  assert.equal(validate({ a: 'x' }, schema).valid, true);
  assert.equal(validate({ a: 1 }, schema).valid, false);
});

test('acs validator: a remote $ref is REFUSED, not ignored', () => {
  const schema = { $ref: 'https://example.com/other.json' };
  assert.throws(() => validate({}, schema), SchemaError);
});

test('acs validator: an unresolvable local $ref is REFUSED, not ignored', () => {
  const schema = { $ref: '#/$defs/absent' };
  assert.throws(() => validate({}, schema), SchemaError);
});

test('acs validator: an UNSUPPORTED keyword is refused, not ignored', () => {
  // This is the fail-open guard. A validator that ignored an unknown
  // keyword would pass a document it never really checked.
  const schema = { type: 'object', unevaluatedProperties: false, contentEncoding: 'base64' };
  assert.throws(
    () => validate({}, schema),
    (err) => err instanceof SchemaError && err.code === 'schema_unsupported_keyword',
  );
});

test('acs validator: an unsupported keyword nested in properties is refused', () => {
  const schema = { type: 'object', properties: { a: { contentMediaType: 'text/plain' } } };
  assert.throws(
    () => validate({ a: 'x' }, schema),
    (err) => err instanceof SchemaError && err.code === 'schema_unsupported_keyword',
  );
});

test('acs validator: assertValid throws on an invalid document', () => {
  const schema = { type: 'object', required: ['a'] };
  assert.throws(() => assertValid({}, schema, 'a policy input'), /does not satisfy/);
  assert.doesNotThrow(() => assertValid({ a: 1 }, schema, 'a policy input'));
});

test('acs validator: every pinned ACS schema is fully supported', () => {
  // If a pinned schema used an unsupported keyword, the adapter could not
  // validate against it. This test proves every vendored schema is
  // implementable, so no document is ever "passed" unchecked.
  const names = [
    'policyInput',
    'verdict',
    'result',
    'request',
    'snapshot',
    'manifest',
    'approval',
    'interceptionRecord',
  ];
  for (const name of names) {
    const schema = getSchema(name);
    // assertValid throws a SchemaError with code schema_unsupported_keyword
    // when a keyword is not implementable. A plain document exercises the
    // whole schema walk.
    assert.doesNotThrow(
      () => validate({}, schema),
      `the ${name} schema must be fully supported by the validator`,
    );
  }
});

test('acs validator: the supported keyword set is explicit', () => {
  assert.ok(SUPPORTED_KEYWORDS.has('type'));
  assert.ok(SUPPORTED_KEYWORDS.has('$ref'));
  assert.ok(SUPPORTED_KEYWORDS.has('additionalProperties'));
  assert.ok(SUPPORTED_KEYWORDS.has('if'));
  assert.ok(SUPPORTED_KEYWORDS.has('oneOf'));
  // A keyword that is NOT implemented must not be in the set.
  assert.equal(SUPPORTED_KEYWORDS.has('contentMediaType'), false);
  assert.equal(SUPPORTED_KEYWORDS.has('contentEncoding'), false);
});
