#!/usr/bin/env node
// scripts/check-public-boundary.mjs
// AWARE public-boundary checker — companion to the 4-layer privacy filter
// (see docs/security/filter-architecture.md, scripts/hooks/pre-commit, pre-push).
//
// This checker enforces a per-file "public-boundary" classification so operator-
// internal deploy/recover scripts that bind to your local stack topology,
// secrets paths, or org-name literals are never pushed to the public GitHub
// mirror by accident.
//
// Convention:
//   Add one of these as the FIRST non-shebang, non-blank line in the script:
//
//     # public-boundary: ok                ← file is safe to ship to github
//     # public-boundary: operator-internal  ← file binds to your infra; DO NOT push
//     # public-boundary: test-fixture      ← file is a fixture for the privacy filter itself
//
// If no marker is present AND the file is a deploy/recover script (matches
// heuristics below), the checker refuses with exit 1.
// Pure-analysis scripts (check-*.mjs, bench-*.ts, coverage-*.mjs, audit-*.js,
// eval-*.sh, security-scan.sh, run-eval-*.mjs) are exempt by default —
// they don't bind to operator state.
//
// Pattern categories flagged as operator-internal (see PATTERNS below for exact regexes):
//   - host_path_literal:     /Users/<name>/ or /home/<name>/
//   - host_env_secret_path:  ~/.openclaw, ~/.hermes, ~/.aws, ~/.ssh, ~/.kube, ~/.docker, ~/.gnupg
//   - lan_ip:                RFC1918 ranges
//   - nonlocal_localhost:    non-default localhost ports (operator stack topology)
//   - operator_org_literal:  the operator's org names (Modal workspace, GitHub org)
//   - bearer_token_literal:  Bearer <32+ chars>
//   - common_secret_prefixes: sk-, ghp_, AKIA, xoxb-, xoxp-
//   - connection_string_with_creds: postgres://user:***@, mongodb://user:***@, etc.
//
// Decision logic:
//   - Marker `ok` + hits            → BLOCK (contradiction)
//   - Marker `operator-internal`    → ALLOW (explicit intent)
//   - Marker `test-fixture`         → ALLOW (intentional for filter testing)
//   - No marker + no hits           → ALLOW (no operator binding detected)
//   - No marker + hits              → BLOCK (need explicit classification)
//   - Self-defining files (SELF_DEFINING_FILES) → exempt; their content IS the rule definitions.
//
// Integration with the 4-layer privacy filter:
//   Layer 1 (client): scripts/hooks/pre-commit        — runs pre-commit-check.sh rules
//   Layer 2 (client): scripts/hooks/pre-push           — runs gitleaks + per-file content checks
//                     + THIS checker (on changed scripts/ files)
//   Layer 3 (server): gitea pre-receive                — last client-side line; owner: release agent
//   Layer 4 (CI):     .gitea/workflows/lint-private-data.yml — scans the published tree
//
// Usage:
//   node scripts/check-public-boundary.mjs                  # check all of scripts/
//   node scripts/check-public-boundary.mjs path/to/file     # check one file
//   node scripts/check-public-boundary.mjs --changed        # check files changed in last commit
//   node scripts/check-public-boundary.mjs --json           # machine-readable output
//   node scripts/check-public-boundary.mjs --root <dir> <file>...
//                                                      # scan files that live OUTSIDE the
//                                                      # repo tree (e.g. blobs the
//                                                      # pre-push hook materialised from
//                                                      # the tree being pushed) while
//                                                      # still reporting repo-relative
//                                                      # paths.
//
// Exit codes:
//   0 — all files clean (no marker needed, marker present, or explicit allow)
//   1 — operator-internal pattern(s) found without a marker (block push)
//   2 — marker present says "ok" but pattern(s) also found (block push — likely mistake)
//   3 — invalid invocation (file not found, etc.)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

// ── Patterns that indicate operator-internal binding ────────────────────
// Each pattern returns a tuple: (category, human-readable description).
// Categories are stable; descriptions can change. CIs may want to grep on category.
const PATTERNS = [
  { name: "host_path_literal",     re: /(?:^|[^A-Za-z_])\/(?:Users|home)\/[a-z]+\//,
    desc: "host-specific path under /Users/ or /home/" },
  { name: "host_env_secret_path",  re: /(?:^|[^A-Za-z_])(?:\.openclaw|\.hermes|\.aws|\.ssh|\.kube|\.docker|\.gnupg)\//,
    desc: "operator env dir reference (~/.openclaw/, ~/.hermes/, ~/.aws/, …)" },
  { name: "lan_ip",                re: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3})\b/,
    desc: "private LAN IP (RFC1918)" },
  { name: "nonlocal_localhost",    re: /localhost:(?:18080|38181|11434|18432|18379|18789|8948|7878|8080|27017|6379|5432|3306|9200|5601)\b/,
    desc: "non-default localhost port (operator stack topology)" },
  { name: "operator_org_literal",  re: /\b(?:goodciso|changtech|alvin-chang)\b/,
    desc: "operator org-name literal (Modal workspace / GitHub org)" },
  { name: "bearer_token_literal",  re: /Bearer\s+[A-Za-z0-9_\-]{32,}/,
    desc: "literal bearer token" },
  { name: "common_secret_prefixes", re: /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bp]-[A-Za-z0-9-]{10,})\b/,
    desc: "common API-token prefix (OpenAI sk-, GitHub ghp_, AWS AKIA, Slack xoxb-/xoxp-)" },
  { name: "connection_string_with_creds", re: /(?:postgres|mysql|mongodb|redis|amqp):\/\/[^\/\s]+:[^@\/\s]+@/,
    desc: "DB/queue connection string with inline credentials" },
];

