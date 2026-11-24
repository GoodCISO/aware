// src/rlm.js — Public entry: rlm() recursive language model primitive
//
// Sibling to heavy_think(). Decomposes a problem into sub-problems,
// dispatches each (recursively or to heavy_think() at leaves), and
// aggregates the results.
//
// Per SPEC.md §3.1 / §3.6:
//   - exports: rlm, RlmError, RlmBudgetExceededError, RlmTimeoutError,
//              RlmSecurityError, RlmEnvironmentError, RlmConfigError
//   - default client = built-in minimax (lazy import)
//   - tests inject a { generate } client
//   - cost tracked per-node and rolled up to root
//   - errors carry partial_tree for caller inspection
//
// Architecture refs:
//   - SPEC.md §3 (Public API), §4 (Recursion), §5 (Leaf), §6 (Aggregation),
//     §7 (Failure modes), §8 (Audit trail), §11 (Sandbox contract).
//   - ARCHITECTURE.md §3-9 (system design, failure modes, audit).

import { randomUUID } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import { loadContext } from './rlm/environment.js';
import { runNode, traceAnswers, rollupCost, maxDepth as maxDepthInTree, countCalls } from './rlm/tree.js';
import {
  RlmError,
  RlmBudgetExceededError,
  RlmTimeoutError,
  RlmSecurityError,
  RlmEnvironmentError,
  RlmConfigError,
} from './rlm/errors.js';

// ─── Defaults (SPEC §4.1) ──────────────────────────────────────────────────
//
// Note: SPEC §4.1 says budget_usd=0.50; ARCHITECTURE §6 says 1.00. SPEC wins
// per its own preamble. The PLAN.md for this task confirms the same.
const DEFAULTS = Object.freeze({
  max_depth: 2,
  branching: 3,
  budget_usd: 0.50,
  timeout_ms: 120_000,
  task_type: 'standard',
  use_heavyskill: true,
  client: null,
  preferencePairPath: null,
  cache: null,
  system_prompt: null,
  workspaceDir: null,
  use_repl: false,
  K: 4,
});

const VALID_TASK_TYPES = new Set([
  'simple', 'standard', 'security', 'financial', 'creative', 'reasoning', 'code', 'arithmetic',
]);

/**
 * rlm() — Recursive Language Model primitive (SPEC §3.1).
 *
 * @param {Object} options
 * @param {string} options.problem
 * @param {string|{path: string, type: string, hint?: string}} options.context
 * @param {number} [options.max_depth=2]
 * @param {number} [options.branching=3]
 * @param {number} [options.budget_usd=0.50]
 * @param {number} [options.timeout_ms=120000]
 * @param {string} [options.task_type='standard']
 * @param {boolean} [options.use_heavyskill=true]
 * @param {{generate: Function}} [options.client]
 * @param {string} [options.preferencePairPath]
 * @param {Object} [options.cache]
 * @param {string|{system: string, user: string}} [options.system_prompt]
 * @param {string} [options.workspaceDir]
 * @param {boolean} [options.use_repl=false]
 * @param {number} [options.K=4]
 * @returns {Promise<{
 *   final: string,
 *   trace: string[],
 *   tree: Object,
 *   depth_reached: number,
 *   cost_usd: number,
 *   sub_calls: number,
 *   partial: boolean,
 *   run_id: string,
 *   pair_written: boolean
 * }>}
 * @throws {RlmConfigError} on bad config (programmer error)
 * @throws {RlmBudgetExceededError} on cost cap hit before any usable answer
 * @throws {RlmTimeoutError} on wall-clock cap
 * @throws {RlmSecurityError} on REPL sandbox violation
 * @throws {RlmEnvironmentError} on REPL crash (non-security) twice in a row
 */
