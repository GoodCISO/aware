// src/acs/manifest.js
// ACS manifest import, export and `extends` resolution.
//
// WHAT A MANIFEST IS
// ------------------
// An ACS manifest declares the policy for a set of intervention points.
// The pinned manifest schema (docs/acs/schemas/manifest.schema.json) has
// eight root members:
//
//   agent_control_specification_version   required
//   metadata                              free-form
//   extends                               a list of parent manifests
//   policies                              named policy definitions
//   intervention_points                   the binding, per point
//   tools                                 the tool catalogue
//   annotators                            the annotator definitions
//   approval                              the optional approval section
//
// HOW AWARE PLUGS IN
// ------------------
// The `policy` definition has four branches: rego, test, cedar and
// `custom`. The `custom` branch requires an `adapter` name:
//
//   { "type": "custom", "adapter": "aware" }
//
// AWARE exports and imports the `custom` branch with its own adapter name.
// The adapter name is what binds a manifest to this implementation; an
// unknown adapter is REFUSED, not ignored, because binding a manifest to
// the wrong engine is exactly the kind of silent mismatch that produces a
// wrong verdict.
//
// THE EXTENDS CHAIN
// -----------------
// ACS SPEC section 2.2: a manifest may extend other manifests. The
// resolution rules are:
//   - a repeated binding for the same annotation at the same intervention
//     point MUST be structurally identical; a difference is a merge
//     conflict
//   - the loader does NOT union dependency lists
//   - a fetchable parent MUST be pinned (a sha256 or an integrity value);
//     the `not: {required: [integrity, sha256]}` rule in the schema
//     enforces that for the object form
//
// EVERY FAILURE HERE IS FAIL-CLOSED. A manifest that cannot be resolved,
// validated or bound produces a deny, never a partial application.

'use strict';

const fs = require('fs');
const path = require('path');

const { getSchema } = require('./schemas');
const { validate } = require('./validator');
const { failClosed } = require('./fail-closed');
const { ACS_ACCEPTED_MANIFEST_VERSIONS, ACS_SPEC_VERSION } = require('./version');

/**
 * The adapter name AWARE binds to.
 *
 * A manifest that names a different adapter is refused. Silently ignoring
 * the mismatch would bind a manifest to an engine the author did not
 * intend.
 */
const AWARE_ADAPTER = 'aware';

/**
 * The reserved reason for a manifest that cannot be used.
 */
const MANIFEST_INVALID = 'runtime_error:manifest_invalid';
const MANIFEST_UNREADABLE = 'runtime_error:manifest_unreadable';

/**
 * The path roots a manifest path may use.
 *
 * ACS SPEC section 3.2. The `policy_target` and `tool_name_from` fields
 * may use `$snap`, `$` or `$.name`. A transform path may use `$target`
 * only.
 */
const ALLOWED_ROOTS = Object.freeze({
  policyTarget: ['$snap', '$'],
  toolNameFrom: ['$snap', '$'],
  transform: ['$target'],
});

/**
 * Test whether a path uses an allowed root.
 *
 * @param {string} manifestPath - The path.
 * @param {string[]} allowed - The permitted roots.
 * @returns {boolean} True when the root is allowed.
 */
