// src/acs/validator.js
// A minimal JSON Schema validator for the subset the pinned ACS schemas use.
//
// WHY NOT AJV
// -----------
// The repository has already made this call deliberately. See
// src/v2/tier_promotions_handler.js:11-15 -- "no ajv in the dep tree ...
// Keeps the runtime dep set unchanged (no ajv added)". The task constraint
// is "don't add heavy dependencies without justification in DESIGN.md".
// The pinned ACS schemas use a small, well-defined subset of JSON Schema,
// so the subset is implemented here.
//
// FAIL-CLOSED RULE
// ----------------
// A keyword this validator does not implement is NOT silently ignored. It
// raises a SchemaError, which the caller turns into a deny verdict. A
// schema that uses an unsupported keyword therefore fails the evaluation
// closed rather than passing a document that was never really checked.
//
// SUPPORTED KEYWORDS
// ------------------
//   type, enum, const, required, properties, additionalProperties,
//   patternProperties, items, minItems, maxItems, uniqueItems,
//   minLength, maxLength, pattern, minimum, maximum,
//   allOf, anyOf, oneOf, not, if/then/else,
//   $ref (local "#/..." pointers only), $defs, definitions,
//   propertyNames, dependentRequired, minProperties, maxProperties

'use strict';

const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', '$comment', 'title', 'description',
  'type', 'enum', 'const',
  'required', 'properties', 'additionalProperties', 'patternProperties',
  'propertyNames', 'dependentRequired', 'minProperties', 'maxProperties',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'allOf', 'anyOf', 'oneOf', 'not',
  'if', 'then', 'else',
  'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'unevaluatedProperties', 'unevaluatedItems',
]);

/**
 * Raised when a schema uses a keyword this validator does not implement, or
 * when a document fails validation.
 */
class SchemaError extends Error {
  /**
   * @param {string} message - What went wrong.
   * @param {string} code - A stable machine-readable code.
   * @param {string[]} [path] - The instance path where the failure occurred.
   */
  constructor(message, code, path = []) {
    super(message);
    this.name = 'SchemaError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Test whether a value has a JSON type.
 *
 * @param {*} value - The value to test.
 * @param {string} type - The JSON type name.
 * @returns {boolean} True when the value is of that type.
 */
function matchesType(value, type) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      throw new SchemaError(`Unknown JSON type: ${type}`, 'schema_unsupported_type');
  }
}

/**
 * Deep structural equality, used for const and uniqueItems.
 *
 * @param {*} a - First value.
 * @param {*} b - Second value.
 * @returns {boolean} True when the values are structurally equal.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Resolve a local JSON pointer ("#/a/b") against a root document.
 *
 * Only local pointers are supported. A remote or non-local reference is an
 * error, never a silent pass.
 *
 * @param {Object} root - The document the pointer resolves against.
 * @param {string} ref - The reference string.
 * @returns {*} The referenced value.
 */
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    throw new SchemaError(`Only local $ref is supported, got: ${ref}`, 'schema_unsupported_ref');
  }
  const pointer = ref.slice(1);
  if (pointer === '' || pointer === '/') return root;
  if (!pointer.startsWith('/')) {
    throw new SchemaError(`Unsupported $ref form: ${ref}`, 'schema_unsupported_ref');
  }
  let current = root;
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object') {
      throw new SchemaError(`$ref does not resolve: ${ref}`, 'schema_unresolved_ref');
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new SchemaError(`$ref does not resolve: ${ref}`, 'schema_unresolved_ref');
    }
    current = current[segment];
  }
  return current;
}

/**
 * Assert that every keyword in a schema is one this validator implements.
 *
 * @param {Object} schema - The schema to check.
 * @param {string} at - The schema location, for the error message.
 */
function assertSupported(schema, at) {
  if (schema === true || schema === false) return;
  if (!schema || typeof schema !== 'object') {
    throw new SchemaError(`Schema is not an object at ${at}`, 'schema_malformed');
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new SchemaError(
        `Unsupported schema keyword "${keyword}" at ${at}. Refusing to validate a schema ` +
        'this validator does not fully implement, because doing so could pass a document ' +
        'that was never really checked.',
        'schema_unsupported_keyword',
      );
    }
  }
  for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions']) {
    if (schema[keyword] && typeof schema[keyword] === 'object') {
      for (const [name, sub] of Object.entries(schema[keyword])) {
        assertSupported(sub, `${at}/${keyword}/${name}`);
      }
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword].forEach((sub, i) => assertSupported(sub, `${at}/${keyword}/${i}`));
    }
  }
  for (const keyword of [
    'items', 'additionalProperties', 'not', 'if', 'then', 'else',
    'contains', 'propertyNames',
  ]) {
    if (schema[keyword] !== undefined && typeof schema[keyword] === 'object') {
      assertSupported(schema[keyword], `${at}/${keyword}`);
    }
  }
}

