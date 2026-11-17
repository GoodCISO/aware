// src/trainer/index.js — aware-trainer poller (Phase 3, ADR (internal))
//
// The aware-trainer is a long-running Node service that watches for new
// preference pairs in Postgres, submits DPO training jobs to Modal,
// polls for completion, and atomically swaps the active weight
// checkpoint. It does NOT do any model training itself — that's the
// training/run.py job that runs inside the Modal container.
//
// Lifecycle:
//   1. Read config/modal-training.json + env vars
//   2. Poll Postgres on a fixed interval (config.trainer.pollIntervalSec)
//   3. When a new training run is needed:
//      a. Package the latest preference pairs as a DPO dataset (JSONL)
//      b. Submit a Modal Function.remote() call (the training/run.py script)
//      c. Record the run in aware_training_runs (status='pending')
//      d. Poll the Modal job for completion
//      e. On success: download the checkpoint, atomic symlink swap, mark completed
//      f. On failure: mark failed with exit_code + error_message
//   4. Honor the kill switch (AWARE_TRAINER_ENABLED=0) — return immediately
//
// SECURITY MODEL
// ==============
// - The Modal token is read from process.env once at boot and stored
//   in a module-level variable. It is NEVER logged, NEVER serialized
//   to disk, NEVER echoed to stdout/stderr. The only consumer is the
//   Modal SDK which receives it via its constructor.
// - The kill switch (config.trainer.enabled) is re-read on every poll
//   so flipping AWARE_TRAINER_ENABLED=0 takes effect within
//   pollIntervalSec without a restart.
// - All DB calls are never-throw: pool=null → no-op (with warning log).
//   This is consistent with src/db/logger.js + src/db/prm-cache.js.
//
// NO MODAL ACCESS REQUIRED FOR TESTS. The Modal client is dependency-
// injected via the second arg to start(). The default constructor uses
// a stub that throws on every call — useful for catching "you forgot
// to inject a real client" bugs.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import config from '../config/index.cjs';
import { getPool } from '../db/index.js';

// -- Types (JSDoc only; ESM-strict, no TypeScript) ------------------------

/**
 * @typedef {Object} PreferencePair
 * @property {string} problem
 * @property {{reasoning: string, prm_score: number}} chosen
 * @property {{reasoning: string, prm_score: number}} rejected
 * @property {{ts: string, task_type: string}} _metadata
 */

/**
 * @typedef {Object} ModalJobHandle
 * @property {string} jobId
 * @property {string} appName
 * @property {() => Promise<{status: string, exitCode?: number, errorMessage?: string}>} poll
 * @property {() => Promise<{checkpointPath: string, sizeMb: number}>} getCheckpoint
 */

/**
 * @typedef {Object} ModalClient
 * @property {(args: {runId: string, datasetPath: string, config: object}) => Promise<ModalJobHandle>} submit
 */

/**
 * @typedef {Object} TrainerDeps
 * @property {ModalClient} [modalClient]   — injectable; default is a throwing stub
 * @property {Object}    [pool]           — injectable pg.Pool; default is from getPool()
 * @property {object}    [logger]         — injectable logger; default is console
 * @property {string}    [dataDir]        — local dir for DPO dataset staging; default /tmp/aware-trainer
 */

// -- Logger (default = console, inject for tests) -----------------------

function makeLogger(explicit) {
  if (explicit) return explicit;
  return {
    info: (...args) => console.log('[aware-trainer]', ...args),
    warn: (...args) => console.warn('[aware-trainer]', ...args),
    error: (...args) => console.error('[aware-trainer]', ...args),
    debug: (...args) => {
      if (process.env.AWARE_TRAINER_DEBUG) {
        console.log('[aware-trainer:debug]', ...args);
      }
    },
  };
}

// -- Modal client (default = stub that throws) ---------------------------

function defaultModalClient() {
  return {
    async submit() {
      throw new Error(
        'aware-trainer: no Modal client injected. ' +
        'Pass { modalClient } to start() or set up the real client ' +
        'via src/trainer/modal-client.js (not yet implemented; this ' +
        'service is environment-gated and only runs when ' +
        'AWARE_TRAINER_ENABLED=1 AND a real Modal account is configured).'
      );
    },
  };
}

// -- Main class ---------------------------------------------------------

export class TrainerPoller {
  /**
   * @param {TrainerDeps} [deps]
   */
  constructor(deps = {}) {
    this.deps = {
      modalClient: deps.modalClient || defaultModalClient(),
      pool: deps.pool || null,  // lazy: getPool() in start()
      logger: makeLogger(deps.logger),
      dataDir: deps.dataDir || '/tmp/aware-trainer',
    };
    this._stopped = false;
    this._timer = null;
    this._inFlight = null;  // Promise<void> | null — prevents re-entrancy
  }

