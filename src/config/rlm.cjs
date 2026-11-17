// src/config/rlm.cjs — AWARE 2.0 RLM configuration loader
//
// Loads config/rlm.yaml, validates it against config/rlm.schema.json, and
// exposes the namespace via `rlmConfig.<field>` with the standard
// validate() / warnings() / snapshot() API (mirroring src/config/index.cjs).
//
// WHY THIS EXISTS (AWARE card t_0ff3a7b9)
// -----------------------------------------
// Two defects made the shipped RLM configuration inert:
//
//   1. config/rlm.yaml names `llm-judge` as the DEFAULT verification method,
//      but no implementation of that method existed in any verify.js copy —
//      the call fell through to `verify: unknown method 'llm-judge'`.
//   2. Nothing read config/rlm.yaml at runtime, so the configured default was
//      inert rather than actively throwing.
//
// (1) is fixed in the verify layer (backend/heavy-think/src/verify.js now
// implements `llm-judge` and derives its method registry from the
// implementation). This module closes (2) AND adds the guard that keeps the
// two in step:
//
//   THE METHOD GUARD. A configured `defaultMethod` or `allowedMethods` entry
//   that no implementation can service is REJECTED AT LOAD TIME with a
//   message naming the offending method and the implemented set — not at
//   first use, where it would surface as an opaque verification failure on
//   every RLM leaf.
//
// The guard is deliberately stronger than the JSON Schema: the schema's
// `enum` lists the methods that are POLICY-legal, while the guard checks
// that each of those is actually IMPLEMENTED. The defect above passed the
// schema check — `llm-judge` was in the enum — and still had no
// implementation. That gap is exactly what this guard closes.
//
// Public API:
//   require('./config/rlm.cjs')            // CJS consumers
//   import rlmConfig from './config/rlm.cjs' // ESM consumers (default export)
//   loadRlmConfig(opts)                    // load + validate + guard (throws)
//   rlmConfig.validate()                   // throws on hard failures
//   rlmConfig.warnings()                   // string[] of soft warnings
//   rlmConfig.snapshot()                   // JSON-serializable view
//   rlmConfig.path                         // resolved config path
//   rlmConfig.available                    // false when the file is absent
//   IMPLEMENTED_VERIFICATION_METHODS       // methods with an implementation
//
// Env overrides (documented in docs/rlm.md):
//   AWARE_RLM_CONFIG_PATH
//   AWARE_RLM_ENABLED
//   AWARE_RLM_BUDGET_USD
//   AWARE_RLM_KILL_SWITCH
//   AWARE_RLM_FORWARDED_OPTIONS_VERIFICATION_ALLOWED_METHODS
//   AWARE_RLM_FORWARDED_OPTIONS_VERIFICATION_DEFAULT_METHOD

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config', 'rlm.yaml');
const DEFAULT_SCHEMA_PATH = path.resolve(__dirname, '..', '..', 'config', 'rlm.schema.json');

// The verification methods that have an implementation, as of this writing.
//
// This is a MIRROR of backend/heavy-think/src/verify.js's exported
// VERIFICATION_METHOD_NAMES. The live registry is preferred at runtime (see
// resolveImplementedVerificationMethods) — this constant is the fallback for
// environments where the vendored heavy-think copy is not present (e.g. the
// published npm package, which does not ship backend/).
//
// The mirror is drift-checked by test/unit/config/rlm-loader.test.js, which
// asserts the two lists are identical whenever the vendored copy is
// available. A change to the implementation that is not mirrored fails CI.
const MIRRORED_IMPLEMENTED_VERIFICATION_METHODS = Object.freeze([
  'exec',
  'test_suite',
  'citation_check',
  'kg_consistency',
  'none',
  'llm-judge',
]);

// ─── helpers ────────────────────────────────────────────────────────────────

function loadYaml(text) {
  // js-yaml is a production dependency (see package.json) — the loader runs
  // at boot, so a devDependency would break the container build.
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch (err) {
    throw new Error(
      `Config: js-yaml is required to load the RLM configuration but is not installed (${err.message}). ` +
      'Run `npm install` before using rlmConfig.'
    );
  }
  return yaml.load(text);
}

