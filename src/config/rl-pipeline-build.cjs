// src/config/rl-pipeline-build.cjs — deployed-judge-path build integrity
//
// WHY THIS EXISTS (AWARE card t_091892e3)
// -----------------------------------------
// The coordinator's judge path (rl-pipeline) used to be CLONED from an
// external git server at a pinned tag, while the repo carried its own
// vendored copy at backend/heavy-think/. The two were DIFFERENT
// implementations of the same judge modules and nothing compared them, so
// the deployed image could carry a verify.js with no `llm-judge` while
// config/rlm.yaml named `llm-judge` as the default verification method.
// The declared default was inert: 329,627 of 329,639 live preference pairs
// carried verification.method == 'none'.
//
// The image now ships the reviewed tree (Dockerfile.coordinator copies
// backend/heavy-think/src into /app/rl-pipeline/src), so build-time drift
// is impossible BY CONSTRUCTION. This module closes the remaining half:
// the RUNTIME check that the tree the coordinator is actually executing
// is byte-for-byte the tree that was reviewed.
//
// The check is deliberately NOT a "does the method exist" check — that is
// the loader's method guard (src/config/rlm.cjs). This one answers a
// different question: is the code that will run the code we shipped?
//
// Public API:
//   resolveLiveRlPipelineDirs(env)  → candidate dirs of the LIVE rl-pipeline
//   readSourceManifest(dir)         → parsed sha256 manifest (or null)
//   computeSourceManifest(dir)      → { relPath: sha256 }
//   verifyDeployedJudgePath(opts)   → { ok, problems, ... }

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_NAME = 'SOURCE-SHA256SUMS';

// The repo's vendored copy. This is the tree the image ships, so it is
// also the tree the manifest is generated from.
const REPO_VENDORED_DIR = path.resolve(
  __dirname, '..', '..', 'backend', 'heavy-think', 'src'
);

// ─── locating the live tree ─────────────────────────────────────────────────

/**
 * The directories that could hold the rl-pipeline the coordinator actually
 * loads, in priority order.
 *
 * 1. The directory of `AWARE_RL_PIPELINE_PATH` (the container's
 *    /app/rl-pipeline/src/index.js). This is the DEPLOYED tree — the one
 *    the image ships and the one the build wrote a manifest for.
 * 2. The dev layout's sibling checkout (../../../rl-pipeline/src), which
 *    is what a developer runs against when the env var is unset.
 *
 * Directories that do not exist are skipped by the caller.
 *
 * Each entry carries its `source` because the two are NOT interchangeable:
 * the deployed tree is the artefact under the build's control and MUST
 * carry the manifest; the dev-layout tree is a developer's own checkout of
 * the upstream library and never will.
 */
function resolveLiveRlPipelineDirs(env) {
  const e = env || process.env;
  const dirs = [];

  const fromEnv = e.AWARE_RL_PIPELINE_PATH;
  if (fromEnv && String(fromEnv).trim()) {
    dirs.push({
      path: path.dirname(path.resolve(String(fromEnv).trim())),
      source: 'deployed',
    });
  }

  // src/config/rl-pipeline-build.cjs → src/config → src → <repo root>
  //                                          → ../../.. → parent of repo
  const devLayout = path.resolve(__dirname, '..', '..', '..', 'rl-pipeline', 'src');
  if (!dirs.some((d) => d.path === devLayout)) {
    dirs.push({ path: devLayout, source: 'dev-layout' });
  }

  return dirs;
}

// ─── the sha256 manifest ────────────────────────────────────────────────────

/**
 * The manifest lives in the rl-pipeline ROOT (the parent of src/), because
 * that is where the Dockerfile writes it: one manifest describing every
 * source file of the shipped library.
 */
function manifestPathFor(srcDir) {
  return path.join(path.dirname(srcDir), MANIFEST_NAME);
}

/**
 * Parse a `sha256sum`-style manifest into { relPath: sha256 }.
 * Lines that do not parse are ignored (a truncated manifest must not
 * silently become "no files checked").
 */
function parseManifest(text) {
  const out = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (!m) continue;
    out[m[2].trim().replace(/^\.\//, '')] = m[1];
  }
  return out;
}

function readSourceManifest(srcDir) {
  const manifestPath = manifestPathFor(srcDir);
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
  const entries = parseManifest(text);
  return Object.keys(entries).length > 0 ? entries : null;
}

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/**
 * Compute { relPath: sha256 } for every .js file under srcDir, relative to
 * srcDir. Matches the manifest's key space (the Dockerfile generates the
 * manifest with `cd src && sha256sum <files>`).
 */
function computeSourceManifest(srcDir) {
  const out = {};
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    const abs = path.join(entry.parentPath || entry.path, entry.name);
    const rel = path.relative(srcDir, abs).split(path.sep).join('/');
    out[rel] = sha256File(abs);
  }
  return out;
}