function hasAllowedRoot(manifestPath, allowed) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) return false;
  // `$` alone is the root alias. `$.name` is the member form. Anything
  // else must start with one of the named roots followed by `.` or `[`.
  if (manifestPath === '$') return allowed.includes('$');
  for (const root of allowed) {
    if (manifestPath === root) return true;
    if (manifestPath.startsWith(`${root}.`) || manifestPath.startsWith(`${root}[`)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a manifest against the pinned manifest schema and the manifest
 * rules the schema cannot express.
 *
 * @param {Object} manifest - The manifest to validate.
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 *   The validation result.
 */
function validateManifest(manifest) {
  const errors = [];

  let schema;
  try {
    schema = getSchema('manifest');
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: '$', message: `the manifest schema is unreadable: ${err.message}` }],
    };
  }

  let result;
  try {
    result = validate(manifest, schema);
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: '$', message: `the manifest could not be validated: ${err.message}` }],
    };
  }
  if (!result.valid) {
    return { ok: false, errors: result.errors };
  }

  // The manifest version must be one this adapter accepts.
  const version = manifest.agent_control_specification_version;
  if (!ACS_ACCEPTED_MANIFEST_VERSIONS.includes(version)) {
    errors.push({
      path: '$.agent_control_specification_version',
      message: `must be one of ${ACS_ACCEPTED_MANIFEST_VERSIONS.join(', ')}`,
    });
  }

  // Every policy the intervention points bind must EXIST in `policies`.
  const policies = manifest.policies || {};
  const points = manifest.intervention_points || {};
  for (const [pointName, point] of Object.entries(points)) {
    const binding = point && point.policy;
    if (!binding || typeof binding.id !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(policies, binding.id)) {
      errors.push({
        path: `$.intervention_points.${pointName}.policy.id`,
        message: `names a policy "${binding.id}" that the manifest does not define`,
      });
    }
  }

  // The manifest paths must use an allowed root (ACS SPEC section 3.2).
  for (const [pointName, point] of Object.entries(points)) {
    if (!point || typeof point !== 'object') continue;
    if (point.policy_target !== undefined
      && !hasAllowedRoot(point.policy_target, ALLOWED_ROOTS.policyTarget)) {
      errors.push({
        path: `$.intervention_points.${pointName}.policy_target`,
        message: 'must be rooted at $snap or $',
      });
    }
    if (point.tool_name_from !== undefined
      && !hasAllowedRoot(point.tool_name_from, ALLOWED_ROOTS.toolNameFrom)) {
      errors.push({
        path: `$.intervention_points.${pointName}.tool_name_from`,
        message: 'must be rooted at $snap or $',
      });
    }
  }

  // A `custom` policy must name an adapter this build understands.
  for (const [policyId, policy] of Object.entries(policies)) {
    if (!policy || policy.type !== 'custom') continue;
    if (policy.adapter !== AWARE_ADAPTER) {
      errors.push({
        path: `$.policies.${policyId}.adapter`,
        message: `names the adapter "${policy.adapter}", which this build does not implement`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Structural equality for the manifest merge rules.
 *
 * @param {*} a - The first value.
 * @param {*} b - The second value.
 * @returns {boolean} True when the values are structurally identical.
 */
function structurallyIdentical(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  if (!ka.every((k, i) => k === kb[i])) return false;
  return ka.every((k) => structurallyIdentical(a[k], b[k]));
}

/**
 * Merge a child manifest over a parent manifest.
 *
 * ACS SPEC section 2.2: "Repeated bindings for the same annotation at the
 * same intervention point MUST be structurally identical. Adding,
 * removing, or reordering `needs` entries is a merge conflict, as is
 * adding an empty `needs` array to a binding that omitted it. The loader
 * does not union dependency lists."
 *
 * @param {Object} parent - The parent manifest.
 * @param {Object} child - The child manifest, which wins.
 * @returns {{ok: boolean, manifest: Object|null, errors: Array}}
 *   The merged manifest, or the merge errors.
 */
function mergeManifests(parent, child) {
  const merged = {
    ...parent,
    ...child,
    policies: { ...(parent.policies || {}), ...(child.policies || {}) },
    tools: { ...(parent.tools || {}), ...(child.tools || {}) },
    annotators: { ...(parent.annotators || {}), ...(child.annotators || {}) },
    // The child's points are merged IN, not replaced by the parent's. A
    // child that binds a point the parent does not must keep that binding.
    intervention_points: {
      ...(parent.intervention_points || {}),
      ...(child.intervention_points || {}),
    },
    extends: [],
  };

  // An intervention point bound in BOTH manifests must be structurally
  // identical. A difference is a merge conflict.
  const conflicts = [];
  for (const [point, childPoint] of Object.entries(child.intervention_points || {})) {
    const parentPoint = (parent.intervention_points || {})[point];
    if (parentPoint === undefined) continue;
    if (!structurallyIdentical(parentPoint, childPoint)) {
      conflicts.push(point);
    }
  }
  if (conflicts.length > 0) {
    return {
      ok: false,
      manifest: null,
      errors: conflicts.map((point) => ({
        path: `$.intervention_points.${point}`,
        message: 'is bound differently in the parent and the child manifest',
      })),
    };
  }

  return { ok: true, manifest: merged, errors: [] };
}

/**
 * Parse a manifest from YAML or JSON text.
 *
 * The manifest is YAML in the upstream examples. AWARE has no YAML parser
 * in its dependency tree, and the task says not to add heavy dependencies.
 * JSON is a subset of YAML, so a JSON manifest loads unchanged. A YAML
 * manifest is read through a MINIMAL parser that covers the manifest
 * grammar, and anything it cannot parse is REFUSED rather than guessed.
 *
 * @param {string} text - The manifest text.
 * @returns {{ok: boolean, manifest: Object|null, errors: Array}}
 *   The parse result.
 */
function parseManifest(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      ok: false,
      manifest: null,
      errors: [{ path: '$', message: 'the manifest is empty' }],
    };
  }

  const trimmed = text.trim();

  // JSON first: it is a strict subset of YAML and needs no parser.
  if (trimmed.startsWith('{')) {
    try {
      return { ok: true, manifest: JSON.parse(trimmed), errors: [] };
    } catch (err) {
      return {
        ok: false,
        manifest: null,
        errors: [{ path: '$', message: `the manifest is not valid JSON: ${err.message}` }],
      };
    }
  }

  try {
    const { parseSimpleYaml } = require('./yaml');
    const manifest = parseSimpleYaml(trimmed);
    return { ok: true, manifest, errors: [] };
  } catch (err) {
    return {
      ok: false,
      manifest: null,
      errors: [{ path: '$', message: `the manifest is not valid YAML: ${err.message}` }],
    };
  }
}

/**
 * Load a manifest from a file.
 *
 * @param {string} filePath - The path to the manifest.
 * @returns {{ok: boolean, manifest: Object|null, errors: Array}}
 *   The load result.
 */
function loadManifestFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      manifest: null,
      errors: [{ path: '$', message: `the manifest is unreadable: ${err.message}` }],
    };
  }

  const parsed = parseManifest(text);
  if (!parsed.ok) return parsed;

  const validation = validateManifest(parsed.manifest);
  if (!validation.ok) {
    return { ok: false, manifest: parsed.manifest, errors: validation.errors };
  }
  return parsed;
}