// ── Marker grammar ──────────────────────────────────────────────────────
// First non-shebang, non-blank line that matches ALLOW_MARKER wins.
const ALLOW_MARKER = /^\s*#\s*public-boundary:\s*(ok|operator-internal|test-fixture)\s*$/;

// ── Self-defining files (their own content IS the rule definitions) ─────
// Mirrors the allowlist pattern in .gitleaks.toml. These are scripts whose
// content legitimately contains the regex literals they (or sibling tools)
// scan for. .md files are NOT included — the script-type filter in
// isScriptFile() already excludes them, so docs never reach the scanner.
//
// Add a file here ONLY if:
//   (a) it ends in .sh/.js/.mjs/.ts/.py/.cjs OR has a #! shebang, AND
//   (b) it legitimately contains the operator-internal pattern regexes
//       as literals (rule definitions, not bound values).
const SELF_DEFINING_FILES = new Set([
  "pre-commit-check.sh",
  "install-hooks.sh",
  "check-public-boundary.mjs",   // this file
  "pre-commit",                   // in scripts/hooks/
  "pre-push",
  "pre-receive",
]);

// ── Pure-analysis scripts (exempt: no operator binding by construction) ──
const PURE_ANALYSIS_HEURISTIC = /^(?:check-|bench-|audit-|coverage-|eval-|security-scan|run-eval-|collect-runtime|seed-dev-)/;

// ── Deploy/recover heuristic (require marker) ───────────────────────────
const DEPLOY_RECOVER_HEURISTIC = /(?:^|\b)(?:up|bring-up|deploy|recover|setup|install|run-phase|seed-smoke)\b/i;

// ── File inclusion rules ────────────────────────────────────────────────
function isScriptFile(path) {
  const name = basename(path);
  if (name.endsWith(".bak") || name.endsWith(".bak2") || name.endsWith(".bak3")) return false;
  if (name.endsWith(".sh") || name.endsWith(".js") || name.endsWith(".mjs") ||
      name.endsWith(".ts") || name.endsWith(".py") || name.endsWith(".cjs")) return true;
  try {
    const fd = readFileSync(path, { encoding: null, flag: "r" });
    return fd.length >= 2 && fd[0] === 0x23 && fd[1] === 0x21; // "#!"
  } catch {
    return false;
  }
}

function discoverScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (!isScriptFile(full)) continue;
    out.push(full);
  }
  return out;
}

function changedFiles() {
  try {
    // --diff-filter=ACMRT: only Added, Copied, Modified, Renamed, Type-changed.
    // Skip Deleted (D) — those files no longer exist on disk and the scanner
    // would ENOENT on them. (See the 8b85bee→a2ff4b4 case where
    // sanitize-vendor-for-gh.sh was added then removed in successive commits.)
    const out = execSync("git diff --name-only --diff-filter=ACMRT HEAD~1 HEAD", { cwd: REPO_ROOT, encoding: "utf8" });
    return out.split("\n").filter(l => l.trim()).map(l => join(REPO_ROOT, l));
  } catch (e) {
    return [];
  }
}

function detectMarker(lines) {
  for (const ln of lines.slice(0, 10)) {
    const s = ln.trim();
    if (!s || s.startsWith("#!")) continue;
    const m = ln.match(ALLOW_MARKER);
    if (m) return m[1];
    if (!s.startsWith("#")) break;
  }
  return null;
}

function scanFile(path) {
  const name = basename(path);
  if (SELF_DEFINING_FILES.has(name)) {
    return { exempt: "self-defining", marker: null, hits: [] };
  }
  let lines;
  try {
    lines = readFileSync(path, { encoding: "utf8" }).split("\n");
  } catch (e) {
    return { error: `read failed: ${e.message}`, marker: null, hits: [] };
  }
  const marker = detectMarker(lines);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const p of PATTERNS) {
      // Reset regex state by creating a fresh RegExp each call (re used .lastIndex semantics in v flag)
      const r = new RegExp(p.re.source, p.re.flags);
      const m = r.exec(ln);
      if (m) {
        hits.push({ line: i + 1, category: p.name, desc: p.desc, snippet: ln.trim().slice(0, 120) });
      }
    }
  }
  return { exempt: null, marker, hits };
}