export async function rlm(options) {
  const opts = validateOptions(options);

  // 1. Resolve client.
  const client = opts.client || await loadDefaultClient();
  if (!client || typeof client.generate !== 'function') {
    throw new RlmConfigError('rlm: client.generate is required (no default client available)');
  }

  // 2. Build run state (mutable, shared across recursion).
  const run_id = randomUUID();
  const start_ms = Date.now();
  /** @type {any} */
  const state = {
    run_id,
    start_ms,
    cost_so_far: 0,
    sub_calls: 0,
    decomposition_skipped: [],
    env_errors: [],
    env_paginated: false,
    aggregation_retries: 0,
    aggregation_fallback: 'none',
    leaf_failures: 0,
    partial: false,
    partial_tree: null,
    pair_written: false,
  };

  // 3. Load the context environment.
  let env;
  try {
    env = await loadContext(opts.context, opts.workspaceDir);
  } catch (err) {
    if (err instanceof RlmConfigError) throw err;
    throw new RlmEnvironmentError(
      `rlm: failed to load context: ${err.message || err}`,
      null,
      run_id,
    );
  }

  // 4. Run the recursive tree.
  let tree;
  try {
    tree = await runNode({
      problem: opts.problem,
      env,
      opts: { ...opts, client },
      state,
      depth: 0,
    });
  } catch (err) {
    // Annotate partial_tree on RlmError throws.
    if (err instanceof RlmError) {
      err.partial_tree = state.partial_tree || tree || null;
      err.run_id = err.run_id || run_id;
      // Write security audit if applicable.
      if (err instanceof RlmSecurityError) {
        await writeSecurityAudit({
          run_id,
          audit_id: err.audit_id || randomUUID(),
          attempted_op: err.attempted_op,
          killed_by: 'wrapper_filter',
        });
      }
      throw err;
    }
    // Unknown error — wrap.
    throw err;
  }

  // 5. Roll up totals.
  const depth_reached = maxDepthInTree(tree);
  const cost_usd = rollupCost(tree);
  const sub_calls = countCalls(tree);
  const partial = state.partial || !!tree.meta?.partial;

  // 6. Write the root preference pair (SPEC §8.1) when configured.
  let pair_written = false;
  if (opts.preferencePairPath) {
    pair_written = await writeRootPair({
      path: opts.preferencePairPath,
      problem: opts.problem,
      task_type: opts.task_type,
      final: tree.answer,
      prm_score: tree.children.length > 0
        ? tree.children.reduce((s, c) => s + (c.meta?.prm_score ?? 0.5), 0) / tree.children.length
        : 0.5,
      tree: { depth_reached, sub_calls, ok: !partial, partial, run_id },
      cost: {
        total_usd: cost_usd,
        decomposition_usd: tree.cost?.decomposition_usd ?? 0,
        aggregation_usd: tree.cost?.aggregation_usd ?? 0,
        leaf_usd_total: tree.cost?.leaf_usd_total ?? 0,
      },
      client,
      opts,
    });
  }

  return {
    final: tree.answer || '',
    trace: traceAnswers(tree),
    tree,
    depth_reached,
    cost_usd,
    sub_calls,
    partial,
    run_id,
    pair_written,
  };
}

// ─── Validation ───────────────────────────────────────────────────────────

function validateOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new RlmConfigError('rlm: options object is required');
  }
  const o = { ...DEFAULTS, ...options };

  // problem
  if (typeof o.problem !== 'string' || o.problem.length === 0) {
    throw new RlmConfigError('rlm: problem must be a non-empty string');
  }
  if (o.problem.length > 100_000) {
    throw new RlmConfigError(`rlm: problem exceeds 100KB (got ${o.problem.length} chars)`);
  }

  // context — structural check only; loadContext validates deeper.
  if (o.context === undefined || o.context === null) {
    throw new RlmConfigError('rlm: context is required (string or { path, type, hint? })');
  }
  const isStr = typeof o.context === 'string';
  const isObj = typeof o.context === 'object' && o.context !== null;
  if (!isStr && !isObj) {
    throw new RlmConfigError('rlm: context must be a string or { path, type, hint? }');
  }
  if (isObj) {
    if (typeof o.context.path !== 'string' || !o.context.path.startsWith('/')) {
      throw new RlmConfigError('rlm: context.path must be an absolute path');
    }
    if (!['directory', 'pdf', 'log', 'sqlite'].includes(o.context.type)) {
      throw new RlmConfigError(`rlm: context.type must be one of directory|pdf|log|sqlite`);
    }
    if (o.context.hint !== undefined && typeof o.context.hint !== 'string') {
      throw new RlmConfigError('rlm: context.hint must be a string when present');
    }
    if (!o.workspaceDir) {
      throw new RlmConfigError('rlm: workspaceDir is required when context is a typed object');
    }
    if (typeof o.workspaceDir !== 'string' || !isAbsolute(o.workspaceDir)) {
      throw new RlmConfigError('rlm: workspaceDir must be an absolute path');
    }
  }

  // scalar ranges
  if (!Number.isInteger(o.max_depth) || o.max_depth < 1 || o.max_depth > 5) {
    throw new RlmConfigError(`rlm: max_depth must be an integer in [1,5] (got ${o.max_depth})`);
  }
  if (!Number.isInteger(o.branching) || o.branching < 1 || o.branching > 7) {
    throw new RlmConfigError(`rlm: branching must be an integer in [1,7] (got ${o.branching})`);
  }
  if (!Number.isFinite(o.budget_usd) || o.budget_usd < 0) {
    throw new RlmConfigError(`rlm: budget_usd must be a non-negative number (got ${o.budget_usd})`);
  }
  if (!Number.isInteger(o.timeout_ms) || o.timeout_ms < 0) {
    throw new RlmConfigError(`rlm: timeout_ms must be a non-negative integer (got ${o.timeout_ms})`);
  }
  if (typeof o.task_type !== 'string' || !VALID_TASK_TYPES.has(o.task_type)) {
    throw new RlmConfigError(`rlm: task_type must be one of ${[...VALID_TASK_TYPES].join('|')}`);
  }
  if (typeof o.use_heavyskill !== 'boolean') {
    throw new RlmConfigError('rlm: use_heavyskill must be a boolean');
  }
  if (o.client !== null && (typeof o.client !== 'object' || typeof o.client.generate !== 'function')) {
    throw new RlmConfigError('rlm: client must be an object with a generate(prompt, opts) method');
  }
  if (o.preferencePairPath !== null && typeof o.preferencePairPath !== 'string') {
    throw new RlmConfigError('rlm: preferencePairPath must be a string path or null');
  }
  if (o.cache !== null && typeof o.cache !== 'object') {
    throw new RlmConfigError('rlm: cache must be an object or null');
  }
  if (o.system_prompt !== null && typeof o.system_prompt !== 'string' && typeof o.system_prompt !== 'object') {
    throw new RlmConfigError('rlm: system_prompt must be a string, {system,user} object, or null');
  }
  if (o.K !== undefined && (!Number.isInteger(o.K) || o.K < 1)) {
    throw new RlmConfigError(`rlm: K must be a positive integer (got ${o.K})`);
  }

  return o;
}

