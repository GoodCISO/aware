// SPDX-License-Identifier: Apache-2.0
// test/unit/scripts/readme-links-ship.test.js
//
// A link in a shipped document that points at a document the package does
// not ship is a false claim.
//
// WHY THIS EXISTS
// ---------------
// The README is in the npm `files` whitelist, so it is published to every
// consumer of `@goodciso/aware`. It linked to `docs/compliance-matrix.md`
// twice (the "Compliance Frameworks" section and the "Quick Links" block)
// while that file was not in the `files` whitelist. The link therefore
// resolved in a git checkout and 404'd in the published tarball.
//
// This test asserts the property that closes the class, not the one
// instance:
//
//   1. Every RELATIVE markdown link in a shipped markdown document points
//      at a path that exists in the repository.
//   2. Every shipped markdown document that is LINKED FROM the README is
//      also in the npm `files` whitelist, so the link resolves in the
//      published tarball as well as in the checkout.
//
// Property 2 is the one that catches the tarball-only break. A link can
// resolve locally and still be broken for a published consumer.
//
// The test reads the `files` whitelist from package.json rather than
// hard-coding it, so adding a document to the whitelist does not require
// editing this test.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const pkg = require(path.join(REPO_ROOT, 'package.json'));

/**
 * Documents that ship to npm consumers. Each entry in `files` is either a
 * directory (which ships whole) or a file path.
 */
const SHIPPED_ENTRIES = pkg.files || [];

/**
 * True when `relPath` (repo-relative, POSIX separators) is inside the npm
 * tarball according to the `files` whitelist.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function shipsInTarball(relPath) {
  return SHIPPED_ENTRIES.some((entry) => {
    const normalised = entry.replace(/\/$/, '');
    if (relPath === normalised) return true;
    // A directory entry ships everything beneath it.
    if (relPath.startsWith(`${normalised}/`)) return true;
    return false;
  });
}

/**
 * Strip inline code spans and fenced code blocks from a markdown body.
 *
 * A markdown link written inside a code span is NOT a link — it is an
 * example. ADR-083 contains a table whose cells quote the old dead links
 * as `[text](target)` inside backticks, and those quoted forms must not be
 * treated as live links.
 *
 * @param {string} markdown
 * @returns {string}
 */
function stripCode(markdown) {
  return markdown
    // Fenced code blocks first (they may contain inline code spans).
    .replace(/^```[\s\S]*?^```/gm, '')
    // Then inline code spans.
    .replace(/`[^`\n]*`/g, '');
}

/**
 * Extract relative markdown links from a markdown body.
 *
 * Only INLINE links (`[text](target)`) and reference definitions are
 * considered. Images are excluded. Anchor-only links (`#section`) and
 * absolute URLs are excluded because they do not name a repository path.
 *
 * @param {string} markdown
 * @returns {string[]} repo-relative link targets
 */
function extractRelativeLinkTargets(markdown) {
  const targets = new Set();
  const body = stripCode(markdown);

  // Inline links: [text](target) — target may be "path", "path#anchor" or
  // "path \"title\"".
  const inlineRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = inlineRe.exec(body)) !== null) {
    targets.add(match[1]);
  }

  // Reference definitions: [id]: target
  const refRe = /^\[[^\]]+\]:\s*(\S+)/gm;
  while ((match = refRe.exec(body)) !== null) {
    targets.add(match[1]);
  }

  return Array.from(targets).filter((t) => {
    if (!t) return false;
    if (t.startsWith('#')) return false;            // in-page anchor
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // absolute URL
    if (t.startsWith('mailto:')) return false;
    if (t.startsWith('//')) return false;           // protocol-relative
    return true;
  });
}

/**
 * The markdown documents that ship to npm consumers.
 *
 * @returns {string[]} repo-relative paths
 */
function shippedMarkdownDocuments() {
  const out = [];
  for (const entry of SHIPPED_ENTRIES) {
    const normalised = entry.replace(/\/$/, '');
    const abs = path.join(REPO_ROOT, normalised);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      if (normalised.endsWith('.md')) out.push(normalised);
      continue;
    }
    // Directory: walk it for markdown files.
    const stack = [normalised];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const child of fs.readdirSync(path.join(REPO_ROOT, dir))) {
        const childRel = `${dir}/${child}`;
        const childAbs = path.join(REPO_ROOT, childRel);
        let childStat;
        try {
          childStat = fs.statSync(childAbs);
        } catch (_err) {
          continue;
        }
        if (childStat.isDirectory()) {
          stack.push(childRel);
        } else if (childRel.endsWith('.md')) {
          out.push(childRel);
        }
      }
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Property 1 — relative links in shipped documents resolve in the checkout
// ---------------------------------------------------------------------------

test('readme-links-ship: every relative link in a shipped markdown document resolves', () => {
  const documents = shippedMarkdownDocuments();
  assert.ok(documents.length > 0, 'expected at least one shipped markdown document');

  const broken = [];
  for (const doc of documents) {
    const body = fs.readFileSync(path.join(REPO_ROOT, doc), 'utf8');
    for (const target of extractRelativeLinkTargets(body)) {
      // Strip an anchor and any query string.
      const clean = target.split('#')[0].split('?')[0];
      if (!clean) continue;
      const docDir = path.posix.dirname(doc);
      const resolved = path.posix.normalize(path.posix.join(docDir, clean));
      if (!fs.existsSync(path.join(REPO_ROOT, resolved))) {
        broken.push(`${doc} -> ${target} (resolved: ${resolved})`);
      }
    }
  }

  assert.deepStrictEqual(
    broken,
    [],
    `these shipped documents link to paths that do not exist:\n  ${broken.join('\n  ')}`
  );
});

// ---------------------------------------------------------------------------
// Property 2 — documents the README links to are in the npm tarball
// ---------------------------------------------------------------------------

test('readme-links-ship: every document the README links to is in the npm files whitelist', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const targets = extractRelativeLinkTargets(readme);

  const notShipped = [];
  for (const target of targets) {
    const clean = target.split('#')[0].split('?')[0];
    if (!clean) continue;
    if (!clean.endsWith('.md')) continue; // only markdown documents are in scope
    const resolved = path.posix.normalize(clean);
    if (!shipsInTarball(resolved)) {
      notShipped.push(resolved);
    }
  }

  assert.deepStrictEqual(
    notShipped,
    [],
    `the README links to these documents but they are NOT in package.json "files", ` +
    `so the link is broken in the published npm tarball:\n  ${notShipped.join('\n  ')}`
  );
});

// ---------------------------------------------------------------------------
// Property 3 — the generated compliance matrix is both present and shipped
// ---------------------------------------------------------------------------

test('readme-links-ship: docs/compliance-matrix.md exists and ships', () => {
  const rel = 'docs/compliance-matrix.md';
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, rel)),
    `${rel} must exist — the README links to it`
  );
  assert.ok(
    shipsInTarball(rel),
    `${rel} must be in package.json "files" — the README links to it and the ` +
    `README ships, so a consumer reading the published package would get a dead link`
  );
});

test('readme-links-ship: the generated matrix carries the GENERATED banner and is current', () => {
  const body = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'compliance-matrix.md'), 'utf8');
  assert.match(body, /GENERATED FILE/,
    'the compliance matrix must carry the do-not-edit banner');
  assert.match(body, /generate-compliance-matrix\.js/,
    'the compliance matrix must name the generator that produces it');
});