function validateAgainstSchema(data, schemaPath) {
  let Ajv;
  let schema;
  try {
    Ajv = require('ajv');
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    throw new Error(`Config: could not load the RLM JSON Schema at ${schemaPath} (${err.message})`);
  }
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    const details = (validate.errors || [])
      .map((e) => `${e.instancePath || '<root>'} ${e.message}`)
      .join('; ');
    throw new Error(`Config: ${schemaPath} validation failed: ${details}`);
  }
}

// ─── the method guard ───────────────────────────────────────────────────────

/**
 * Reject a configuration that names a verification method with no
 * implementation behind it.
 *
 * This is the guard the card asked for: the failure must happen at config
 * LOAD time, with a message that names both the offending method and the
 * set of methods that ARE implemented.
 */
function assertVerificationMethodsImplementable(config, implemented) {
  const verification = config?.rlm?.forwardedOptions?.verification;
  if (!verification) return;

  const implementedSet = new Set(implemented);
  const problems = [];

  const allowed = Array.isArray(verification.allowedMethods) ? verification.allowedMethods : [];
  for (const method of allowed) {
    if (!implementedSet.has(method)) {
      problems.push(`allowedMethods contains '${method}', which has no implementation`);
    }
  }

  if (verification.defaultMethod && !implementedSet.has(verification.defaultMethod)) {
    problems.push(
      `defaultMethod is '${verification.defaultMethod}', which has no implementation`
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Config: the RLM configuration names verification methods that cannot be serviced — ${problems.join('; ')}. ` +
      `Implemented verification methods: ${implemented.join(', ')}. ` +
      'Either implement the method or change the configured value.'
    );
  }
}

/**
 * The configured default must be one of the allowed methods. A default that
 * is not in the allow-list is a policy contradiction (and would be silently
 * widened or rejected by the consumer).
 */
function assertDefaultMethodAllowed(config) {
  const verification = config?.rlm?.forwardedOptions?.verification;
  if (!verification) return;
  const allowed = Array.isArray(verification.allowedMethods) ? verification.allowedMethods : [];
  const def = verification.defaultMethod;
  if (def && allowed.length > 0 && !allowed.includes(def)) {
    throw new Error(
      `Config: rlm.forwardedOptions.verification.defaultMethod '${def}' is not in allowedMethods [${allowed.join(', ')}].`
    );
  }
}

// ─── env overrides ──────────────────────────────────────────────────────────

function applyEnvOverrides(config, env) {
  const e = env || process.env;
  const out = deepClone(config);

  if (e.AWARE_RLM_ENABLED !== undefined && e.AWARE_RLM_ENABLED !== '') {
    out.rlm.enabled = e.AWARE_RLM_ENABLED === '1' || e.AWARE_RLM_ENABLED === 'true';
  }
  if (e.AWARE_RLM_BUDGET_USD !== undefined && e.AWARE_RLM_BUDGET_USD !== '') {
    const n = Number(e.AWARE_RLM_BUDGET_USD);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `Config: AWARE_RLM_BUDGET_USD=${JSON.stringify(e.AWARE_RLM_BUDGET_USD)} is not a non-negative number`
      );
    }
    out.rlm.budgetUsd = n;
  }
  if (e.AWARE_RLM_KILL_SWITCH !== undefined && e.AWARE_RLM_KILL_SWITCH !== '') {
    out.rlm.killSwitch = e.AWARE_RLM_KILL_SWITCH === '1' || e.AWARE_RLM_KILL_SWITCH === 'true';
  }

  const allowedRaw = e.AWARE_RLM_FORWARDED_OPTIONS_VERIFICATION_ALLOWED_METHODS;
  if (allowedRaw !== undefined && allowedRaw !== '') {
    const methods = String(allowedRaw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (methods.length === 0) {
      throw new Error(
        'Config: AWARE_RLM_FORWARDED_OPTIONS_VERIFICATION_ALLOWED_METHODS was set but lists no methods.'
      );
    }
    out.rlm.forwardedOptions.verification.allowedMethods = methods;
  }

  const defaultRaw = e.AWARE_RLM_FORWARDED_OPTIONS_VERIFICATION_DEFAULT_METHOD;
  if (defaultRaw !== undefined && defaultRaw !== '') {
    out.rlm.forwardedOptions.verification.defaultMethod = String(defaultRaw).trim();
  }

  return out;
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
  return out;
}

// ─── implemented-method resolution ──────────────────────────────────────────

/**
 * Prefer the LIVE registry exported by the vendored heavy-think verify.js, so
 * the guard checks against the implementation rather than against a list that
 * could drift. Falls back to the mirrored constant when the vendored copy is
 * not present (the published npm package does not ship backend/).
 */
function liveVerifyJsCandidates(env) {
  const e = env || process.env;
  const out = [];

  // 1. The DEPLOYED tree: the directory of AWARE_RL_PIPELINE_PATH. In the
  //    container that is /app/rl-pipeline/src — the copy whose method set
  //    decides whether the configured defaultMethod can actually run.
  const fromEnv = e.AWARE_RL_PIPELINE_PATH;
  if (fromEnv && String(fromEnv).trim()) {
    out.push({
      path: path.join(path.dirname(path.resolve(String(fromEnv).trim())), 'verify.js'),
      source: 'deployed',
    });
  }

  // 2. The dev layout's sibling checkout — what a developer runs against
  //    when the env var is unset.
  out.push({
    path: path.resolve(__dirname, '..', '..', '..', 'rl-pipeline', 'src', 'verify.js'),
    source: 'dev-layout',
  });

  // 3. The repo's vendored copy — what the test-suite and a source checkout
  //    run against.
  out.push({
    path: path.resolve(__dirname, '..', '..', 'backend', 'heavy-think', 'src', 'verify.js'),
    source: 'vendored',
  });

  return out;
}

/**
 * Resolve the implemented verification methods from the rl-pipeline copy the
 * coordinator ACTUALLY LOADS.
 *
 * The previous implementation checked the repo's vendored copy FIRST and
 * fell back to a hard-coded mirror when it was absent. In the container the
 * repo copy does not exist, so the guard silently checked the MIRROR — a
 * list claiming `llm-judge` is implemented while the deployed verify.js had
 * no `llm-judge` at all. The guard passed on exactly the build that broke.
 *
 * So the resolution is LIVE-first, and a live copy that cannot be
 * introspected is a HARD FAILURE, not a fallback: a build that predates the
 * VERIFICATION_METHOD_NAMES registry cannot be checked against the
 * configured methods, and silently trusting a mirror is the defect this
 * card exists to remove.
 *
 * The mirror remains the answer only when NO live copy exists at all (the
 * published npm package does not ship backend/ or a sibling checkout).
 */
function resolveImplementedVerificationMethods(env) {
  const candidates = liveVerifyJsCandidates(env);

  // The FIRST candidate that EXISTS is the tree the coordinator actually
  // runs, and it is DECISIVE. There is no "try the next one" — the next
  // candidate is a different tree, and answering for it proves nothing
  // about the one in production.
  //
  // This is the defect the card exists to remove: the previous loop
  // `continue`d past a candidate it could not introspect and kept
  // looking, so an un-introspectable DEPLOYED verify.js was answered by
  // the repo's vendored copy. The guard then passed on exactly the build
  // that could not service the configured defaultMethod.
  const existing = candidates.filter((c) => fs.existsSync(c.path));
  if (existing.length === 0) {
    // No live copy at all: the published npm package does not ship
    // backend/ and there is no sibling checkout. The mirror is the only
    // answer available, and it is a declaration, not a measurement.
    return MIRRORED_IMPLEMENTED_VERIFICATION_METHODS;
  }

  const candidate = existing[0];
  let mod;
  try {
    // require() of an ES module works on Node >= 22.12; older runtimes and
    // any load failure mean the registry is unavailable.
    mod = require(candidate.path);
  } catch (err) {
    throw new Error(
      `Config: the rl-pipeline copy that implements the verification methods could not be introspected — ` +
      `${candidate.path} (${candidate.source}) — it could not be loaded (${err.message}). ` +
      'A build whose verify.js cannot be loaded cannot be checked against the ' +
      'configured verification methods, so the configured defaultMethod/allowedMethods cannot be proven serviceable. ' +
      'Rebuild the coordinator image from a tree whose rl-pipeline ships the registry.'
    );
  }

  const names = mod && mod.VERIFICATION_METHOD_NAMES;
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(
      `Config: the rl-pipeline copy that implements the verification methods could not be introspected — ` +
      `${candidate.path} (${candidate.source}) — it does not export VERIFICATION_METHOD_NAMES. ` +
      'A build whose verify.js predates the VERIFICATION_METHOD_NAMES registry cannot be checked against the ' +
      'configured verification methods, so the configured defaultMethod/allowedMethods cannot be proven serviceable. ' +
      'Rebuild the coordinator image from a tree whose rl-pipeline ships the registry.'
    );
  }

  return Object.freeze([...names]);
}

let implementedMethods = null;

/**
 * The implemented verification methods.
 *
 * Pass { env } to resolve against a specific environment (the loader does
 * this so a test can point the resolution at a fixture tree). Without it
 * the answer is cached for the process lifetime.
 */
function getImplementedVerificationMethods(opts = {}) {
  if (opts && opts.env) {
    return resolveImplementedVerificationMethods(opts.env);
  }
  if (!implementedMethods) implementedMethods = resolveImplementedVerificationMethods();
  return implementedMethods;
}

// ─── loading ────────────────────────────────────────────────────────────────

/**
 * Load, validate and guard the RLM configuration.
 *
 * Throws on: a missing file, a YAML parse error, a schema violation, an
 * env-override that is malformed, a default method outside the allow-list,
 * and — the point of the exercise — a configured method with no
 * implementation behind it.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.config]      Pre-parsed config object (skips the file read).
 * @param {string} [opts.configPath]  Override the config file path.
 * @param {string} [opts.schemaPath]  Override the schema file path.
 * @param {Object} [opts.env]         Environment to read overrides from.
 * @param {boolean} [opts.validateSchema=true]
 * @param {boolean} [opts.guard=true]  Set false to skip the method guard.
 */
function loadRlmConfig(opts = {}) {
  const env = opts.env || process.env;
  const configPath = opts.configPath || env.AWARE_RLM_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const schemaPath = opts.schemaPath || DEFAULT_SCHEMA_PATH;

  let parsed;
  if (opts.config) {
    parsed = deepClone(opts.config);
  } else {
    let text;
    try {
      text = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
      const missing = new Error(
        `Config: could not read the RLM configuration at ${configPath} (${err.message}). ` +
        'Set AWARE_RLM_CONFIG_PATH or ship config/rlm.yaml with the deployment.'
      );
      // Tagged so rlmConfig.validate() can tell "not deployed" from "deployed
      // and broken": an absent config means the RLM is simply not configured,
      // while an invalid one must fail the boot.
      missing.code = 'RLM_CONFIG_MISSING';
      throw missing;
    }
    parsed = loadYaml(text);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Config: the RLM configuration at ${configPath} did not parse to an object.`);
  }

  const withOverrides = applyEnvOverrides(parsed, env);

  // ORDER MATTERS — the method guard runs BEFORE the JSON Schema check.
  //
  // The schema's `enum` says which methods are POLICY-legal; the guard says
  // which are actually IMPLEMENTED. The defect this card closes passed the
  // schema check (`llm-judge` was in the enum) and still had no
  // implementation, so the schema alone is not sufficient — but when both
  // would fire, the guard's message is the actionable one: it names the
  // offending method AND the set of methods that do work. A bare
  // "should be equal to one of the allowed values" leaves the operator
  // guessing. So the guard wins, and the schema still runs afterwards to
  // catch the cases the guard cannot see (e.g. a method that IS implemented
  // but is not policy-legal, such as 'test_suite').
  if (opts.guard !== false) {
    // Resolve against the SAME env the loader applied overrides with, so a
    // deployment's AWARE_RL_PIPELINE_PATH points the guard at the copy the
    // coordinator will actually load.
    assertVerificationMethodsImplementable(withOverrides, getImplementedVerificationMethods({ env }));
    assertDefaultMethodAllowed(withOverrides);
  }

  if (opts.validateSchema !== false) {
    validateAgainstSchema(withOverrides, schemaPath);
  }

  return { config: withOverrides, path: configPath, schemaPath };
}