// ─── Default client (lazy) ────────────────────────────────────────────────

/**
 * Try to load a default LLM client. We prefer an injected client (tests);
 * in production this would point at the built-in minimax client.
 *
 * v1: returns null if no client was injected. The caller throws a clear
 * RlmConfigError so the test author knows to inject one.
 */
async function loadDefaultClient() {
  try {
    const mod = await import('./clients/minimax.js');
    if (mod && typeof mod.default === 'object' && typeof mod.default.generate === 'function') {
      return mod.default;
    }
    if (mod && typeof mod.generate === 'function') return mod;
  } catch {
    // Fall through.
  }
  return null;
}

// ─── Preference pair writing (SPEC §8.1) ─────────────────────────────────

async function writeRootPair({ path, problem, task_type, final, prm_score, tree, cost, client, opts }) {
  try {
    // The "rejected" baseline is a single heavy_think()-style call on the
    // same problem with no recursion. v1: best-effort — if the client
    // refuses to do it, we still write the chosen side.
    let rejected_reasoning = '';
    let rejected_prm = 0;
    try {
      const baselinePrompt = problem + (opts.context && typeof opts.context === 'string'
        ? `\n\nContext:\n${opts.context}`
        : '');
      const out = await client.generate(baselinePrompt, { task_type, role: 'rlm_baseline' });
      rejected_reasoning = out.reasoning || out.text || '';
      rejected_prm = 0.5; // baseline has no PRM signal in v1
    } catch {
      rejected_reasoning = '(baseline generation failed)';
    }

    const record = {
      ts: new Date().toISOString(),
      component: 'rlm',
      problem,
      task_type,
      // SCORE-INSTRUMENT CONTRACT (2026-11-11, kanban t_99423c45).
      // The chosen side aggregates child confidences (a surrogate), the
      // rejected side is a constant placeholder (also a surrogate). Neither
      // is a PRM-judge score, so both sides are tagged with the instrument
      // that produced them. The trainer's parity guard requires both sides
      // of a pair to come from the SAME instrument before their difference
      // is treated as a preference signal.
      chosen: { reasoning: final, prm_score, prm_score_source: 'rlm_confidence_aggregate' },
      rejected: { reasoning: rejected_reasoning, prm_score: rejected_prm, prm_score_source: 'rlm_baseline_placeholder' },
      tree,
      cost,
    };
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (err) {
    // Audit failure is non-fatal; surface in result for debugging.
    console.error(`rlm: preference pair write failed: ${err.message || err}`);
    return false;
  }
}

// ─── Security audit (SPEC §8.3) ────────────────────────────────────────────

async function writeSecurityAudit({ run_id, audit_id, attempted_op, killed_by }) {
  const path = process.env.RLM_SECURITY_AUDIT_PATH
    || `${process.env.HOME || '/tmp'}/.openclaw/audit/rlm/security.jsonl`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify({
      ts: new Date().toISOString(),
      run_id,
      audit_id,
      attempted_op,
      killed_by,
    }) + '\n', 'utf8');
  } catch (err) {
    console.error(`rlm: security audit write failed: ${err.message || err}`);
  }
}

// ─── Re-exports (SPEC §3.6) ───────────────────────────────────────────────

export {
  RlmError,
  RlmBudgetExceededError,
  RlmTimeoutError,
  RlmSecurityError,
  RlmEnvironmentError,
  RlmConfigError,
};

// Internal helpers exposed for tests (not part of the SPEC public API).
export const __internal = { validateOptions, DEFAULTS };