  /**
   * Start the polling loop. Resolves when the loop has scheduled
   * itself. Rejects only on a hard error at boot.
   */
  async start() {
    if (!config.trainer.enabled) {
      this.deps.logger.info('kill switch off (AWARE_TRAINER_ENABLED=0); not starting');
      return;
    }

    // Verify we have a Modal token. We do NOT log the value — only the
    // presence + length, so a misconfigured compose env is loud but
    // a real token never leaks.
    if (!config.trainer.modalTokenId || !config.trainer.modalTokenSecret) {
      this.deps.logger.warn(
        'AWARE_TRAINER_ENABLED=1 but MODAL_TOKEN_ID or MODAL_TOKEN_SECRET is unset; ' +
        'trainer will start but every job submission will fail. ' +
        'Set both env vars in redacted-credential-file to enable real runs.'
      );
    } else {
      this.deps.logger.info(
        `Modal tokens present (id length=${config.trainer.modalTokenId.length}, ` +
        `secret length=${config.trainer.modalTokenSecret.length})`
      );
    }

    // Validate the modal-training.json config
    const cfg = await loadTrainingConfig(config.trainer.configPath, this.deps.logger);
    this._trainingConfig = cfg;

    // Ensure the data dir exists for DPO dataset staging
    await fsp.mkdir(this.deps.dataDir, { recursive: true });

    // Acquire a DB pool (may be null if AWARE_DB_ENABLED=0)
    if (!this.deps.pool) {
      this.deps.pool = await getPool();
    }
    if (!this.deps.pool) {
      this.deps.logger.warn('DB pool unavailable; trainer will run in dry-poll mode (no run records, no checkpoint swap)');
    }

    this.deps.logger.info(
      `aware-trainer started: pollIntervalSec=${config.trainer.pollIntervalSec}, ` +
      `minPairsPerRun=${config.trainer.minPairsPerRun}, ` +
      `baseModel=${config.trainer.baseModel}, ` +
      `gpu=${config.trainer.gpuType}`
    );

    // Schedule the first poll immediately, then on interval
    this._scheduleNext(0);
  }