/**
 * Resolve a manifest's `extends` chain.
 *
 * A parent may be a local path or a pinned HTTPS URL. Only HTTPS is
 * fetched, and only when the entry carries a pin. A parent that cannot be
 * resolved, fetched or merged makes the whole resolution FAIL.
 *
 * @param {Object} manifest - The manifest to resolve.
 * @param {Object} [options] - The resolver options.
 * @param {Function} [options.fetchParent] - Fetches a pinned HTTPS parent.
 *   It receives the extends entry and must return the manifest text.
 * @param {string} [options.baseDir] - The directory a relative parent path
 *   resolves against.
 * @param {number} [options.maxDepth] - The maximum extends depth.
 * @returns {Promise<{ok: boolean, manifest: Object|null, errors: Array}>}
 *   The resolved manifest.
 */
async function resolveExtends(manifest, options = {}) {
  const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 16;
  const errors = [];
  let current = manifest;
  let depth = 0;

  const parents = Array.isArray(manifest.extends) ? manifest.extends : [];

  while (parents.length > 0) {
    if (depth >= maxDepth) {
      errors.push({
        path: '$.extends',
        message: `the extends chain is deeper than the permitted ${maxDepth}`,
      });
      return { ok: false, manifest: null, errors };
    }

    const entry = parents[0];
    const rest = parents.slice(1);
    let parentText = null;

    if (typeof entry === 'string') {
      if (/^https:\/\//.test(entry)) {
        // A remote parent supplied as a bare string carries NO pin, so it
        // cannot be verified. The schema allows the string form, but an
        // UNPINNED remote parent is refused: fetching it would mean
        // trusting an unverifiable document.
        errors.push({
          path: '$.extends[0]',
          message: 'a remote parent must carry a sha256 or integrity pin',
        });
        return { ok: false, manifest: null, errors };
      }
      const base = options.baseDir || process.cwd();
      const filePath = path.isAbsolute(entry) ? entry : path.join(base, entry);
      try {
        parentText = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        errors.push({
          path: '$.extends[0]',
          message: `the parent manifest is unreadable: ${err.message}`,
        });
        return { ok: false, manifest: null, errors };
      }
    } else if (entry && typeof entry === 'object') {
      if (!entry.url || !/^https:\/\//.test(entry.url)) {
        errors.push({
          path: '$.extends[0].url',
          message: 'a remote parent must be an https URL',
        });
        return { ok: false, manifest: null, errors };
      }
      if (!entry.sha256 && !entry.integrity) {
        errors.push({
          path: '$.extends[0]',
          message: 'a remote parent must carry a sha256 or integrity pin',
        });
        return { ok: false, manifest: null, errors };
      }
      if (typeof options.fetchParent !== 'function') {
        errors.push({
          path: '$.extends[0]',
          message: 'no fetcher was supplied for the remote parent',
        });
        return { ok: false, manifest: null, errors };
      }
      try {
        parentText = await options.fetchParent(entry);
      } catch (err) {
        errors.push({
          path: '$.extends[0]',
          message: `the remote parent could not be fetched: ${err.message}`,
        });
        return { ok: false, manifest: null, errors };
      }
    } else {
      errors.push({ path: '$.extends[0]', message: 'the extends entry is not a string or an object' });
      return { ok: false, manifest: null, errors };
    }

    const parsed = parseManifest(parentText);
    if (!parsed.ok) {
      errors.push(...parsed.errors.map((e) => ({ path: '$.extends[0]', message: e.message })));
      return { ok: false, manifest: null, errors };
    }

    const parentValidation = validateManifest(parsed.manifest);
    if (!parentValidation.ok) {
      errors.push(
        ...parentValidation.errors.map((e) => ({ path: '$.extends[0]', message: e.message })),
      );
      return { ok: false, manifest: null, errors };
    }

    const merged = mergeManifests(parsed.manifest, current);
    if (!merged.ok) {
      errors.push(...merged.errors);
      return { ok: false, manifest: null, errors };
    }
    current = merged.manifest;

    // The parent's own extends chain continues the walk.
    const parentParents = Array.isArray(parsed.manifest.extends) ? parsed.manifest.extends : [];
    parents.length = 0;
    parents.push(...parentParents, ...rest);
    depth += 1;
  }

  return { ok: true, manifest: current, errors: [] };
}