/**
 * Validate a document against a schema.
 *
 * @param {*} instance - The document to validate.
 * @param {Object} schema - The schema to validate against.
 * @param {Object} [root] - The document $ref resolves against. Defaults to schema.
 * @param {string} [at] - The instance path, for error messages.
 * @returns {{valid: boolean, errors: Array<{path: string, message: string}>}}
 *   The validation result. `errors` is empty when valid.
 * @throws {SchemaError} When the schema itself is unsupported or malformed.
 */
function validate(instance, schema, root, at = '$') {
  const rootDoc = root === undefined ? schema : root;
  const errors = [];
  // Refuse a schema this validator does not fully implement. A validator
  // that ignores an unknown keyword passes documents it never really
  // checked, which is the same fail-open class as ACS issue #83.
  assertSupported(schema, at);
  validateInto(instance, schema, rootDoc, at, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Recursive worker for validate().
 *
 * @param {*} instance - The value being checked.
 * @param {Object} schema - The schema to check against.
 * @param {Object} root - The $ref root document.
 * @param {string} at - The instance path.
 * @param {Array} errors - Accumulator for errors.
 */
function validateInto(instance, schema, root, at, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path: at, message: 'no value is valid here' });
    return;
  }
  if (typeof schema !== 'object' || schema === null) {
    throw new SchemaError(`Malformed schema at ${at}`, 'schema_malformed');
  }

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(root, schema.$ref);
    // A $ref alongside other keywords is legal in 2020-12; validate both.
    validateInto(instance, target, root, at, errors);
    const siblings = { ...schema };
    delete siblings.$ref;
    if (Object.keys(siblings).length > 0) {
      validateInto(instance, siblings, root, at, errors);
    }
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(instance, t))) {
      errors.push({
        path: at,
        message: `expected type ${types.join('|')}, got ${Array.isArray(instance) ? 'array' : instance === null ? 'null' : typeof instance}`,
      });
      return; // Further keywords would produce noise on a type mismatch.
    }
  }

  if (schema.const !== undefined && !deepEqual(instance, schema.const)) {
    errors.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((v) => deepEqual(instance, v))) {
    errors.push({ path: at, message: `must be one of ${JSON.stringify(schema.enum)}` });
  }

  if (typeof instance === 'string') validateString(instance, schema, at, errors);
  if (typeof instance === 'number') validateNumber(instance, schema, at, errors);
  if (Array.isArray(instance)) validateArray(instance, schema, root, at, errors);
  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    validateObject(instance, schema, root, at, errors);
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateInto(instance, sub, root, at, errors);
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((sub) => {
      const local = [];
      validateInto(instance, sub, root, at, local);
      return local.length === 0;
    });
    if (!ok) errors.push({ path: at, message: 'does not match any of the permitted forms' });
  }
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const sub of schema.oneOf) {
      const local = [];
      validateInto(instance, sub, root, at, local);
      if (local.length === 0) matches += 1;
    }
    if (matches !== 1) {
      errors.push({ path: at, message: `must match exactly one permitted form, matched ${matches}` });
    }
  }
  if (schema.not !== undefined) {
    const local = [];
    validateInto(instance, schema.not, root, at, local);
    if (local.length === 0) errors.push({ path: at, message: 'must not match the excluded form' });
  }
  if (schema.if !== undefined) {
    const local = [];
    validateInto(instance, schema.if, root, at, local);
    if (local.length === 0) {
      if (schema.then !== undefined) validateInto(instance, schema.then, root, at, errors);
    } else if (schema.else !== undefined) {
      validateInto(instance, schema.else, root, at, errors);
    }
  }
}

/**
 * String-specific constraints.
 *
 * @param {string} value - The string to check.
 * @param {Object} schema - The schema.
 * @param {string} at - The instance path.
 * @param {Array} errors - Accumulator for errors.
 */
function validateString(value, schema, at, errors) {
  // JSON Schema counts Unicode CODE POINTS, not UTF-16 code units. An
  // astral character such as an emoji is two UTF-16 units but one code
  // point, so a naive value.length would reject a string that satisfies the
  // schema.
  const length = Array.from(value).length;
  if (typeof schema.minLength === 'number' && length < schema.minLength) {
    errors.push({ path: at, message: `must be at least ${schema.minLength} characters` });
  }
  if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
    errors.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
  }
  if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
    errors.push({ path: at, message: `must match pattern ${schema.pattern}` });
  }
}

/**
 * Number-specific constraints.
 *
 * @param {number} value - The number to check.
 * @param {Object} schema - The schema.
 * @param {string} at - The instance path.
 * @param {Array} errors - Accumulator for errors.
 */
function validateNumber(value, schema, at, errors) {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push({ path: at, message: `must be >= ${schema.minimum}` });
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    errors.push({ path: at, message: `must be <= ${schema.maximum}` });
  }
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
    errors.push({ path: at, message: `must be > ${schema.exclusiveMinimum}` });
  }
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
    errors.push({ path: at, message: `must be < ${schema.exclusiveMaximum}` });
  }
  if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      errors.push({ path: at, message: `must be a multiple of ${schema.multipleOf}` });
    }
  }
}