  /**
   * Stop the polling loop. Resolves once any in-flight poll completes.
   */
  async stop() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._inFlight) {
      try { await this._inFlight; } catch { /* swallow */ }
    }
    this.deps.logger.info('aware-trainer stopped');
  }

  _scheduleNext(delayMs) {
    if (this._stopped) return;
    this._timer = setTimeout(() => {
      this._inFlight = this._tick().catch((e) => {
        this.deps.logger.error('tick failed:', e?.message || e);
      }).finally(() => {
        this._inFlight = null;
        this._scheduleNext(config.trainer.pollIntervalSec * 1000);
      });
    }, delayMs);
  }

  /**
   * One polling cycle. Exposed (not private) so tests can drive it
   * deterministically without waiting for setTimeout.
   */
  async _tick() {
    // Re-read the kill switch on every tick (no caching).
    if (!config.trainer.enabled) {
      this.deps.logger.info('kill switch flipped off mid-loop; exiting tick');
      this._stopped = true;
      return;
    }

    // 1. Look for an in-flight run that needs status polling
    const inflight = await this._findInflightRun();
    if (inflight) {
      await this._pollInflightRun(inflight);
      return;
    }

    // 2. Count available preference pairs (above minPairsPerRun threshold?)
    const counts = await this._countPreferencePairs();
    this.deps.logger.debug(
      `preference-pair counts: unconsumed=${counts.unconsumed}, threshold=${config.trainer.minPairsPerRun}`
    );
    if (counts.unconsumed < config.trainer.minPairsPerRun) {
      this.deps.logger.debug('not enough pairs to trigger a run; sleeping');
      return;
    }

    // 3. Submit a new training run
    const runId = `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    await this._submitNewRun(runId, counts);
  }

  // -- DB operations (no-ops if pool=null) ----------------------------

  async _findInflightRun() {
    if (!this.deps.pool) return null;
    const r = await this.deps.pool.query(
      `SELECT run_id, modal_job_id, modal_app_name, started_at
       FROM aware_training_runs
       WHERE status IN ('pending', 'running')
       ORDER BY started_at ASC
       LIMIT 1`
    );
    return r.rows[0] || null;
  }

  async _countPreferencePairs() {
    if (!this.deps.pool) {
      // Dry-poll mode: report 0 unconsumed pairs so the trainer never
      // tries to submit (which would call the default-stub Modal
      // client and throw).
      return { unconsumed: 0, total: 0 };
    }
    // "unconsumed" = preference pairs logged since the last completed run.
    // We use the started_at of the most recent completed run as the
    // watermark. Pairs with ts > that watermark are unconsumed.
    //
    // We filter on `pair_path IS NOT NULL` because the actual
    // (chosen, rejected) content lives in the rl-pipeline JSONL file
    // at that path — the aware_conversations row is just the metadata
    // pointer. (Earlier revisions of this query filtered on
    // `c.chosen IS NOT NULL AND c.rejected IS NOT NULL`, which are
    // columns that don't exist on the schema — see
    // db/migrations/001_conversations.sql. That filter never matched
    // any row in production; the trainer's unconsumed count was
    // always 0. Fixed in Phase 4.)
    const r = await this.deps.pool.query(`
      WITH last_run AS (
        SELECT MAX(completed_at) AS ts FROM aware_training_runs
        WHERE status = 'completed'
      )
      SELECT
        COUNT(*) FILTER (WHERE c.ts > COALESCE(last_run.ts, '1970-01-01'::timestamptz)) AS unconsumed,
        COUNT(*) AS total
      FROM aware_conversations c, last_run
      WHERE c.ok = true
        AND c.pair_path IS NOT NULL
    `);
    const row = r.rows[0] || {};
    return {
      unconsumed: Number(row.unconsumed || 0),
      total: Number(row.total || 0),
    };
  }

  async _recordRunStart(runId, datasetPath, nPairs, options = {}) {
    if (!this.deps.pool) return;
    // Phase 4 deliverable 1: optionally store the AZR corpus path so
    // _ingestAzrCorpus can find it after the run completes. Only
    // set when the operator enabled --gen-azr-corpus on the
    // training run (i.e. config.trainer.azrCorpusPath is set).
    const azrCorpusPath = options.azrCorpusPath || config.trainer.azrCorpusPath || null;
    await this.deps.pool.query(
      `INSERT INTO aware_training_runs
         (run_id, started_at, status, source, dataset_path, azr_corpus_path, n_pairs,
          modal_app_name, base_model, gpu_type,
          beta, learning_rate, epochs, per_device_batch_size)
       VALUES ($1, NOW(), 'pending', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        runId,
        'preference_pairs_volume',
        datasetPath,
        azrCorpusPath,
        nPairs,
        this._trainingConfig.app_name,
        config.trainer.baseModel,
        config.trainer.gpuType,
        this._trainingConfig.dpo_defaults?.beta,
        this._trainingConfig.dpo_defaults?.learning_rate,
        this._trainingConfig.dpo_defaults?.epochs,
        this._trainingConfig.dpo_defaults?.per_device_train_batch_size,
      ]
    );
  }

  async _recordRunRunning(runId, modalJobId) {
    if (!this.deps.pool) return;
    await this.deps.pool.query(
      `UPDATE aware_training_runs
       SET status = 'running', modal_job_id = $2
       WHERE run_id = $1`,
      [runId, modalJobId]
    );
  }

  async _recordRunCompleted(runId, exitCode, durationSec, checkpointPath, sizeMb) {
    if (!this.deps.pool) return;
    await this.deps.pool.query(
      `UPDATE aware_training_runs
       SET status = 'completed',
           completed_at = NOW(),
           exit_code = $2,
           duration_sec = $3,
           checkpoint_dir = $4,
           checkpoint_size_mb = $5
       WHERE run_id = $1`,
      [runId, exitCode, durationSec, checkpointPath, sizeMb]
    );
    // Phase 4 deliverable 1: if this run generated an AZR corpus,
    // ingest the per-record results into aware_azr_results so the
    // next training tick's azr_result filter has something to gate
    // against. Best-effort: log + continue on failure (we don't
    // want a bad corpus file to fail the whole completion record).
    await this._ingestAzrCorpus(runId);
  }

  /**
   * Read the AZR self-play corpus (if any) for a completed run and
   * insert one row per AZR result into aware_azr_results. The
   * corpus path is stored in aware_training_runs.azr_corpus_path
   * (set at run-start time when --gen-azr-corpus was enabled).
   *
   * Best-effort: errors are logged at warn and swallowed. The
   * aware_azr_results table is a derived cache of the corpus JSONL
   * (which is the canonical source); a failed ingestion just means
   * the next training tick's azr_result filter will be slightly
   * under-informed.
   *
   * Idempotent: re-running on the same corpus re-inserts the same
   * rows. The PRIMARY KEY on aware_azr_results is a BIGSERIAL
   * (id), not (run_id, content_hash), so duplicates accumulate
   * rather than collide. Operators who care about dedup can run
   * `DELETE FROM aware_azr_results WHERE run_id = $1` before
   * re-ingesting. (Out of scope for this slice.)
   *
   * @param {string} runId
   */
  async _ingestAzrCorpus(runId) {
    if (!this.deps.pool) return;
    try {
      const r = await this.deps.pool.query(
        'SELECT azr_corpus_path FROM aware_training_runs WHERE run_id = $1',
        [runId]
      );
      const corpusPath = r.rows[0]?.azr_corpus_path;
      if (!corpusPath) {
        this.deps.logger.debug(
          `_ingestAzrCorpus: run ${runId} has no azr_corpus_path (--gen-azr-corpus not set?); skipping`
        );
        return;
      }
      let text;
      try {
        text = await fsp.readFile(corpusPath, 'utf8');
      } catch (e) {
        this.deps.logger.warn(
          `_ingestAzrCorpus: cannot read corpus file ${corpusPath}: ${e?.message || e}; skipping`
        );
        return;
      }
      const lines = text.split('\n').filter(l => l.trim().length > 0);
      let ingested = 0;
      for (const line of lines) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch (e) {
          continue;  // skip malformed lines silently
        }
        // The AZR corpus record shape (from training/run.py:gen_azr_corpus):
        //   { ts, problem, task_type, chosen, rejected, verification: { method, passed, duration_ms }, cost, _content_hash }
        if (!rec || typeof rec !== 'object') continue;
        if (typeof rec._content_hash !== 'string' || rec._content_hash.length === 0) continue;
        if (rec.task_type !== 'azr_self_play') continue;  // future: extend
        const passed = rec.verification?.passed === true;
        // The phase-4 decision is: tag-based join, but the join key
        // we populated in the schema is (task_type, content_hash).
        // problem_hash is also stored for future embedding-similarity
        // joins (Phase 4+future).
        const problemHash = await _sha256OfProblem(rec.problem || '');
        await this.deps.pool.query(
          `INSERT INTO aware_azr_results
             (run_id, task_type, problem_hash, content_hash, passed,
              verification_method, chosen_score, rejected_score,
              duration_ms, corpus_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            runId,
            rec.task_type,
            problemHash,
            rec._content_hash,
            passed,
            rec.verification?.method || 'azr.executor',
            rec.chosen?.prm_score ?? null,
            rec.rejected?.prm_score ?? null,
            rec.verification?.duration_ms ?? null,
            corpusPath,
          ]
        );
        ingested += 1;
      }
      this.deps.logger.info(
        `_ingestAzrCorpus: ingested ${ingested} AZR results for run ${runId} from ${corpusPath}`
      );
    } catch (e) {
      this.deps.logger.warn(
        `_ingestAzrCorpus: failed for run ${runId}: ${e?.message || e}; continuing`
      );
    }
  }

  async _recordRunFailed(runId, exitCode, errorMessage) {
    if (!this.deps.pool) return;
    await this.deps.pool.query(
      `UPDATE aware_training_runs
       SET status = 'failed',
           completed_at = NOW(),
           exit_code = $2,
           error_message = $3
       WHERE run_id = $1`,
      [runId, exitCode, errorMessage.slice(0, 4000)]
    );
  }

  /**
   * Record a cancelled run. Used by _submitNewRun when the outcome
   * filter drops every pair (no DPO dataset to train on, so we
   * never submit to Modal). Different from _recordRunFailed: no
   * exit_code (the run never started) and the error_message
   * explains WHY it was cancelled (so the operator can see the
   * filter is too aggressive).
   */
  async _recordRunCancelled(runId, datasetPath, nSourcePairs, reason) {
    if (!this.deps.pool) return;
    await this.deps.pool.query(
      `INSERT INTO aware_training_runs
         (run_id, started_at, completed_at, status, source, dataset_path,
          n_pairs, modal_app_name, base_model, gpu_type, error_message)
       VALUES ($1, NOW(), NOW(), 'cancelled', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        runId,
        'preference_pairs_volume',
        datasetPath,
        nSourcePairs,
        this._trainingConfig?.app_name || 'aware-trainer',
        config.trainer.baseModel,
        config.trainer.gpuType,
        reason.slice(0, 4000),
      ]
    );
  }

  // -- Submit / poll / finalize ---------------------------------------

  async _submitNewRun(runId, counts) {
    this.deps.logger.info(`submitting new run: ${runId} (pairs=${counts.unconsumed})`);
    const datasetPath = path.join(this.deps.dataDir, `${runId}.jsonl`);

    // Phase 4 (ADR (internal) 618-627): package the latest preference pairs
    // as a real DPO dataset. Pipeline:
    //   1. SELECT the unconsumed aware_conversations rows (ts > last
    //      completed-run watermark, ok=true, pair_path IS NOT NULL)
    //   2. Group by pair_path, read each unique JSONL file
    //   3. Parse all lines, dedup by _content_hash
    //   4. Apply outcome filter (default: noop; configurable via
    //      config.trainer.filterRule)
    //   5. Run rl-pipeline's toDpoDataset to produce the DPO rows
    //   6. Write the rows to datasetPath (one JSON object per line)
    //   7. If the file is non-empty, proceed to submit. If empty
    //      (e.g. all records filtered out), record a cancelled run
    //      and skip the Modal submit.
    const { rowsWritten, rowsDropped, sourceFilesRead } =
      await this._packageDataset(datasetPath);

    this.deps.logger.info(
      `dataset packaged: path=${datasetPath} rows=${rowsWritten} ` +
      `dropped=${rowsDropped} source_files=${sourceFilesRead}`
    );

    if (rowsWritten === 0) {
      // No usable pairs after the filter. Don't burn GPU credit on
      // an empty dataset — record a cancelled run and bail.
      this.deps.logger.warn(
        `run ${runId} cancelled: no pairs survived outcome filter ` +
        `(${rowsDropped} dropped across ${sourceFilesRead} source files)`
      );
      await this._recordRunCancelled(runId, datasetPath, counts.unconsumed,
        `no pairs after outcome filter (dropped=${rowsDropped})`);
      return;
    }

    await this._recordRunStart(runId, datasetPath, rowsWritten);

    try {
      const job = await this.deps.modalClient.submit({
        runId,
        datasetPath,
        config: this._trainingConfig,
      });
      await this._recordRunRunning(runId, job.jobId);
      this.deps.logger.info(`run ${runId} submitted: jobId=${job.jobId} app=${job.appName}`);
    } catch (e) {
      this.deps.logger.error(`run ${runId} submit failed: ${e?.message || e}`);
      await this._recordRunFailed(runId, 1, e?.message || String(e));
    }
  }

  /**
   * Package the latest preference pairs as a DPO dataset.
   *
   * Returns { rowsWritten, rowsDropped, sourceFilesRead }.
   * Pure I/O wrapper — all filtering / dedup logic is delegated to
   * rl-pipeline's toDpoDataset() and outcome-filter.js.
   */
  async _packageDataset(datasetPath) {
    // 1. Fetch the unconsumed pair_path values from aware_conversations
    const pairPaths = await this._fetchUnconsumedPairPaths();
    if (pairPaths.length === 0) {
      // No new pairs to package — write an empty file and return.
      await fsp.writeFile(datasetPath, '');
      return { rowsWritten: 0, rowsDropped: 0, sourceFilesRead: 0 };
    }

    // 2. Read each unique JSONL file, parse all lines
    const allRecords = await this._readPreferencePairFiles(pairPaths);

    // 3. Apply the outcome filter (default: noop)
    const filterRule = config.trainer.filterRule || 'noop';
    const filterOptions = { rule: filterRule };
    // Judge independence is an ORTHOGONAL precondition, not a rule: it
    // composes with whichever rule is active, so the score-instrument
    // parity checks keep running alongside it (kanban t_155a95a1).
    const requireIndependentJudge = String(
      config.trainer.filterRequireIndependentJudge || '0'
    ).toLowerCase() === '1' || String(
      config.trainer.filterRequireIndependentJudge || '0'
    ).toLowerCase() === 'true';
    if (requireIndependentJudge) {
      filterOptions.requireIndependentJudge = true;
    }
    if (filterRule === 'min_score_gap') {
      filterOptions.minGap = config.trainer.filterMinGap;
    } else if (filterRule === 'tag_match') {
      const raw = config.trainer.filterAllowedTaskTypes;
      filterOptions.allowedTaskTypes = raw
        ? raw.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    } else if (filterRule === 'require_independent_judge') {
      // The standalone rule: drop every pair whose judge was not
      // independent. Composes with the orthogonally-set
      // requireIndependentJudge precondition (both check the same fact).
    } else if (filterRule === 'azr_result') {
      // Phase 4 deliverable 1: load the AZR pass index from the
      // aware_azr_results table. The index is filtered to
      // passed=true at the SQL level so the in-memory Map IS the
      // "this problem has been AZR-verified and passed" set.
      filterOptions.azrIndex = await this._loadAzrResultIndex();
    }
    const { filterOutcomePairs } = await import('./outcome-filter.js');
    const filterResult = filterOutcomePairs(allRecords, filterOptions);
    if (filterResult.dropped.length > 0) {
      this.deps.logger.debug(
        `outcome-filter dropped ${filterResult.dropped.length}/${allRecords.length} ` +
        `records (rule=${filterRule}); first reasons: ` +
        `${filterResult.dropped.slice(0, 3).map(d => d.reason).join(', ')}`
      );
    }
    // DIAGNOSTIC SIGNAL (kanban t_155a95a1). Pairs admitted WITHOUT their
    // score being allowed to gate — the judge was not independent of the
    // candidate, so its verdict is a diagnostic, never a launch gate
    // (04-ai-product-evaluation.md:187-190). The gap is preserved on the
    // record; this line makes the demotion VISIBLE to the operator, because
    // a gate that silently stopped gating is the failure mode this card
    // exists to prevent.
    if (filterResult.diagnostics.length > 0) {
      this.deps.logger.warn(
        `outcome-filter admitted ${filterResult.diagnostics.length}/${allRecords.length} ` +
        `records on a DIAGNOSTIC signal (rule=${filterRule}, ` +
        `requireIndependentJudge=${requireIndependentJudge}); their judge was not ` +
        `independent, so the score did not gate; first reasons: ` +
        `${filterResult.diagnostics.slice(0, 3).map(d => d.reason).join(', ')}`
      );
    }

    // 4. Run AWARE's own DPO dataset assembler (handles minScoreGap + dedup).
    // Was: `await import(config.rlPipeline.path)` for `toDpoDataset`,
    // but rl-pipeline doesn't export it (ADR (internal) §Finding 4). The
    // AWARE-local module at ./dpo-dataset.js implements the same contract
    // (see ADR (internal) Repair 4).
    const { toDpoDataset } = await import('./dpo-dataset.js');
    const { rows, skipped } = toDpoDataset(filterResult.kept, {
      format: 'messages',
      minScoreGap: 0.05,
      dedupeByHash: true,
    });

    // 5. Write the JSONL output
    const jsonl = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    await fsp.writeFile(datasetPath, jsonl, 'utf8');

    return {
      rowsWritten: rows.length,
      rowsDropped: skipped.lowGap + skipped.duplicate + skipped.invalid +
        skipped.mixedInstrument + filterResult.dropped.length,
      // Pairs admitted on a demoted (diagnostic) signal — reported alongside
      // the drop count so the operator sees that the score did not gate.
      rowsDiagnostic: filterResult.diagnostics.length +
        (skipped.nonIndependentJudge || 0),
      sourceFilesRead: pairPaths.length,
    };
  }

  /**
   * SELECT the distinct pair_path values for unconsumed
   * aware_conversations rows.
   *
   * @returns {Promise<string[]>}
   */
  async _fetchUnconsumedPairPaths() {
    if (!this.deps.pool) {
      throw new Error('_fetchUnconsumedPairPaths: pool is null');
    }
    const r = await this.deps.pool.query(`
      WITH last_run AS (
        SELECT MAX(completed_at) AS ts FROM aware_training_runs
        WHERE status = 'completed'
      )
      SELECT DISTINCT c.pair_path
      FROM aware_conversations c, last_run
      WHERE c.ok = true
        AND c.pair_path IS NOT NULL
        AND c.ts > COALESCE(last_run.ts, '1970-01-01'::timestamptz)
    `);
    return r.rows.map(row => row.pair_path).filter(Boolean);
  }

  /**
   * Load the AZR pass-result index from the aware_azr_results table.
   *
   * Phase 4 deliverable 1: this is the "AZR gates process-RL pipeline" join
   * surface. We SELECT all content_hash values that have at least
   * one row with passed=true, and return them as a Map<content_hash,
   * {passed, runId, recordedAt}>. The in-memory map is what the
   * outcome-filter's `azr_result` rule reads against.
   *
   * Performance: the partial index `idx_azr_results_join_key` on
   * (task_type, content_hash) WHERE passed=true keeps this query
   * O(matches) rather than O(table). For a corpus of 100k AZR
   * results with 80% pass rate, the index is ~80k entries. Loading
   * 80k rows on every training tick is acceptable (the trainer's
   * pollIntervalSec is 5min by default, and pg can stream 80k rows
   * in <500ms). If this becomes a bottleneck, add a
   * `recorded_at > last_loaded_at` watermark + in-process cache.
   *
   * Returns an empty Map when pool is null (test/dev path) — the
   * filter's lenient policy treats this as "no AZR results yet"
   * and keeps every record.
   *
   * @returns {Promise<Map<string, {passed: boolean, runId: string, recordedAt: string}>>}
   */
  async _loadAzrResultIndex() {
    if (!this.deps.pool) {
      // Test/dev path: no DB → empty index → lenient policy keeps all.
      return new Map();
    }
    const r = await this.deps.pool.query(`
      SELECT content_hash, run_id, recorded_at
      FROM aware_azr_results
      WHERE passed = true
    `);
    const idx = new Map();
    for (const row of r.rows) {
      if (typeof row.content_hash !== 'string' || row.content_hash.length === 0) continue;
      // If a content_hash appears in multiple runs, keep the most
      // recent recorded_at. Both have passed=true, so the value is
      // structurally identical for the filter's purposes; we just
      // need a single entry per key.
      const existing = idx.get(row.content_hash);
      if (!existing || row.recorded_at > existing.recordedAt) {
        idx.set(row.content_hash, {
          passed: true,
          runId: row.run_id,
          recordedAt: typeof row.recorded_at?.toISOString === 'function'
            ? row.recorded_at.toISOString()
            : String(row.recorded_at),
        });
      }
    }
    this.deps.logger.info(
      `azr-result index loaded: ${idx.size} content_hash entries from aware_azr_results`
    );
    return idx;
  }

  /**
   * Read each unique preference-pair JSONL file, parse all lines,
   * and return the concatenated record list. Malformed lines are
   * dropped silently (logged at debug); an empty / missing file
   * contributes zero records without throwing.
   *
   * @param {string[]} paths
   * @returns {Promise<Object[]>}
   */
  async _readPreferencePairFiles(paths) {
    const seen = new Set();    // dedup by _content_hash across files
    const records = [];
    for (const p of paths) {
      let text;
      try {
        text = await fsp.readFile(p, 'utf8');
      } catch (e) {
        this.deps.logger.warn(
          `preference-pair file unreadable: path=${p} err=${e?.message || e}`
        );
        continue;
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec;
        try {
          rec = JSON.parse(trimmed);
        } catch {
          this.deps.logger.debug(`preference-pair line not JSON: ${trimmed.slice(0, 80)}`);
          continue;
        }
        if (rec && rec._content_hash) {
          if (seen.has(rec._content_hash)) continue;
          seen.add(rec._content_hash);
        }
        records.push(rec);
      }
    }
    return records;
  }

  async _pollInflightRun(row) {
    const { run_id: runId, modal_job_id: jobId } = row;
    this.deps.logger.debug(`polling in-flight run: ${runId} (job=${jobId})`);
    try {
      // Find the live job handle. In the real implementation, we'd
      // either hold a Map<runId, jobHandle> in memory OR re-resolve
      // via modal.Function.from_id(jobId).poll(). For the test seam,
      // we accept an optional _resolveInflight hook.
      const handle = await this._resolveInflight(runId, jobId);
      if (!handle) {
        this.deps.logger.warn(`no live job handle for run ${runId}; will retry next tick`);
        return;
      }
      const status = await handle.poll();
      if (status.status === 'completed') {
        const ckpt = await handle.getCheckpoint();
        await this._atomicSymlinkSwap(ckpt.checkpointPath);
        await this._recordRunCompleted(
          runId, status.exitCode ?? 0,
          Math.round((Date.now() - Date.parse(row.started_at)) / 1000),
          ckpt.checkpointPath,
          ckpt.sizeMb,
        );
        this.deps.logger.info(`run ${runId} completed: checkpoint=${ckpt.checkpointPath} sizeMb=${ckpt.sizeMb}`);
      } else if (status.status === 'failed') {
        await this._recordRunFailed(runId, status.exitCode ?? 1, status.errorMessage || 'unknown');
        this.deps.logger.error(`run ${runId} failed: ${status.errorMessage}`);
      }
      // 'pending' or 'running' → just wait for next tick
    } catch (e) {
      this.deps.logger.error(`poll error for run ${runId}: ${e?.message || e}`);
      // Do NOT mark failed on a poll error — the job may still succeed.
    }
  }

  /**
   * Resolve a live Modal job handle from a run_id + modal_job_id.
   * Delegates to the modal client (modal-client.js) which uses
   * the JS SDK's `client.functionCalls.fromId(jobId)` to re-attach
   * to in-flight runs after a trainer restart.
   *
   * Returns null if:
   *   - the modal client has no resolveInflight (test stub default)
   *   - the SDK call throws (NotFoundError, auth error, etc.)
   *   - the SDK is older than 0.8.0 and lacks functionCalls.fromId
   *
   * In all those cases the trainer logs the warn and continues —
   * the next tick will try again. Operator can also mark a stuck
   * 'running' row as failed/completed manually in psql.
   *
   * The trainer's `_trainingConfig` is the same config the run was
   * submitted with, so we pass volumeMount and timeoutSeconds
   * through so the handle's getCheckpoint() can find the size
   * sentinel.
   */
  async _resolveInflight(_runId, jobId) {
    if (!jobId) return null;
    const modalClient = this.deps?.modalClient;
    if (!modalClient || typeof modalClient.resolveInflight !== 'function') {
      // Default stub (test seam) or older client — can't re-attach.
      return null;
    }
    const tc = this._trainingConfig || {};
    return await modalClient.resolveInflight(jobId, {
      appName: tc.app_name,
      runId: _runId,
      volumeMount: tc.modal_volume?.mount_path,
      timeoutSeconds: tc.timeout_seconds,
    });
  }

  async _atomicSymlinkSwap(checkpointPath) {
    // The symlink lives at ${weightsDir}/active (matches the design
    // comment in src/config/index.cjs and the lora-reloader's
    // resolveActiveTarget path). The parent (${weightsDir}) is
    // pre-created + chown'd in the runtime stage of the trainer
    // image and in docker-compose.coordinator.yml's named volume.
    const weightsDir = config.trainer.weightsDir;
    const activeLink = path.join(weightsDir, 'active');
    const activeLinkParent = path.dirname(activeLink);
    await fsp.mkdir(activeLinkParent, { recursive: true });
    const tmpLink = `${activeLink}.new.${process.pid}.${Date.now()}`;

    // The "atomic" guarantee: create a temp symlink, then rename over
    // the existing one. rename(2) is atomic on the same filesystem.
    await fsp.symlink(checkpointPath, tmpLink);
    try {
      await fsp.rename(tmpLink, activeLink);
      this.deps.logger.info(`active symlink swapped: ${activeLink} → ${checkpointPath}`);
    } catch (e) {
      // Best-effort cleanup
      try { await fsp.unlink(tmpLink); } catch { /* swallow */ }
      throw e;
    }
  }
}

