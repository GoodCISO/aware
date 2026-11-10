#!/usr/bin/env node
// scripts/publish-guard.mjs
// AWARE npm publish guard — prevents shipping files that are not in the
// release tag.
//
// WHY THIS EXISTS
// ---------------
// On 2026-11-10, `npm publish` was run from the repository working tree
// rather than from a clean checkout of the release tag. npm packs the
// working tree, so 27 files that were NOT committed and NOT in the
// v2.12.0 tag were published to the public npm registry. They included:
//
//   docs/investor/AI-SEED-FUND-PITCH.md
//   docs/investor/AWARE-Pitch-Deck.pptx
//   docs/investor/aware-pitch-deck.pdf
//   docs/investor/aware-pitch-deck.html
//   docs/investor/CSA-AGM-2026-SPEAKER-SUBMISSION.md
//   src/coordinator/http-server.js.bak
//   src/compliance/mcp-governance-catalog.js
//   src/trainer/security-sensitive-diff.js
//   ... and 19 more
//
// The GitHub release tarball for the same tag was CLEAN (425 files, tag
// based). Only the npm channel leaked, because only npm packed a working
// tree.
//
// The defect is not that the files are secret — the secret scan found
// none. The defect is that npm published a tree that no release had ever
// reviewed, which breaks the tag-as-source-of-truth guarantee.
//
// WHAT THIS DOES
// --------------
// 1. Resolves the release tag (or takes --tag).
// 2. Builds a clean detached worktree at that tag.
// 3. Runs `npm pack --dry-run --json` inside the clean worktree.
// 4. Compares the packed file list against the tag's tracked file list.
// 5. Fails (exit 1) if any packed file is absent from the tag — that is
//    the exact failure mode above.
// 6. Optionally re-checks that every packed file exists in the tag with
//    identical content (byte-for-byte), so a locally-modified tracked
//    file cannot sneak into a release either.
//
// Usage:
//   node scripts/publish-guard.mjs --tag v2.12.1
//   node scripts/publish-guard.mjs --tag v2.12.1 --json
//   node scripts/publish-guard.mjs --tag v2.12.1 --publish   # pack+publish from clean worktree
//   node scripts/publish-guard.mjs --tag v2.12.1 --audit-worktree
//        # DO NOT publish. Instead, report what the CURRENT working tree
//        # would pack, and whether every file in it is in the tag. This is
//        # the mode that would have caught the 2026-11-10 incident: it
//        # reproduces the exact mistake (npm publish run from the working
//        # tree) as a dry run.
//
// Exit codes:
//   0  guard passed
//   1  guard FAILED (a packed file is not in the tag, or content differs)
//   2  usage / environment error

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);

function fail(msg, code = 1) {
  console.error(`✗ publish-guard: ${msg}`);
  process.exit(code);
}

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function parseArgs(argv) {
  const opts = { tag: null, json: false, publish: false, auditWorktree: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tag') {
      opts.tag = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--tag=')) {
      opts.tag = a.slice('--tag='.length);
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--publish') {
      opts.publish = true;
    } else if (a === '--audit-worktree') {
      opts.auditWorktree = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/publish-guard.mjs --tag <vX.Y.Z> [--json] [--publish] [--audit-worktree]'
      );
      process.exit(0);
    }
  }
  return opts;
}

/**
 * The list of files npm would publish, from a clean checkout of the tag.
 * @returns {string[]} repo-relative paths
 */
