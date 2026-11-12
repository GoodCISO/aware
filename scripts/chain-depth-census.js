#!/usr/bin/env node
// scripts/chain-depth-census.js
//
// ADR-080 — read-only population census for the `decisionChainDepth` metric.
//
// Design source: docs/adr/ADR-080-aware-decision-chain-depth-metric.md
// (the architect's record for this decision; sections D2, D3, D4 and §6).
//
// WHAT THIS IS
// ------------
// A read-time derived metric over the audit chain (ADR-080 §D1). This script
// is the ONLY consumer: it opens the chain file read-only, walks it once, and
// prints a JSON population report to stdout. It emits nothing, writes nothing,
// and starts nothing.
//
// ADR-080 §D4 makes this a script and not a service on purpose: no new
// endpoint, no new service, no new volume, no schema change, no baseline.
// ADR-080 §D1 forbids adding `decisionChainDepth` to `MetricType` — this
// script does not touch `src/monitoring/metrics-collector.js`.
//
// WHAT IT MEASURES
// ----------------
// For a decision record `d` in the chain (ADR-080 §D2):
//
//   depth(d) = 0        when parentDecisionId is null  (a root)
//   depth(d) = p.depth + 1  when the parent id is present in the map
//   depth(d) = undefined    when the parent id is NOT in the map  ("dangling")
//
// A dangling record is NOT counted as a root. Doing so would understate the
// chained share and hide a chain gap — the exact defect ADR-080 §6.3 calls out.
//
// Parents precede children in append order (an annotation's parent is the
// source event, logged earlier), so ONE forward pass with an `id -> depth`
// map suffices; there is no recursion and no second pass.
//
// REPORTED NUMBERS (ADR-080 §D3)
// -------------------------------
//   chainedShare — share of records with depth > 0
//   depthP95     — 95th percentile over the RESOLVED (depth !== undefined) set
//   depthMax     — max over the RESOLVED set
//   danglingCount— records whose own parent id is absent from the chain
//
// A bare mean is deliberately NOT reported. With today's population the mean
// is 0.0 — a number that reads like a measurement and is really an artefact of
// an empty arm. The share, the tail, and the dangling count each stay
// interpretable when the arm is empty.
//
// FAILURE MODES (ADR-080 §6)
// ---------------------------
//   §6.1 chain growth   — the `id -> depth` map is O(n) in the record count.
//                          That is the cost ADR-080 §6.1 accepts for v1; the
//                          file is streamed line-by-line so the SCRIPT's own
//                          footprint stays flat, but the map does grow. A
//                          184 MB / 321k-record chain today, retained for
//                          AWARE_AUDIT_RETENTION_DAYS=2555 (~7 years), means
//                          this map is the dominant memory consumer at
//                          retention scale. `durationMs` and `recordsRead` are
//                          reported so growth is visible.
//   §6.2 torn writes    — `malformedLines` is ALWAYS reported. Unparseable
//                          lines are never silently skipped: skipping them
//                          under-reports the population and therefore
//                          under-reports the chained share. The counting rule
//                          matches the decision-logger's cold-index rebuild
//                          (`src/audit/decision-logger.js`): a blank line is
//                          skipped, a JSON parse failure is counted.
//   §6.3 dangling parents — reported separately from the depth statistics. A
//                          non-zero `danglingCount` is a chain-health signal
//                          in its own right.
//   §6.4 self-mutation  — this file never opens the chain file, the audit
//                          volume, or the metrics store for writing. The
//                          report goes to stdout and nowhere else.
//
// USAGE
// -----
//   node scripts/chain-depth-census.js [chainPath]
//
//   chainPath  optional positional argument. Defaults to
//              `$AUDIT_DIR/decision-chain.jsonl`, falling back to
//              `/data/audit/decision-chain.jsonl`.
//
//   The default chain works both on the host and inside the
//   `aware-2-coordinator` container (which sets AUDIT_DIR=/data/audit).
//
// EXIT CODES
// ----------
//   0 — census completed; the report is on stdout
//   1 — unexpected internal error (message on stderr)
//   2 — the chain file could not be opened (message on stderr)
//
// MODULE FORMAT — why the dynamic imports
// ----------------------------------------
// This one file has to run in TWO module systems:
//
//   * at the repo root, `package.json` has no "type" field, so a `.js` file
//     is CommonJS (like every other script in `scripts/`);
//   * inside the coordinator image, `Dockerfile.coordinator` writes
//     `/app/package.json` as `{"type":"module",...}`, so a `.js` file under
//     `/app` is an ES module.
//
// `import`/`require` are therefore both unavailable in the same file.
// `await import()` works in BOTH (it is a dynamic import, valid in CJS and
// ESM alike), so this file is a single artifact that runs unchanged on the
// host and in the container. Top-level `await` is not available in CJS, hence
// the async IIFE.
//
// READ-ONLY PROOF
// ---------------
// The only file-system calls in this file are `createReadStream` (read mode)
// and `statSync` (metadata). There is no `open(..., 'w'|'a'|'r+')`, no
// `writeFile`, no `appendFile`, no `createWriteStream`, and no `unlink`.
// The report is emitted with `process.stdout.write` only.

