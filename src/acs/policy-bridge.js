// src/acs/policy-bridge.js
// Binds an imported ACS manifest to the AWARE decision engine.
//
// WHAT THIS IS
// ------------
// An ACS manifest declares WHICH policy applies at WHICH intervention
// point, and WHAT the policy target is. The manifest is the wiring; the
// AWARE policy engine is the evaluator.
//
// So importing a manifest means: for each intervention point the manifest
// binds, build the ACS policy input using the manifest's `policy_target`
// path, and evaluate it. The manifest does NOT replace the AWARE policy
// engine -- it selects and configures it.
//
// THE BINDING RULES
// ------------------
// ACS SPEC section 4.1 and section 5: an intervention point that is not
// bound is an error, and `runtime_error:intervention_point_unknown` is
// the reason. A manifest that binds a point AWARE does not enforce is
// therefore a CONFLICT: the manifest says "apply policy here" and AWARE
// says "I hold no policy for here".
//
// That conflict FAILS CLOSED. It is not resolved by allowing the call,
// because the manifest's author expected a decision there.
//
// ACS SPEC section 6 fixes the evaluation order, and section 7 defines the
// policy input. This module implements both for the imported manifest.

'use strict';

const { ENFORCED_INTERVENTION_POINTS } = require('./version');

/**
 * The reason for a manifest that binds a point AWARE cannot enforce.
 */
const POINT_NOT_ENFORCED = 'runtime_error:intervention_point_unknown';

/**
 * The reason for a manifest whose policy target cannot be resolved.
 */
const PATH_MISSING = 'runtime_error:path_missing';

/**
 * Resolve a manifest path against a snapshot.
 *
 * The manifest path grammar (ACS SPEC section 3) is a root followed by
 * segments:
 *
 *   `.name`     an object member
 *   `[n]`       a zero-based array element
 *   `["name"]`  an object member whose name contains a dot or a bracket
 *
 * @param {string} manifestPath - The path.
 * @param {Object} snapshot - The snapshot to resolve against.
 * @returns {{ok: boolean, value: *, reason: string|null}}
 *   The resolved value, or the reserved reason for the failure.
 */
function resolveManifestPath(manifestPath, snapshot) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    return { ok: false, value: undefined, reason: 'runtime_error:manifest_invalid' };
  }

  // `$` and `$.name` are aliases for `$snap` and `$snap.name` (ACS SPEC
  // section 3.1). The `$` alias also accepts a bracket segment, so
  // `$["name.with.dot"]` resolves the same member as `$snap["name.with.dot"]`.
  let rest;
  if (manifestPath === '$') {
    rest = '';
  } else if (manifestPath.startsWith('$.') || manifestPath.startsWith('$[')) {
    rest = manifestPath.slice(1); // keep the leading separator
  } else if (manifestPath.startsWith('$snap')) {
    rest = manifestPath.slice('$snap'.length);
  } else {
    return { ok: false, value: undefined, reason: 'runtime_error:manifest_invalid' };
  }

  if (rest === '') {
    return { ok: true, value: snapshot, reason: null };
  }

  const segments = [];
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === '.') {
      i += 1;
      let name = '';
      while (i < rest.length && rest[i] !== '.' && rest[i] !== '[') {
        name += rest[i];
        i += 1;
      }
      if (name === '') {
        return { ok: false, value: undefined, reason: 'runtime_error:manifest_invalid' };
      }
      segments.push(name);
    } else if (ch === '[') {
      // The bracketed form is `["name"]`, and the name may itself contain
      // a bracket or a dot. So the closing quote is found FIRST, and the
      // closing bracket after it. ACS SPEC section 3: "a `["name"]` segment
      // selects an object member whose name contains a dot or a bracket."
      const quoted = rest[i + 1];
      if (quoted === '"' || quoted === "'") {
        const endQuote = rest.indexOf(quoted, i + 2);
        if (endQuote === -1 || rest[endQuote + 1] !== ']') {
          return { ok: false, value: undefined, reason: 'runtime_error:manifest_invalid' };
        }
        segments.push(rest.slice(i + 2, endQuote));
        i = endQuote + 2;
        continue;
      }

      const close = rest.indexOf(']', i);
      if (close === -1) {
        return { ok: false, value: undefined, reason: 'runtime_error:manifest_invalid' };
      }
      const inner = rest.slice(i + 1, close);
      if (/^-?\d+$/.test(inner)) {
        const index = Number(inner);
        if (index < 0) {
          return { ok: false, value: undefined, reason: 'runtime_error:manifest_invalid' };
        }
        segments.push(index);
      } else {
        // An unquoted bracket segment is not part of the grammar.
        return { ok: false, value: undefined, reason: 'runtime_error:manifest_invalid' };
      }
      i = close + 1;
    } else {
      return { ok: false, value: undefined, reason: 'runtime_error:manifest_invalid' };
    }
  }

  let current = snapshot;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return { ok: false, value: undefined, reason: 'runtime_error:path_type_mismatch' };
    }
    if (Array.isArray(current)) {
      if (typeof segment !== 'number' || segment >= current.length) {
        return { ok: false, value: undefined, reason: PATH_MISSING };
      }
      current = current[segment];
    } else {
      if (typeof segment !== 'string' || !Object.prototype.hasOwnProperty.call(current, segment)) {
        return { ok: false, value: undefined, reason: PATH_MISSING };
      }
      current = current[segment];
    }
  }

  return { ok: true, value: current, reason: null };
}