function verdict(scan, name) {
  if (scan.exempt) return { ok: true, reason: scan.exempt };
  if (scan.error)  return { ok: false, reason: scan.error, code: 3 };
  const isDeployish = DEPLOY_RECOVER_HEURISTIC.test(name);
  const isPureAnalysis = PURE_ANALYSIS_HEURISTIC.test(name);
  // Pure-analysis scripts: hits are bugs (they shouldn't bind to anything).
  if (isPureAnalysis && scan.hits.length > 0 && scan.marker !== "operator-internal") {
    return { ok: false, reason: `pure-analysis script contains operator-internal pattern (${scan.hits.length})`, code: 1, hits: scan.hits };
  }
  // Operator-internal marker + hits: fine.
  if (scan.marker === "operator-internal") return { ok: true, reason: "explicit operator-internal marker" };
  // Test fixture marker: assume hits are intentional.
  if (scan.marker === "test-fixture")      return { ok: true, reason: "explicit test-fixture marker" };
  // "ok" marker but hits: contradiction → block.
  if (scan.marker === "ok" && scan.hits.length > 0) {
    return { ok: false, reason: `'# public-boundary: ok' but ${scan.hits.length} pattern(s) found`, code: 2, hits: scan.hits };
  }
  // No marker + no hits: always allow. Hits are the signal; deploy-recovery is
  // context. A legitimate bring-up-coordinator.sh that doesn't bind to operator
  // state doesn't need a marker.
  if (!scan.marker && scan.hits.length === 0) {
    return { ok: true, reason: isDeployish ? "deploy/recover with no operator-binding (no marker needed)" : "no hits, no marker needed" };
  }
  // No marker + hits + not deploy-ish: allow if pure-analysis (handled above), otherwise block.
  if (!scan.marker && scan.hits.length > 0) {
    return { ok: false, reason: `${scan.hits.length} operator-internal pattern(s) without marker`, code: 1, hits: scan.hits };
  }
  return { ok: true, reason: "ok" };
}

// ── CLI ─────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const changed = args.includes("--changed");
  // --root <dir>: the repo root that paths should be reported relative to.
  // The pre-push hook uses this to scan blobs it materialised OUTSIDE the
  // repo tree (in a temp dir) while still printing repo-relative paths.
  let root = REPO_ROOT;
  const rootIdx = args.indexOf("--root");
  if (rootIdx !== -1) {
    const r = args[rootIdx + 1];
    if (!r) {
      console.error("✗ --root requires a directory argument");
      process.exit(3);
    }
    root = r;
    args.splice(rootIdx, 2);
  }
  const positional = args.filter(a => !a.startsWith("--"));
  let targets;
  if (positional.length > 0) {
    // Explicit file arguments: only scan files that look like scripts.
    // This protects against accidental invocation with .md / .txt / etc.
    // (e.g. if the pre-push hook pipes git diff output unfiltered).
    targets = positional
      .map(p => p.startsWith("/") ? p : join(REPO_ROOT, p))
      .filter(p => isScriptFile(p) || SELF_DEFINING_FILES.has(basename(p)));
    if (targets.length === 0) {
      console.log("✓ no script files in the provided list (filtered out non-script args)");
      process.exit(0);
    }
  } else if (changed) {
    targets = changedFiles().filter(f => f.startsWith(SCRIPTS_DIR + "/") && isScriptFile(f));
    if (targets.length === 0) {
      console.log("✓ no changed files in scripts/");
      process.exit(0);
    }
  } else {
    targets = discoverScripts(SCRIPTS_DIR);
  }
  if (targets.length === 0) {
    console.error("✗ no script files to check");
    process.exit(3);
  }
  const results = [];
  let worstCode = 0;
  for (const t of targets) {
    const scan = scanFile(t);
    const v = verdict(scan, basename(t));
    if (v.code && v.code > worstCode) worstCode = v.code;
    results.push({ file: relative(root, t), ...v, hits: v.hits || scan.hits });
  }
  if (json) {
    process.stdout.write(JSON.stringify({ results, worstCode }, null, 2) + "\n");
    process.exit(worstCode);
  }
  // Human-readable
  let blocked = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${r.file.padEnd(40)} ${r.reason}`);
    } else {
      blocked++;
      console.log(`✗ ${r.file.padEnd(40)} ${r.reason}`);
      for (const h of (r.hits || []).slice(0, 10)) {
        console.log(`    L${String(h.line).padStart(4)} ${h.category.padEnd(28)} ${h.desc}`);
        console.log(`         ${h.snippet}`);
      }
    }
  }
  console.log("");
  if (blocked === 0) {
    console.log(`✓ all ${results.length} script(s) clean`);
    process.exit(0);
  } else {
    console.log(`✗ ${blocked} of ${results.length} script(s) need attention`);
    console.log("");
    console.log("Fix options:");
    console.log("  1. Add marker to script header (preferred for legitimate deploy/recover scripts):");
    console.log("       # public-boundary: operator-internal");
    console.log("  2. Move script to a gitignored location (operator-internal tooling)");
    console.log("  3. Add marker if safe to ship:");
    console.log("       # public-boundary: ok");
    process.exit(worstCode || 1);
  }
}

main();