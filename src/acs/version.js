// src/acs/version.js
// Pinned upstream versions for the ACS adapter.
//
// EVERY ACS-specific constant lives here or is derived from here. A spec
// bump must touch this file, the vendored schemas under docs/acs/schemas/,
// and the hash table in test/unit/acs/schema-drift.test.js. Nothing else.
//
// See docs/acs/VERSION for the human-readable pin and docs/acs/DESIGN.md
// §7 finding F-1 for why the release tag and the manifest version differ.

'use strict';

/**
 * The ACS release this adapter is written against.
 * Release tag: v0.4.0-beta.2 (2026-11-04)
 */
const ACS_RELEASE_TAG = 'v0.4.0-beta.2';

/**
 * The commit the release tag points at. This is the reproducibility anchor.
 */
const ACS_COMMIT = 'b11ae38b1bd53d299789c1724f4f94f80a0c6540';

/**
 * The tree object of the pinned commit. Recorded so a reviewer can prove
 * the vendored schemas came from a known tree, not a moving branch.
 */
const ACS_TREE = '51781ee9be8a56eb86cf304448facf80076ca9be';

/**
 * The manifest-declared spec version this adapter targets.
 *
 * This is NOT the release tag. The pinned manifest schema accepts exactly
 * two manifest version strings (0.4.0-alpha.1 and 0.5.0-alpha.1), and the
 * spec text at the pinned tag already describes 0.5.0-alpha.1 behaviour.
 */
const ACS_SPEC_VERSION = '0.5.0-alpha.1';

/**
 * The older manifest version this adapter also accepts, for hosts that
 * have not moved to the staged-annotation semantics of 0.5.0-alpha.1.
 */
const ACS_SPEC_VERSION_COMPAT = '0.4.0-alpha.1';

/**
 * Every manifest version this adapter accepts.
 */
const ACS_ACCEPTED_MANIFEST_VERSIONS = Object.freeze([
  ACS_SPEC_VERSION,
  ACS_SPEC_VERSION_COMPAT,
]);

/**
 * The Agent Hooks commit the receipt (interception record) schema is taken
 * from. ACS defines the receipt by reference to AGENT-HOOKS-0.1 section
 * 10.3 rather than shipping its own copy.
 */
const AGENT_HOOKS_COMMIT = '7e13a74b34af30f2049d902cc656c247c81d2f95';

/**
 * The upstream project the adapter implements.
 */
const ACS_UPSTREAM = 'https://github.com/responsibleai/agent-control-spec';

/**
 * The reference host implementation whose AgentControl/HostSession shape the
 * AWARE host adapter mirrors.
 */
const AGT_UPSTREAM = 'https://github.com/microsoft/agent-governance-toolkit';

/**
 * The eight closed intervention points (ACS SPEC section 4, Agent Hooks
 * interception-point schema).
 */
const INTERVENTION_POINTS = Object.freeze([
  'agent_startup',
  'input',
  'pre_model_call',
  'post_model_call',
  'pre_tool_call',
  'post_tool_call',
  'output',
  'agent_shutdown',
]);

/**
 * The intervention points AWARE enforces policy for in Phase 1. The other
 * five are accepted and answered with a well-formed verdict, but AWARE
 * holds no policy for them yet.
 */
const ENFORCED_INTERVENTION_POINTS = Object.freeze([
  'pre_tool_call',
  'post_tool_call',
  'output',
]);

/**
 * The two enforcement modes. Omitted mode defaults to enforce (ACS
 * request.schema.json).
 */
const ENFORCEMENT_MODES = Object.freeze(['enforce', 'evaluate_only']);

module.exports = {
  ACS_RELEASE_TAG,
  ACS_COMMIT,
  ACS_TREE,
  ACS_SPEC_VERSION,
  ACS_SPEC_VERSION_COMPAT,
  ACS_ACCEPTED_MANIFEST_VERSIONS,
  AGENT_HOOKS_COMMIT,
  ACS_UPSTREAM,
  AGT_UPSTREAM,
  INTERVENTION_POINTS,
  ENFORCED_INTERVENTION_POINTS,
  ENFORCEMENT_MODES,
};