// ─── the verification ───────────────────────────────────────────────────────

/**
 * Verify that the live rl-pipeline tree is byte-for-byte the tree that was
 * reviewed and shipped.
 *
 * Returns { ok, problems, srcDir, manifestPath, checked, source }.
 *
 * `ok` is TRUE when there is nothing to complain about. Note the two
 * distinct "nothing to check" cases, which are NOT failures:
 *   - no live tree was located (the caller is not running against a
 *     deployed rl-pipeline) — `source: 'none'`.
 *   - a live tree was located but carries no manifest — `source: 'unmanifested'`.
 *
 * A tree WITH a manifest whose files do not match is a FAILURE: that is
 * exactly the drift this card exists to catch.
 *
 * D3 (Sentinel review of t_091892e3): the `unmanifested` case is only
 * acceptable for a tree the build does not own. The DEPLOYED tree
 * (/app/rl-pipeline/src) is written by the Dockerfile, which always emits
 * the manifest — so a deployed tree WITHOUT one is a tree that was
 * replaced or patched after the build, and reporting `ok: true` for it
 * makes the drift check a no-op that claims success. That is the case
 * the live image hit, and it is why the check was inert exactly when it
 * was needed. A deployed tree with no manifest now FAILS.
 */
function verifyDeployedJudgePath(opts = {}) {
  const env = opts.env || process.env;
  const dirs = resolveLiveRlPipelineDirs(env);

  let srcDir = null;
  let srcSource = null;
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir.path, 'index.js'))) {
      srcDir = dir.path;
      srcSource = dir.source;
      break;
    }
  }

  if (!srcDir) {
    return {
      ok: true,
      source: 'none',
      srcDir: null,
      problems: [],
      checked: 0,
      note:
        'no live rl-pipeline tree was located; the deployed-judge-path check did not apply',
    };
  }

  const manifest = readSourceManifest(srcDir);
  if (!manifest) {
    if (srcSource === 'deployed') {
      // The deployed tree is the build's own output and MUST carry the
      // manifest the build wrote. Its absence means the tree was
      // replaced after the build — exactly the drift this check exists to
      // catch, and reporting ok:true here would make the check inert.
      return {
        ok: false,
        source: 'unmanifested',
        srcDir,
        manifestPath: manifestPathFor(srcDir),
        problems: [
          `the deployed rl-pipeline tree at ${srcDir} carries no ${MANIFEST_NAME}; ` +
          'the build writes that manifest for every image it produces, so its absence ' +
          'means the tree was replaced or patched after the build and cannot be verified ' +
          'against the reviewed sources',
        ],
        checked: 0,
      };
    }
    return {
      ok: true,
      source: 'unmanifested',
      srcDir,
      problems: [],
      checked: 0,
      note:
        `the live rl-pipeline tree at ${srcDir} carries no ${MANIFEST_NAME}; ` +
        'it predates the build-integrity manifest and was not byte-compared',
    };
  }

  const actual = computeSourceManifest(srcDir);
  const problems = [];

  for (const [rel, expected] of Object.entries(manifest)) {
    const abs = path.join(srcDir, rel);
    if (!fs.existsSync(abs)) {
      problems.push(`${rel} is in the manifest but missing from the live tree`);
      continue;
    }
    const got = actual[rel];
    if (got !== expected) {
      problems.push(
        `${rel} does not match the shipped manifest (expected sha256 ${expected.slice(0, 12)}…, got ${String(got).slice(0, 12)}…)`
      );
    }
  }

  // A file present in the live tree but absent from the manifest is also
  // drift: the manifest is the definition of what was shipped.
  for (const rel of Object.keys(actual)) {
    if (!(rel in manifest)) {
      problems.push(`${rel} is present in the live tree but not in the shipped manifest`);
    }
  }

  return {
    ok: problems.length === 0,
    source: 'manifest',
    srcDir,
    manifestPath: manifestPathFor(srcDir),
    problems,
    checked: Object.keys(manifest).length,
  };
}

module.exports = {
  MANIFEST_NAME,
  REPO_VENDORED_DIR,
  resolveLiveRlPipelineDirs,
  readSourceManifest,
  computeSourceManifest,
  parseManifest,
  manifestPathFor,
  verifyDeployedJudgePath,
};
