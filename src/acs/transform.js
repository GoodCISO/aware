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
    return { ok: true, value: newValue };
  }

  // Walk to the parent of the final segment, creating nothing. A path that
  // does not resolve is a host-side failure (host_error:transform_invalid
  // per AGENT-HOOKS-0.1 section 5.2). The adapter reports it with the
  // registered runtime reason it can use; the host surfaces host_error.
  const parentSegments = segments.slice(0, -1);
  const last = segments[segments.length - 1];

  let parent = targetValue;
  for (const segment of parentSegments) {
    if (parent === null || typeof parent !== 'object') {
      return {
        ok: false,
        reason: 'runtime_error:transform_invalid',
        message: 'Transform path does not resolve against the policy target.',
      };
    }
    if (Array.isArray(parent)) {
      if (typeof segment !== 'number' || segment >= parent.length) {
        return {
          ok: false,
          reason: 'runtime_error:transform_invalid',
          message: 'Transform path does not resolve against the policy target.',
        };
      }
      parent = parent[segment];
    } else {
      if (typeof segment !== 'string' || !Object.prototype.hasOwnProperty.call(parent, segment)) {
        return {
          ok: false,
          reason: 'runtime_error:transform_invalid',
          message: 'Transform path does not resolve against the policy target.',
        };
      }
      parent = parent[segment];
    }
  }

  if (parent === null || typeof parent !== 'object') {
    return {
      ok: false,
      reason: 'runtime_error:transform_invalid',
      message: 'Transform path does not resolve against the policy target.',
    };
  }

  // Copy so the caller's original target is never mutated in place.
  const next = Array.isArray(parent) ? parent.slice() : { ...parent };

  if (Array.isArray(next)) {
    if (typeof last !== 'number') {
      return {
        ok: false,
        reason: 'runtime_error:transform_invalid',
        message: 'Transform path segment does not address an array element.',
      };
    }
    if (last >= next.length) {
      return {
        ok: false,
        reason: 'runtime_error:transform_invalid',
        message: 'Transform path does not resolve against the policy target.',
      };
    }
    next[last] = newValue;
  } else {
    if (typeof last !== 'string') {
      return {
        ok: false,
        reason: 'runtime_error:transform_invalid',
        message: 'Transform path segment does not address an object member.',
      };
    }
    // ACS SPEC section 14: "A `path` that does not resolve against the
    // policy target ... is found when the host applies the transform and
    // fails closed there with `host_error:transform_invalid`". A member that
    // is absent does not resolve. The transform REPLACES a value at an
    // existing location; it does not create one. Failing closed here is
    // deliberate: a transform that silently added a field could write a
    // member the policy never named.
    if (!Object.prototype.hasOwnProperty.call(next, last)) {
      return {
        ok: false,
        reason: 'runtime_error:transform_invalid',
        message: 'Transform path does not resolve against the policy target.',
      };
    }
    next[last] = newValue;
  }

  // Rebuild the root with the new parent in place.
  const rootSegments = segments.slice(0, -1);
  let rebuilt = next;
  for (let i = rootSegments.length - 1; i >= 0; i -= 1) {
    const segment = rootSegments[i];
    const container = Array.isArray(targetValue) ? targetValue : targetValue;
    if (container === null || typeof container !== 'object') {
      return {
        ok: false,
        reason: 'runtime_error:transform_invalid',
        message: 'Transform path does not resolve against the policy target.',
      };
    }
    if (Array.isArray(container)) {
      const copy = container.slice();
      copy[segment] = rebuilt;
      rebuilt = copy;
    } else {
      const copy = { ...container };
      copy[segment] = rebuilt;
      rebuilt = copy;
    }
  }

  return { ok: true, value: rebuilt };
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