(async () => {
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');

  const DEFAULT_CHAIN_PATH = '/data/audit/decision-chain.jsonl';

  /**
   * Resolve the chain path: CLI argument > $AUDIT_DIR > container default.
   *
   * @param {string[]} argv
   * @param {NodeJS.ProcessEnv} env
   * @returns {string}
   */
  function resolveChainPath(argv, env) {
    const fromArgv = argv.slice(2).find((a) => !a.startsWith('-'));
    if (fromArgv) return fromArgv;

    const auditDir = env.AUDIT_DIR;
    if (auditDir && auditDir.trim() !== '') {
      return `${auditDir.replace(/\/+$/, '')}/decision-chain.jsonl`;
    }

    return DEFAULT_CHAIN_PATH;
  }

  /**
   * Nearest-rank percentile over an already-sorted ascending array.
   *
   * Nearest-rank (not linear interpolation) so the result is always an
   * OBSERVED depth rather than a synthetic value between two depths — a
   * percentile of a depth histogram should be a depth that exists.
   *
   * @param {number[]} sorted ascending
   * @param {number} p percentile in (0, 1]
   * @returns {number} the observed value at rank ceil(p * n); 0 for an empty set
   */
  function nearestRankPercentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const rank = Math.ceil(p * sorted.length);
    const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
    return sorted[index];
  }

  const chainPath = resolveChainPath(process.argv, process.env);
  const startedAt = Date.now();

  // --- census state -------------------------------------------------
  // `depthById` holds depth numbers for resolved records and an explicit
  // `undefined` for records whose chain is broken. `Map.has()` distinguishes
  // "id absent" from "id present but unresolved" — `Map.get()` alone cannot.
  const depthById = new Map();
  const actionTypes = new Map();
  const depthCounts = new Map();

  let records = 0;          // parseable records processed
  let malformedLines = 0;   // lines that did not yield a record
  let danglingCount = 0;    // records whose OWN parent id is absent
  let unresolvedCount = 0;  // records with no defined depth (dangling + broken descendants)

  let stream;
  try {
    stream = createReadStream(chainPath, { encoding: 'utf8' });
  } catch (err) {
    process.stderr.write(`chain-depth-census: cannot open chain file ${chainPath}: ${err.message}\n`);
    process.exit(2);
  }

  // The stream is opened lazily; the 'error' event can still fire async
  // (missing file, permission denied, unreadable volume).
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const failOpen = (err) => {
    process.stderr.write(`chain-depth-census: cannot open chain file ${chainPath}: ${err.message}\n`);
    process.exit(2);
  };
  stream.on('error', failOpen);

  try {
    for await (const line of rl) {
      // A blank line is skipped, not counted as malformed — same rule as the
      // decision-logger's cold-index rebuild (src/audit/decision-logger.js).
      if (!line.trim()) continue;

      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        // ADR-080 §6.2: a torn write is counted and reported, never swallowed.
        malformedLines += 1;
        continue;
      }

      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        malformedLines += 1;
        continue;
      }

      // Without a decision id the record cannot participate in the parent map
      // at all — it is a malformed record, not an unchainable one.
      if (typeof rec.decisionId !== 'string' || rec.decisionId === '') {
        malformedLines += 1;
        continue;
      }

      records += 1;

      const parentId = rec.parentDecisionId;
      let depth;

      if (parentId == null) {
        // Root.
        depth = 0;
      } else if (!depthById.has(parentId)) {
        // ADR-080 §D2: the parent id is absent from the chain. The record's
        // depth is undefined — NOT zero. Counting it as a root would
        // understate the chained share and hide the chain gap (§6.3).
        depth = undefined;
        danglingCount += 1;
      } else {
        const parentDepth = depthById.get(parentId);
        // A parent that is present but itself unresolved (its own ancestor is
        // missing) leaves this record unresolved too: ADR-080 §D2 says depth
        // is undefined if ANY ancestor id is absent from the chain.
        depth = parentDepth === undefined ? undefined : parentDepth + 1;
      }

      depthById.set(rec.decisionId, depth);

      if (depth === undefined) {
        unresolvedCount += 1;
      } else {
        depthCounts.set(depth, (depthCounts.get(depth) || 0) + 1);
      }

      const actionType = rec.action && typeof rec.action.type === 'string' ? rec.action.type : null;
      if (actionType !== null) {
        actionTypes.set(actionType, (actionTypes.get(actionType) || 0) + 1);
      }
    }
  } catch (err) {
    process.stderr.write(`chain-depth-census: failed while reading ${chainPath}: ${err.message}\n`);
    process.exit(1);
  }

  // --- report -------------------------------------------------------
  const sortedDepths = [];
  for (const [depth, count] of depthCounts) {
    for (let i = 0; i < count; i += 1) sortedDepths.push(depth);
  }
  sortedDepths.sort((a, b) => a - b);

  const chainedCount = sortedDepths.reduce((sum, d) => (d > 0 ? sum + 1 : sum), 0);

  const depthHistogram = {};
  for (const depth of [...depthCounts.keys()].sort((a, b) => a - b)) {
    depthHistogram[String(depth)] = depthCounts.get(depth);
  }

  const actionTypeCounts = {};
  for (const type of [...actionTypes.keys()].sort()) {
    actionTypeCounts[type] = actionTypes.get(type);
  }

  const report = {
    records,
    malformedLines,
    danglingCount,
    // Share of ALL records with depth > 0. A record with no defined depth is
    // not chained and is not counted in the numerator; `unresolvedCount`
    // reports how many of those there are, so the share is never read as
    // "nothing is chained" when the truth is "part of the chain is broken".
    chainedShare: records > 0 ? chainedCount / records : 0,
    depthP95: nearestRankPercentile(sortedDepths, 0.95),
    depthMax: sortedDepths.length > 0 ? sortedDepths[sortedDepths.length - 1] : 0,
    depthHistogram,
    actionTypes: actionTypeCounts,
    chainFile: chainPath,
    recordsRead: records,
    // Records with NO defined depth: the direct orphans (`danglingCount`)
    // plus every descendant of a broken chain. ADR-080 §D3 names only
    // `danglingCount`; this second class is reported rather than dropped,
    // because silently dropping it is the under-reporting failure mode
    // §6.2 warns about.
    unresolvedCount,
    durationMs: Date.now() - startedAt
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
})().catch((err) => {
  process.stderr.write(`chain-depth-census: internal error: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