// ─── the namespace ──────────────────────────────────────────────────────────

let cached = null;

function getLoaded() {
  if (!cached) cached = loadRlmConfig();
  return cached;
}

// Top-level fields of the `rlm:` mapping in config/rlm.yaml, exposed
// directly on rlmConfig so `rlmConfig.audit.preferencePair.schema` works as
// documented in docs/rlm.md.
const RLM_FIELD_NAMES = [
  'enabled',
  'budgetUsd',
  'tree',
  'context',
  'forwardedOptions',
  'tools',
  'workspaceDir',
  'decompositionFormat',
  'decompositionScope',
  'sandbox',
  'audit',
  'fewShotExamples',
  'killSwitch',
];

const rlmConfig = {
  /** Resolved path of the loaded configuration file. */
  get path() {
    return getLoaded().path;
  },

  /** False when the configuration file is absent (nothing loaded yet). */
  get available() {
    try {
      getLoaded();
      return true;
    } catch {
      return false;
    }
  },

  /** The `errors:` mapping from the configuration. */
  get errors() {
    return getLoaded().config.errors;
  },

  /** The raw parsed configuration object. */
  get raw() {
    return getLoaded().config;
  },

  /** The verification methods that have an implementation. */
  get implementedVerificationMethods() {
    return getImplementedVerificationMethods();
  },

  /**
   * Hard validation. Throws on an invalid configuration.
   *
   * Returns FALSE when the configuration file is ABSENT — an absent file
   * means the RLM is simply not configured on this deployment, which is not
   * a boot failure. A file that IS present but invalid (a schema violation,
   * a default method outside the allow-list, or — the point of the exercise
   * — a configured verification method with no implementation behind it)
   * throws. This is what makes the guard a BOOT-TIME check rather than a
   * first-use failure: the caller invokes validate() at startup.
   */
  validate() {
    try {
      getLoaded();
    } catch (err) {
      if (err && err.code === 'RLM_CONFIG_MISSING') return false;
      throw err;
    }
    return true;
  },

  /** Soft warnings — surfaced, not thrown. */
  warnings() {
    const out = [];
    let cfg;
    try {
      cfg = getLoaded().config;
    } catch (err) {
      return [`RLM configuration could not be loaded: ${err.message}`];
    }
    const verification = cfg?.rlm?.forwardedOptions?.verification;
    if (verification?.defaultMethod === 'exec') {
      out.push(
        'rlm.forwardedOptions.verification.defaultMethod is "exec" — a code-execution vector; the sandbox policy is the only constraint.'
      );
    }
    if (cfg?.rlm?.budgetUsd === null || cfg?.rlm?.budgetUsd === undefined) {
      out.push('rlm.budgetUsd is unset — no per-call budget cap is enforced (cost is recorded, not limited).');
    }
    if (cfg?.rlm?.sandbox?.landlock === 'linux-only') {
      out.push('rlm.sandbox.landlock is linux-only — macOS deployments run with the documented caveat.');
    }
    return out;
  },

  /** JSON-serializable view of the active configuration. */
  snapshot() {
    const loaded = getLoaded();
    return {
      path: loaded.path,
      rlm: loaded.config.rlm,
      errors: loaded.config.errors,
      implementedVerificationMethods: getImplementedVerificationMethods(),
      warnings: rlmConfig.warnings(),
    };
  },
};

for (const name of RLM_FIELD_NAMES) {
  Object.defineProperty(rlmConfig, name, {
    enumerable: true,
    configurable: true,
    get() {
      return getLoaded().config.rlm[name];
    },
  });
}

module.exports = rlmConfig;
module.exports.default = rlmConfig;
module.exports.loadRlmConfig = loadRlmConfig;
module.exports.getImplementedVerificationMethods = getImplementedVerificationMethods;
module.exports.IMPLEMENTED_VERIFICATION_METHODS = getImplementedVerificationMethods();
module.exports.MIRRORED_IMPLEMENTED_VERIFICATION_METHODS = MIRRORED_IMPLEMENTED_VERIFICATION_METHODS;
module.exports.assertVerificationMethodsImplementable = assertVerificationMethodsImplementable;
module.exports.__probe = true;
module.exports.resolveImplementedVerificationMethods = resolveImplementedVerificationMethods;
module.exports.liveVerifyJsCandidates = liveVerifyJsCandidates;