function packedFilesFromCleanTag(tag) {
  const worktree = mkdtempSync(join(tmpdir(), 'aware-publish-guard-'));
  try {
    git(['worktree', 'add', '--detach', worktree, tag]);
    const raw = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json'],
      { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const parsed = JSON.parse(raw);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    return {
      worktree,
      files: (entry.files || []).map((f) => f.path).sort(),
      entry,
    };
  } catch (err) {
    rmSync(worktree, { recursive: true, force: true });
    try {
      git(['worktree', 'prune']);
    } catch {
      /* best effort */
    }
    fail(`could not pack from a clean worktree at ${tag}: ${err.message}`, 2);
    return null;
  }
}

/**
 * Every file tracked in the tag, repo-relative.
 */
function trackedFilesInTag(tag) {
  return git(['ls-tree', '-r', '--name-only', tag])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.tag) {
    fail('--tag <vX.Y.Z> is required', 2);
  }

  // The tag must exist locally and resolve to a commit.
  let tagCommit;
  try {
    tagCommit = git(['rev-parse', `${opts.tag}^{commit}`]).trim();
  } catch {
    fail(`tag ${opts.tag} does not resolve to a commit`, 2);
  }

  const tracked = new Set(trackedFilesInTag(opts.tag));

  // ── AUDIT MODE ────────────────────────────────────────────────────────
  // Reproduce the 2026-11-10 mistake as a dry run: what would the CURRENT
  // working tree pack, and is every one of those files in the tag?
  if (opts.auditWorktree) {
    let worktreeFiles = [];
    try {
      const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const parsed = JSON.parse(raw);
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      worktreeFiles = (entry.files || []).map((f) => f.path).sort();
    } catch (err) {
      fail(`could not pack the working tree: ${err.message}`, 2);
    }

    const notInTag = worktreeFiles.filter((f) => !tracked.has(f));
    const report = {
      mode: 'audit-worktree',
      tag: opts.tag,
      tagCommit,
      worktreePackedFileCount: worktreeFiles.length,
      cleanTagPackedFileCount: null,
      notInTag,
      ok: notInTag.length === 0,
    };
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`publish-guard (audit-worktree): ${opts.tag} → ${tagCommit.slice(0, 12)}`);
      console.log(`  working tree would pack: ${worktreeFiles.length} files`);
      if (notInTag.length) {
        console.log(`  ✗ ${notInTag.length} file(s) would ship that are NOT in the tag:`);
        for (const f of notInTag) console.log(`      ${f}`);
        console.log(
          '\n  These would be published to npm but were never committed or\n' +
            '  tagged. Publishing from the working tree is what caused the\n' +
            '  2026-11-10 public-boundary leak. Publish from a clean\n' +
            '  worktree instead (--publish does this automatically).'
        );
      } else {
        console.log('  ✓ every file the working tree would pack is in the tag');
      }
    }
    if (!report.ok) process.exit(1);
    return;
  }

  const { worktree, files, entry } = packedFilesFromCleanTag(opts.tag);

  try {
    // FAILURE MODE 1 — a packed file that is not in the tag.
    const untrackedInTag = files.filter((f) => !tracked.has(f));

    // FAILURE MODE 2 — a packed file whose content differs from the tag.
    // (npm pack can pick up a locally-modified tracked file if the pack
    //  is run in the working tree; from a clean worktree this should be
    //  empty, but the check costs nothing and documents the intent.)
    const contentDrift = [];
    for (const f of files) {
      if (!tracked.has(f)) continue;
      const packed = join(worktree, f);
      if (!existsSync(packed)) continue;
      const blob = git(['hash-object', packed]).trim();
      const tagged = git(['rev-parse', `${opts.tag}:${f}`]).trim();
      if (blob !== tagged) contentDrift.push(f);
    }

    const report = {
      tag: opts.tag,
      tagCommit,
      packedFileCount: files.length,
      trackedFileCount: tracked.size,
      untrackedInTag,
      contentDrift,
      ok: untrackedInTag.length === 0 && contentDrift.length === 0,
    };

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`publish-guard: ${opts.tag} → ${tagCommit.slice(0, 12)}`);
      console.log(`  packed files: ${files.length}`);
      console.log(`  tracked in tag: ${tracked.size}`);
      if (untrackedInTag.length) {
        console.log(`  ✗ ${untrackedInTag.length} packed file(s) NOT in the tag:`);
        for (const f of untrackedInTag) console.log(`      ${f}`);
      }
      if (contentDrift.length) {
        console.log(`  ✗ ${contentDrift.length} packed file(s) differ from the tag:`);
        for (const f of contentDrift) console.log(`      ${f}`);
      }
      if (report.ok) {
        console.log('  ✓ every packed file is in the tag, byte-identical');
      }
    }

    if (!report.ok) {
      // Do NOT publish. Exit 1.
      console.error(
        '\n✗ REFUSING TO PUBLISH: the tarball does not match the tag.\n' +
          '  Publish from a clean worktree, or commit the missing files and\n' +
          '  re-tag. Do not publish a tarball that no release reviewed.'
      );
      process.exit(1);
    }

    if (opts.publish) {
      console.log('\npublish-guard: packing from the clean worktree for publish...');
      execFileSync('npm', ['publish'], { cwd: worktree, stdio: 'inherit' });
      console.log('publish-guard: publish complete.');
    } else {
      console.log(
        '\npublish-guard: PASS. Re-run with --publish to publish from this clean worktree.'
      );
    }
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    try {
      git(['worktree', 'prune']);
    } catch {
      /* best effort */
    }
  }
}

main();