/**
 * The policy bridge: an imported manifest bound to the decision engine.
 */
class PolicyBridge {
  /**
   * @param {Object} config - The bridge configuration.
   * @param {Object} config.manifest - The resolved ACS manifest.
   * @param {Object} config.engine - The AWARE decision engine.
   */
  constructor(config) {
    this.manifest = config.manifest;
    this.engine = config.engine;
  }

  /**
   * The intervention points the manifest binds.
   *
   * @returns {string[]} The bound point names.
   */
  boundPoints() {
    const points = this.manifest && this.manifest.intervention_points;
    return points ? Object.keys(points) : [];
  }

  /**
   * Check that the manifest and this build agree on which points are
   * enforced.
   *
   * @returns {{ok: boolean, reason: string|null, message: string|null}}
   *   The compatibility result.
   */
  checkCompatibility() {
    const bound = this.boundPoints();
    for (const point of bound) {
      if (!ENFORCED_INTERVENTION_POINTS.includes(point)) {
        return {
          ok: false,
          reason: POINT_NOT_ENFORCED,
          message: `The manifest binds the ${point} intervention point, which this build does not enforce.`,
        };
      }
    }
    // A manifest that binds nothing at all cannot drive a decision.
    if (bound.length === 0) {
      return {
        ok: false,
        reason: POINT_NOT_ENFORCED,
        message: 'The manifest binds no intervention point.',
      };
    }
    return { ok: true, reason: null, message: null };
  }

  /**
   * Build the ACS policy input for an intervention point, using the
   * manifest's `policy_target` path.
   *
   * @param {string} interventionPoint - The point to build for.
   * @param {Object} snapshot - The host snapshot.
   * @param {Object} [tool] - The projected tool.
   * @returns {{ok: boolean, policyInput: Object|null, reason: string|null, message: string|null}}
   *   The policy input, or the reserved reason for the failure.
   */
  buildPolicyInput(interventionPoint, snapshot, tool) {
    const points = (this.manifest && this.manifest.intervention_points) || {};
    const point = points[interventionPoint];
    if (!point) {
      return {
        ok: false,
        policyInput: null,
        reason: POINT_NOT_ENFORCED,
        message: `The manifest does not bind the ${interventionPoint} intervention point.`,
      };
    }

    const resolved = resolveManifestPath(point.policy_target, snapshot);
    if (!resolved.ok) {
      return {
        ok: false,
        policyInput: null,
        reason: resolved.reason,
        message: `The manifest policy target could not be resolved: ${point.policy_target}`,
      };
    }

    // The projected tool, when the manifest declares where to read it.
    let projectedTool = tool === undefined ? null : tool;
    if (point.tool_name_from) {
      const toolResolved = resolveManifestPath(point.tool_name_from, snapshot);
      if (!toolResolved.ok) {
        return {
          ok: false,
          policyInput: null,
          reason: toolResolved.reason,
          message: `The manifest tool name could not be resolved: ${point.tool_name_from}`,
        };
      }
      projectedTool = typeof toolResolved.value === 'string'
        ? { name: toolResolved.value }
        : toolResolved.value;
    }

    return {
      ok: true,
      policyInput: {
        intervention_point: interventionPoint,
        policy_target: {
          kind: point.policy_target_kind === undefined ? null : point.policy_target_kind,
          path: point.policy_target,
          value: resolved.value,
        },
        snapshot: snapshot || {},
        annotations: point.annotations || {},
        tool: projectedTool === undefined ? null : projectedTool,
      },
      reason: null,
      message: null,
    };
  }

  /**
   * Evaluate an intervention point through the bound manifest.
   *
   * @param {string} interventionPoint - The point to evaluate.
   * @param {Object} snapshot - The host snapshot.
   * @param {Object} [options] - The evaluation options.
   * @param {string} [options.mode] - The enforcement mode.
   * @param {string} [options.agentId] - The agent id.
   * @param {string} [options.sessionId] - The session id.
   * @param {number} [options.sequence] - The sequence number.
   * @returns {Promise<Object>} The evaluation result. Every failure is a
   *   fail-closed verdict carrying a registered reserved reason.
   */
  async evaluate(interventionPoint, snapshot, options = {}) {
    const compatibility = this.checkCompatibility();
    if (!compatibility.ok) {
      return this.engine._failResult(
        compatibility.reason,
        compatibility.message,
        { policyInput: { intervention_point: interventionPoint } },
        options.mode || 'enforce',
      );
    }

    const built = this.buildPolicyInput(interventionPoint, snapshot);
    if (!built.ok) {
      return this.engine._failResult(
        built.reason,
        built.message,
        { policyInput: { intervention_point: interventionPoint } },
        options.mode || 'enforce',
      );
    }

    return this.engine.evaluate({
      policyInput: built.policyInput,
      mode: options.mode,
      agentId: options.agentId,
      sessionId: options.sessionId,
      sequence: options.sequence,
    });
  }
}

module.exports = {
  PolicyBridge,
  resolveManifestPath,
  POINT_NOT_ENFORCED,
  PATH_MISSING,
};
