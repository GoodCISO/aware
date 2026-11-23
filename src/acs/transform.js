// src/acs/transform.js
// `$target`-rooted path resolution and application for ACS transform verdicts.
//
// ACS SPEC section 3.2:
//   | Field         | Allowed roots                                   |
//   | transform path | $target                                         |
//
//   "A `transform` path MUST be rooted at `$target`. The pre-0.4
//   `$policy_target` root names the same value under a retired spelling and
//   MUST fail closed with `runtime_error:transform_invalid`; a path rooted
//   anywhere else MUST fail closed with
//   `runtime_error:transform_target_forbidden`."
//
// ACS SPEC section 14 adds:
//   - a path under $target that cannot be parsed -> runtime_error:transform_invalid
//   - a missing path or value member             -> runtime_error:policy_output_invalid
//   - a path that does not resolve against the policy target, or a value
//     that cannot be set because of a type mismatch -> found when the HOST
//     applies the transform, failing closed with host_error:transform_invalid
//
// The runtime returns the transform body UNAPPLIED. The host applies it.

'use strict';

const { failClosed } = require('./fail-closed');

/**
 * The one root a transform path may use.
 */
const TARGET_ROOT = '$target';

/**
 * The retired root. It names the same value under a pre-0.4 spelling and
 * fails closed with a DIFFERENT reason than a forbidden root, so it is
 * detected separately rather than lumped in with "any other root".
 */
const RETIRED_TARGET_ROOT = '$policy_target';

/**
 * Split a path into its segments.
 *
 * The grammar (ACS SPEC section 3): a `.name` segment selects an object
 * member, a `[n]` segment selects a zero-based array element, and a
 * `["name"]` segment selects an object member whose name contains a dot or
 * a bracket.
 *
 * @param {string} path - The path to split.
 * @returns {Array<string|number>} The segments.
 * @throws {Error} When the path does not parse.
 */
function parseSegments(path) {
  const segments = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      i += 1;
      let name = '';
      while (i < path.length && path[i] !== '.' && path[i] !== '[') {
        name += path[i];
        i += 1;
      }
      if (name === '') throw new Error('empty path segment');
      segments.push(name);
    } else if (ch === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) throw new Error('unterminated bracket segment');
      const inner = path.slice(i + 1, close);
      if (inner === '') throw new Error('empty bracket segment');
      if (/^-?\d+$/.test(inner)) {
        const index = Number(inner);
        if (index < 0) throw new Error('negative array index');
        segments.push(index);
      } else if (
        (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) ||
        (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
      ) {
        segments.push(inner.slice(1, -1));
      } else {
        throw new Error('unsupported bracket segment');
      }
      i = close + 1;
    } else {
      throw new Error(`unexpected character in path: ${ch}`);
    }
  }
  return segments;
}

/**
 * Validate a transform path and return its segments.
 *
 * @param {string} path - The transform path.
 * @returns {{ok: true, segments: Array}|{ok: false, reason: string}}
 *   The parse result, or the reserved reason the failure must use.
 */
function validateTransformPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    // A missing or non-string path is a malformed transform body. The spec
    // attributes a MISSING member to policy_output_invalid and a path that
    // cannot be parsed to transform_invalid. A present-but-empty path parses
    // as invalid.
    return { ok: false, reason: 'runtime_error:transform_invalid' };
  }

  if (path.startsWith(RETIRED_TARGET_ROOT)) {
    // The retired spelling is detected BEFORE the general root check so it
    // gets its own reserved reason.
    return { ok: false, reason: 'runtime_error:transform_invalid' };
  }

  if (!path.startsWith(TARGET_ROOT)) {
    return { ok: false, reason: 'runtime_error:transform_target_forbidden' };
  }

  // The root must be exactly `$target`, not `$targetfoo`.
  const rest = path.slice(TARGET_ROOT.length);
  if (rest !== '' && !rest.startsWith('.') && !rest.startsWith('[')) {
    return { ok: false, reason: 'runtime_error:transform_target_forbidden' };
  }

  let segments;
  try {
    segments = parseSegments(rest);
  } catch (err) {
    return { ok: false, reason: 'runtime_error:transform_invalid' };
  }

  if (segments.length === 0) {
    // `$target` with no segment addresses the whole target. That is a legal
    // path per the grammar (the root selects the value itself), so it is
    // allowed.
    return { ok: true, segments: [] };
  }

  return { ok: true, segments };
}

/**
 * Replace the value at a path inside a container, returning a NEW container.
 *
 * The recursion rebuilds the path from the leaf upward, so a nested array
 * inside an object (or an object inside an array) is handled uniformly.
 * Nothing is mutated in place: every level is copied.
 *
 * @param {*} container - The container holding the next segment.
 * @param {Array<string|number>} segments - The remaining segments.
 * @param {*} newValue - The replacement value for the final segment.
 * @returns {{ok: true, value: *}|{ok: false, reason: string, message: string}}
 *   The new container, or the failure.
 */
