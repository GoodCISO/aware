/**
 * test/unit/scripts/pre-push-filter.test.js
 *
 * Regression tests for the Layer-2 privacy filter (scripts/hooks/pre-push).
 *
 * THE BUG CLASS THIS FILE EXISTS TO KILL
 * ───────────────────────────────────────
 * The pre-push hook used to scan the WORKING TREE while git pushes the
 * COMMITTED BLOB. That subject/scope mismatch produced two mirror-image
 * defects, both proven by execution before they were fixed:
 *
 *   (a) FALSE PASS — a host-path/secret in the committed blob sailed
 *       through whenever the working-tree copy had been cleaned. A privacy
 *       filter that passes what it was built to block is worse than no
 *       filter, because it is trusted.
 *
 *   (b) FALSE BLOCK — a pattern present only in the working tree blocked a
 *       push of unrelated, clean content. This is what stopped the
 *       governed token stack from reaching origin/main on 2026-11-05: an
 *       uncommitted comment in severityRamp.js blocked a push of the
 *       entire token programme.
 *
 * The fix (hook v4) materialises each changed file's blob from the tree
 * being pushed and scans THAT. These tests pin both directions so the
 * class cannot silently return.
 *
 * The tests drive the REAL hook script through a REAL git repository, so
 * they exercise the actual gitleaks invocation and the actual diff-range
 * computation — not a re-implementation of them.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const HOOK_SRC = path.join(REPO_ROOT, 'scripts/hooks/pre-push');
const GITLEAKS_TOML = path.join(REPO_ROOT, '.gitleaks.toml');

// The fixture MUST contain a host path (that is precisely what the filter is
// meant to block), but this SOURCE FILE must not contain one: the repo's own
// pre-commit gitleaks pass scans staged content, so a literal `~/.` + name
// here would block the very commit that adds this test — the same
// false-block class the hook fix is about, in a different layer.
// Build the pattern at runtime instead. The scanner sees a clean source
// file; the test still writes a real host path into the git blob it plants.
// NOTE: the rule is `~/\.[a-z]+/`, so the dot is load-bearing — '~/' + 'hermes'
// would NOT match it, and the test would silently stop testing anything.
const LEAK = 'export const a = 1; // ~/' + '.' + 'hermes/leak\n';
const CLEAN = 'export const a = 1;\n';
// A second clean payload, distinct from CLEAN, so a commit carrying it is a
// real change rather than an empty commit. Used where the test needs the
// pushed blob to DIFFER from the baseline.
const CLEAN2 = 'export const a = 2;\n';

let TMP = null;
let REPO = null;
let ORIGIN = null;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function hasGitleaks() {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run the pre-push hook as git would: one ref line on stdin. */
function runHook(localSha, remoteSha) {
  const out = execFileSync(
    'bash',
    [path.join(REPO, '.git/hooks/pre-push'), 'origin', 'https://example.invalid/x.git'],
    {
      cwd: REPO,
      input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  return out;
}

function runHookExpectingFailure(localSha, remoteSha) {
  try {
    const out = execFileSync(
      'bash',
      [path.join(REPO, '.git/hooks/pre-push'), 'origin', 'https://example.invalid/x.git'],
      {
        cwd: REPO,
        input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aware-prepush-'));
  REPO = path.join(TMP, 'repo');
  ORIGIN = path.join(TMP, 'origin.git');
  fs.mkdirSync(path.join(REPO, '.git/hooks'), { recursive: true });

  // The hook needs the repo's scripts/ and .gitleaks.toml to exist.
  fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(REPO, 'scripts'), { recursive: true });
  fs.copyFileSync(GITLEAKS_TOML, path.join(REPO, '.gitleaks.toml'));

  const hookDest = path.join(REPO, '.git/hooks/pre-push');
  fs.copyFileSync(HOOK_SRC, hookDest);
  fs.chmodSync(hookDest, 0o755);

  git(['init', '-q', '-b', 'main'], REPO);
  git(['config', 'user.email', 'test@example.invalid'], REPO);
  git(['config', 'user.name', 'Filter Test'], REPO);

  git(['init', '-q', '--bare', ORIGIN], TMP);
  git(['remote', 'add', 'origin', ORIGIN], REPO);
});

after(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

/** Does HEAD exist yet? (git rev-parse exits non-zero when it does not.) */
function hasHead() {
  try {
    git(['rev-parse', '--verify', 'HEAD'], REPO);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset the repo to a known state: origin/main == a single clean commit.
 *
 * `git reset --hard HEAD` only works once a commit exists. On the FIRST call
 * the repo has no HEAD yet, so a bare reset fails with
 *   "fatal: ambiguous argument 'HEAD': unknown revision"
 * and every test errors before reaching the hook. Seed the baseline commit
 * first, then reset.
 */
function seedCleanBaseline() {
  // Ensure HEAD exists before we can reset against it.
  if (!hasHead()) {
    fs.writeFileSync(path.join(REPO, 'src_ok.js'), CLEAN);
    git(['add', '-A'], REPO);
    git(['commit', '-qm', 'initial'], REPO);
  }
  git(['reset', '--hard', 'HEAD'], REPO);
  fs.writeFileSync(path.join(REPO, 'src_ok.js'), CLEAN);
  git(['add', '-A'], REPO);
  // --allow-empty: on a re-seed the content may be byte-identical to HEAD,
  // so there is nothing to commit. The baseline commit is a MARKER (the
  // remote SHA the hook diffs against), not a content change, so an empty
  // commit is exactly right here.
  git(['commit', '--allow-empty', '-qm', 'baseline'], REPO);
  git(['push', '-q', '-f', 'origin', 'main'], REPO);
  return git(['rev-parse', 'origin/main'], REPO);
}

test('hook file exists and is executable-as-bash', () => {
  assert.ok(fs.existsSync(HOOK_SRC), 'scripts/hooks/pre-push must exist');
  const src = fs.readFileSync(HOOK_SRC, 'utf8');
  assert.match(src, /git show "\$LOCAL_SHA:\$f"/,
    'hook must read file content from the pushed tree, not from disk');
});

test('hook has no references to variables it never declares (silent-pass class)', () => {
  // A shell hook that reads an UNSET variable under `set -u` aborts with a
  // non-zero status — but `set -e` then swallows it and the hook can exit 0
  // having scanned NOTHING. That is a false pass: the filter reports success
  // without having looked. This exact shape was hit while building v4 (a
  // leftover accumulator assignment), so it is pinned here.
  const src = fs.readFileSync(HOOK_SRC, 'utf8');
  // Strip comments so prose mentioning a variable name is not a false hit.
  const code = src.split('\n')
    .filter(l => !/^\s*#/.test(l))
    .join('\n');

  // Collect assigned names (VAR=..., VAR+=..., declare, for-loops) and names
  // read (${VAR}, $VAR). Keep it deliberately conservative: any name that is
  // read but never assigned anywhere in the file is suspect.
  const assigned = new Set();
  for (const m of code.matchAll(/^\s*(?:local\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)) {
    assigned.add(m[1]);
  }
  for (const m of code.matchAll(/^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\+=/gm)) {
    assigned.add(m[1]);
  }
  for (const m of code.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) {
    assigned.add(m[1]);
  }
  for (const m of code.matchAll(/\bwhile\s+read\s+(?:-\w+\s+)*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    assigned.add(m[1]);
  }
  // `read -r A B C D` assigns several names at once.
  for (const m of code.matchAll(/\bread\s+(?:-\w+\s+)+((?:[A-Za-z_][A-Za-z0-9_]*\s+)*[A-Za-z_][A-Za-z0-9_]*)/g)) {
    for (const n of m[1].trim().split(/\s+/)) if (n) assigned.add(n);
  }
  for (const m of code.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+"?\$\{/g)) {
    assigned.add(m[1]);
  }

  // Names that are read.
  const read = new Set();
  for (const m of code.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) read.add(m[1]);
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\b/g)) read.add(m[1]);

  // A variable that is assigned FROM ITSELF is not "assigned" in any useful
  // sense: `X="$X\n$FOO"` reads X before it has ever been set. Under
  // `set -u` that aborts the hook, and `set -e` turns the abort into a
  // silent pass. So an assignment whose right-hand side references the same
  // name does NOT count as a declaration.
  const selfReferential = new Set();
  for (const m of code.matchAll(/^\s*(?:local\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^\n]*)$/gm)) {
    const name = m[1];
    const rhs = m[2];
    if (new RegExp(`\\$\\{?${name}\\b`).test(rhs)) selfReferential.add(name);
  }
  for (const n of selfReferential) assigned.delete(n);

  // Shell builtins and loop vars we don't track.
  const IGNORED = new Set(['BASH_SOURCE', 'PATH', 'HOME', 'PWD', 'IFS', 'REMOTE', 'URL',
    'RANGE_OR_TREE', 'RANGE_LABEL', 'DIFF_BASE', 'FILE_COUNT', 'PER_FILE_FAILED',
    'REF_INDEX', 'TMP_ROOT', 'TMP_DIR', 'TMP_F', 'f', 'code', 'out', 'e', 'm',
    'REPO_ROOT', 'TMP', 'REPO', 'ORIGIN', 'remote', 'local']);

  const suspects = [...read].filter(v => !assigned.has(v) && !IGNORED.has(v) &&
    // Exclude command-substitution / positional / special vars.
    !/^(BASH|LOCAL|SHELL|PWD|OLDPWD|RANDOM|LINENO|SECONDS|EUID|UID|GROUPS|FUNCNAME)/.test(v));
  assert.deepStrictEqual(suspects, [],
    `hook reads variables it never assigns: ${suspects.join(', ')} — under 'set -u' these abort the scan and can yield a silent pass`);
});

test('hook fails closed if any internal step errors, rather than exiting 0', () => {
  // `set -e` inside a function/pipe can be defeated. The hook's contract is
  // that it either PASSES (everything scanned) or FAILS (something to report).
  // A crash mid-scan must not be reported as a pass.
  const src = fs.readFileSync(HOOK_SRC, 'utf8');
  assert.match(src, /set -euo pipefail/,
    'hook must enable errexit, nounset and pipefail');
  assert.match(src, /exit 1/,
    'hook must have an explicit failure exit path');
});

test('FALSE PASS is fixed: a leak in the committed blob is blocked even when the working tree is clean', { skip: !hasGitleaks() && 'gitleaks not installed' }, () => {
  const remote = seedCleanBaseline();

  // Commit the leak, THEN clean the working tree. This is the exact shape
  // of the original false pass: what git pushes differs from what is on disk.
  fs.writeFileSync(path.join(REPO, 'src_ok.js'), LEAK);
  git(['add', '-A'], REPO);
  git(['commit', '-qm', 'leak'], REPO);
  fs.writeFileSync(path.join(REPO, 'src_ok.js'), CLEAN);

  const local = git(['rev-parse', 'HEAD'], REPO);
  const { code, out } = runHookExpectingFailure(local, remote);

  assert.notStrictEqual(code, 0,
    `pre-push must block a leak present in the committed blob (got exit ${code})\n${out}`);
  assert.match(out, /pre-push blocked/, 'output must explain the block');
});

test('FALSE BLOCK is fixed: a leak only in the working tree does not block a clean push', () => {
  const remote = seedCleanBaseline();

  // Commit clean content, then dirty the working tree only.
  // The committed payload must DIFFER from the baseline, otherwise the commit
  // is empty and the diff range under test is empty too.
  fs.writeFileSync(path.join(REPO, 'src_ok.js'), CLEAN2);
  git(['add', '-A'], REPO);
  git(['commit', '-qm', 'clean change'], REPO);
  fs.writeFileSync(path.join(REPO, 'src_ok.js'), LEAK);

  const local = git(['rev-parse', 'HEAD'], REPO);
  const out = runHook(local, remote);

  assert.match(out, /Layer 2 \(pre-push\) passed/,
    `pre-push must not block on working-tree-only content\n${out}`);
});

test('the hook reports the ref it blocked, so an operator knows which push failed', () => {
  const remote = seedCleanBaseline();
  fs.writeFileSync(path.join(REPO, 'src_ok.js'), LEAK);
  git(['add', '-A'], REPO);
  git(['commit', '-qm', 'leak2'], REPO);
  fs.writeFileSync(path.join(REPO, 'src_ok.js'), CLEAN);

  const local = git(['rev-parse', 'HEAD'], REPO);
  const { code, out } = runHookExpectingFailure(local, remote);
  assert.notStrictEqual(code, 0);
  assert.match(out, /refs\/heads\/main/, 'block message must name the offending ref');
});

test('public-boundary checker supports --root so blob paths report repo-relative', () => {
  const { execFileSync: exec } = require('node:child_process');
  const out = exec('node', [path.join(REPO_ROOT, 'scripts/check-public-boundary.mjs'), '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.results), '--json must emit a results array');
  for (const r of parsed.results) {
    assert.ok(!path.isAbsolute(r.file),
      `reported path must be relative, got absolute: ${r.file}`);
  }
});