/**
 * Build an ACS manifest from an AWARE policy set.
 *
 * The exported manifest binds AWARE's policy engine through the `custom`
 * policy type and this build's adapter name. The intervention points AWARE
 * enforces are bound; the others are not, because AWARE holds no policy
 * for them.
 *
 * @param {Object} options - The export options.
 * @param {string} [options.name] - The manifest name.
 * @param {string} [options.version] - The manifest version.
 * @param {string[]} [options.interventionPoints] - The points to bind.
 * @param {Object} [options.tools] - The tool catalogue to declare.
 * @param {string} [options.policyId] - The policy id to declare.
 * @returns {Object} The manifest.
 */
function exportManifest(options = {}) {
  const points = options.interventionPoints
    || ['pre_tool_call', 'post_tool_call', 'output'];
  const policyId = options.policyId || 'aware_policy';

  const interventionPoints = {};
  for (const point of points) {
    interventionPoints[point] = {
      policy_target: point === 'output' ? '$snap.output' : '$snap.tool_call.args',
      policy_target_kind: point === 'output' ? 'output' : 'tool_args',
      policy: { id: policyId },
    };
  }
  if (points.includes('pre_tool_call') || points.includes('post_tool_call')) {
    interventionPoints.pre_tool_call.tool_name_from = '$snap.tool_call.name';
  }

  return {
    agent_control_specification_version: ACS_SPEC_VERSION,
    metadata: {
      name: options.name || 'aware-policy',
      version: options.version || '1.0.0',
    },
    extends: [],
    policies: {
      [policyId]: { type: 'custom', adapter: AWARE_ADAPTER },
    },
    intervention_points: interventionPoints,
    tools: options.tools || {},
  };
}

/**
 * Render a manifest as YAML.
 *
 * The renderer covers the manifest grammar: mappings, sequences, scalars,
 * quoted strings, and the empty collection forms.
 *
 * @param {*} value - The value to render.
 * @returns {string} The YAML text.
 */
function toYaml(value) {
  // eslint-disable-next-line global-require
  const { renderYaml } = require('./yaml');
  return renderYaml(value);
}

module.exports = {
  AWARE_ADAPTER,
  ALLOWED_ROOTS,
  MANIFEST_INVALID,
  MANIFEST_UNREADABLE,
  hasAllowedRoot,
  validateManifest,
  structurallyIdentical,
  mergeManifests,
  parseManifest,
  loadManifestFile,
  resolveExtends,
  exportManifest,
  toYaml,
};