function replaceIn(container, segments, newValue) {
  const segment = segments[0];

  if (Array.isArray(container)) {
    if (typeof segment !== 'number' || segment >= container.length) {
      return {
        ok: false,
        reason: 'runtime_error:transform_invalid',
        message: 'Transform path does not resolve against the policy target.',
      };
    }
    const copy = container.slice();
    if (segments.length === 1) {
      copy[segment] = newValue;
      return { ok: true, value: copy };
    }
    const child = replaceIn(copy[segment], segments.slice(1), newValue);
    if (!child.ok) return child;
    copy[segment] = child.value;
    return { ok: true, value: copy };
  }

  if (container === null || typeof container !== 'object') {
    return {
      ok: false,
      reason: 'runtime_error:transform_invalid',
      message: 'Transform path does not resolve against the policy target.',
    };
  }

  if (typeof segment !== 'string' || !Object.prototype.hasOwnProperty.call(container, segment)) {
    return {
      ok: false,
      reason: 'runtime_error:transform_invalid',
      message: 'Transform path does not resolve against the policy target.',
    };
  }

  const copy = { ...container };
  if (segments.length === 1) {
    copy[segment] = newValue;
    return { ok: true, value: copy };
  }
  const child = replaceIn(copy[segment], segments.slice(1), newValue);
  if (!child.ok) return child;
  copy[segment] = child.value;
  return { ok: true, value: copy };
}

/**
 * Apply a transform to a policy target value.
 *
 * The transformation is confined to the policy target. The snapshot, the
 * annotations, the projected tool and host state are never touched.
 *
 * @param {*} targetValue - The current policy target value.
 * @param {Array<string|number>} segments - The parsed path segments.
 * @param {*} newValue - The replacement value.
 * @returns {{ok: true, value: *}|{ok: false, reason: string, message: string}}
 *   The transformed value, or the reserved reason the failure must use.
 */
function applyTransform(targetValue, segments, newValue) {
  if (segments.length === 0) {
    // The whole target is replaced.
    return { ok: true, value: newValue };
  }

  // ACS SPEC section 14: "A `path` that does not resolve against the
  // policy target ... is found when the host applies the transform and
  // fails closed there with `host_error:transform_invalid`". A member that
  // is absent does not resolve. The transform REPLACES a value at an
  // existing location; it does not create one. Failing closed here is
  // deliberate: a transform that silently added a field could write a
  // member the policy never named.
  return replaceIn(targetValue, segments, newValue);
}

/**
 * Validate and apply a transform body in one step.
 *
 * @param {Object} transformBody - The `{path, value}` body.
 * @param {*} targetValue - The policy target value the transform applies to.
 * @returns {{ok: true, value: *}|{ok: false, reason: string, message: string, verdict: Object}}
 *   The transformed value, or a fail-closed verdict carrying the reserved reason.
 */
function resolveTransform(transformBody, targetValue) {
  if (!transformBody || typeof transformBody !== 'object' || Array.isArray(transformBody)) {
    return {
      ok: false,
      reason: 'runtime_error:policy_output_invalid',
      message: 'Transform body is missing or is not an object.',
      verdict: failClosed(
        'runtime_error:policy_output_invalid',
        'Transform body is missing or is not an object.',
      ),
    };
  }

  if (!Object.prototype.hasOwnProperty.call(transformBody, 'path')
      || !Object.prototype.hasOwnProperty.call(transformBody, 'value')) {
    return {
      ok: false,
      reason: 'runtime_error:policy_output_invalid',
      message: 'Transform body is missing a path or value member.',
      verdict: failClosed(
        'runtime_error:policy_output_invalid',
        'Transform body is missing a path or value member.',
      ),
    };
  }

  // The transform body has exactly two members. ACS SPEC section 13: "Before
  // constructing a typed verdict, normalization MUST reject unknown members
  // at the policy-output root, in each `warnings` entry, and in `transform`,
  // with `runtime_error:policy_output_invalid`. It MUST NOT discard these
  // members and validate only the remaining fields."
  const unknown = Object.keys(transformBody).filter((k) => k !== 'path' && k !== 'value');
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: 'runtime_error:policy_output_invalid',
      message: 'Transform body carries an unknown member.',
      verdict: failClosed(
        'runtime_error:policy_output_invalid',
        'Transform body carries an unknown member.',
      ),
    };
  }

  const parsed = validateTransformPath(transformBody.path);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.reason,
      message: `Transform path is not permitted: ${transformBody.path}`,
      verdict: failClosed(
        parsed.reason,
        `Transform path is not permitted: ${transformBody.path}`,
      ),
    };
  }

  const applied = applyTransform(targetValue, parsed.segments, transformBody.value);
  if (!applied.ok) {
    return {
      ok: false,
      reason: applied.reason,
      message: applied.message,
      verdict: failClosed(applied.reason, applied.message),
    };
  }

  return { ok: true, value: applied.value };
}

module.exports = {
  TARGET_ROOT,
  RETIRED_TARGET_ROOT,
  parseSegments,
  validateTransformPath,
  applyTransform,
  resolveTransform,
};