// -- Training config loader --------------------------------------------

async function loadTrainingConfig(configPath, logger) {
  const resolved = path.resolve(configPath);
  try {
    const raw = await fsp.readFile(resolved, 'utf8');
    const cfg = JSON.parse(raw);
    // Strip _comment keys (documentation, not data)
    const stripped = stripCommentsDeep(cfg);
    if (!stripped.app_name) {
      throw new Error('modal-training.json missing required field: app_name');
    }
    return stripped;
  } catch (e) {
    if (e.code === 'ENOENT') {
      logger.warn(`config/modal-training.json not found at ${resolved}; using empty defaults`);
      return { app_name: 'aware-trainer', dpo_defaults: {}, checkpoint: {} };
    }
    throw e;
  }
}

function stripCommentsDeep(obj) {
  if (Array.isArray(obj)) return obj.map(stripCommentsDeep);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_comment')) continue;
      out[k] = stripCommentsDeep(v);
    }
    return out;
  }
  return obj;
}

// -- Entrypoint (called when run as a service) ------------------------

// Detect "running as main" without a build step: in ESM,
// import.meta.url === pathToFileURL(process.argv[1]).href when this
// file is the entrypoint.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  // Production entrypoint: wire the real Modal client. The poller
  // already checks the kill switch + token presence; this just gives
  // it a real `submit` to call. We import lazily so unit tests that
  // construct TrainerPoller directly don't have to install the modal
  // SDK on their classpath.
  let modalClient = null;
  try {
    const { makeModalClient } = await import('./modal-client.js');
    modalClient = makeModalClient();
  } catch (e) {
    // The import is best-effort. If modal isn't installed (dev laptop
    // without the SDK), we still want the trainer to boot so the
    // operator gets a clear "no Modal client" error in logs.
    console.warn('[aware-trainer] could not load modal-client.js:', e?.message || e);
  }
  const poller = new TrainerPoller({ modalClient });
  poller.start().catch((e) => {
    console.error('[aware-trainer] FATAL:', e);
    process.exit(1);
  });
  process.on('SIGTERM', async () => {
    await poller.stop();
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    await poller.stop();
    process.exit(0);
  });
}

// -- Helpers -------------------------------------------------------------

/**
 * SHA-256 of a problem string (used to populate
 * aware_azr_results.problem_hash for the future
 * embedding-similarity join path). Returns the hex digest.
 *
 * @param {string} problem
 * @returns {Promise<string>}
 */
async function _sha256OfProblem(problem) {
  // node:crypto is available in Node 18+. The trainer is Node 22+
  // (CLAUDE.md). Synchronous hash is fine — problems are <10KB.
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(String(problem).trim().toLowerCase().replace(/\s+/g, ' '), 'utf8')
    .digest('hex');
}