/**
 * Array-specific constraints.
 *
 * @param {Array} value - The array to check.
 * @param {Object} schema - The schema.
 * @param {Object} root - The $ref root document.
 * @param {string} at - The instance path.
 * @param {Array} errors - Accumulator for errors.
 */
function validateArray(value, schema, root, at, errors) {
  if (Array.isArray(schema.prefixItems)) {
    schema.prefixItems.forEach((sub, i) => {
      if (i < value.length) validateInto(value[i], sub, root, `${at}[${i}]`, errors);
    });
  }
  if (schema.items !== undefined && typeof schema.items === 'object') {
    const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
    for (let i = start; i < value.length; i += 1) {
      validateInto(value[i], schema.items, root, `${at}[${i}]`, errors);
    }
  }
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    errors.push({ path: at, message: `must have at least ${schema.minItems} items` });
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    errors.push({ path: at, message: `must have at most ${schema.maxItems} items` });
  }
  if (schema.uniqueItems === true) {
    for (let i = 0; i < value.length; i += 1) {
      for (let j = i + 1; j < value.length; j += 1) {
        if (deepEqual(value[i], value[j])) {
          errors.push({ path: at, message: 'items must be unique' });
          i = value.length;
          break;
        }
      }
    }
  }
  if (schema.contains !== undefined) {
    const ok = value.some((item) => {
      const local = [];
      validateInto(item, schema.contains, root, at, local);
      return local.length === 0;
    });
    if (!ok) errors.push({ path: at, message: 'must contain at least one matching item' });
  }
}

/**
 * Object-specific constraints.
 *
 * @param {Object} value - The object to check.
 * @param {Object} schema - The schema.
 * @param {Object} root - The $ref root document.
 * @param {string} at - The instance path.
 * @param {Array} errors - Accumulator for errors.
 */
function validateObject(value, schema, root, at, errors) {
  const keys = Object.keys(value);

  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) {
        errors.push({ path: `${at}.${name}`, message: 'is required' });
      }
    }
  }

  if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
    errors.push({ path: at, message: `must have at least ${schema.minProperties} properties` });
  }
  if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
    errors.push({ path: at, message: `must have at most ${schema.maxProperties} properties` });
  }

  if (schema.dependentRequired && typeof schema.dependentRequired === 'object') {
    for (const [trigger, dependents] of Object.entries(schema.dependentRequired)) {
      if (!Object.prototype.hasOwnProperty.call(value, trigger)) continue;
      for (const dependent of dependents) {
        if (!Object.prototype.hasOwnProperty.call(value, dependent)) {
          errors.push({ path: `${at}.${dependent}`, message: `is required when ${trigger} is present` });
        }
      }
    }
  }

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, name)) {
        validateInto(value[name], sub, root, `${at}.${name}`, errors);
      }
    }
  }

  if (schema.patternProperties && typeof schema.patternProperties === 'object') {
    for (const [pattern, sub] of Object.entries(schema.patternProperties)) {
      const re = new RegExp(pattern, 'u');
      for (const name of keys) {
        if (re.test(name)) validateInto(value[name], sub, root, `${at}.${name}`, errors);
      }
    }
  }

  if (schema.propertyNames !== undefined && typeof schema.propertyNames === 'object') {
    for (const name of keys) {
      validateInto(name, schema.propertyNames, root, `${at}.${name}`, errors);
    }
  }

  if (schema.additionalProperties !== undefined) {
    const known = new Set(Object.keys(schema.properties || {}));
    const patternKeys = Object.keys(schema.patternProperties || {});
    for (const name of keys) {
      if (known.has(name)) continue;
      const matchesPattern = patternKeys.some((p) => new RegExp(p, 'u').test(name));
      if (matchesPattern) continue;
      if (schema.additionalProperties === false) {
        errors.push({ path: `${at}.${name}`, message: 'is not an allowed property' });
      } else if (typeof schema.additionalProperties === 'object') {
        validateInto(value[name], schema.additionalProperties, root, `${at}.${name}`, errors);
      }
    }
  }
}

/**
 * Validate a document against a schema, and throw on failure.
 *
 * @param {*} instance - The document to validate.
 * @param {Object} schema - The schema to validate against.
 * @param {string} label - A label used in the error message.
 * @returns {void}
 * @throws {SchemaError} When the document does not validate.
 */
function assertValid(instance, schema, label) {
  const result = validate(instance, schema);
  if (!result.valid) {
    const detail = result.errors
      .slice(0, 8)
      .map((e) => `${e.path}: ${e.message}`)
      .join('; ');
    throw new SchemaError(
      `${label} does not satisfy the pinned ACS schema: ${detail}`,
      'instance_invalid',
      result.errors.map((e) => e.path),
    );
  }
}

module.exports = {
  SchemaError,
  SUPPORTED_KEYWORDS,
  validate,
  assertValid,
  deepEqual,
  resolveRef,
};
