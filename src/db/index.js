// src/db/index.js — Postgres client wrapper for AWARE 2.0
//
// Phase 2.1: lazy connection, reconnect on failure, run-migrations-on-startup.
// Used by src/db/logger.js for the conversations table.
//
// Resilience contract:
//   - getPool() returns null if DB is disabled (AWARE_DB_ENABLED=false)
//   - getPool() returns null if first connection attempt fails (logs to stderr)
//   - Subsequent getPool() calls retry the connection on a backoff
//   - The request path never throws because of this module — all errors
//     are caught and reported via the `dbStatus` object
//
// Out of scope:
//   - Connection pooling tuning (pg.Pool defaults are fine for a single
//     coordinator instance)
//   - Read replicas, sharding, or any horizontal-scale concern
//   - Query builder — callers write SQL directly
//
// Public API:
//   import { getPool, runMigrations, dbStatus, closePool } from './db/index.js';

import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// config is a CJS module that does `module.exports = config`; in ESM
// we get it as the default import. Node's CJS-to-ESM interop handles this.
import config from '../config/index.cjs';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

// State held in module scope (singleton per process).
let pool = null;
let migrationsRun = false;
let lastError = null;
let lastConnectAttempt = 0;
const RETRY_BACKOFF_MS = 5_000;

const dbStatus = {
  enabled: () => config.db.enabled,
  connected: () => pool !== null,
  migrationsRun: () => migrationsRun,
  lastError: () => lastError,
  // Reset for tests
  _reset() {
    if (pool && typeof pool.end === 'function') {
      pool.end().catch(() => {});
    }
    pool = null;
    migrationsRun = false;
    lastError = null;
    lastConnectAttempt = 0;
  },
};

/**
 * Test-only: install a stub pool that bypasses the real connection.
 * The stub must implement .query(sql, params) returning a thenable or
 * throwing on demand. Production code paths never call this.
 *
 * Always pair with a `dbStatus._reset()` in the test teardown to clear
 * the stub before the next test.
 *
 * Note: this does NOT mark `migrationsRun = true`. Tests that exercise
 * `runMigrations()` need to do that work themselves, because the
 * test's stub pool is the one that gets the migration SQL.
 *
 * @param {{query: (sql: string, params: unknown[]) => Promise<unknown>}} fakePool
 */
export function _setPoolForTest(fakePool) {
  // Assign directly to the module-level `pool` slot so that
  // getPool()'s `if (pool) return pool;` short-circuit returns the
  // stub on the first call without ever opening a real socket.
  pool = fakePool;
  // Reset migrationsRun so a test that wants to exercise runMigrations
  // can do so from a clean slate. Tests that DON'T care about
  // migrations can call runMigrations() and ignore the result.
  migrationsRun = false;
  lastError = null;
  lastConnectAttempt = 0;
}

/**
 * Build the pg config object from the AWARE config module.
 * Returns null if the DB is disabled.
 */
function buildPgConfig() {
  if (!config.db.enabled) {
    return null;
  }
  return {
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password, // may be undefined; pg will use env var fallback
    connectionTimeoutMillis: config.db.connectionTimeoutMs,
    // Keep the pool tiny — coordinator writes are sequential and infrequent
    max: 4,
    idleTimeoutMillis: 30_000,
  };
}

/**
 * Get the connection pool. Lazy — first call establishes it.
 * Returns null if disabled or if the connection attempt fails.
 */
export async function getPool() {
  if (pool) return pool;

  const pgConfig = buildPgConfig();
  if (!pgConfig) {
    return null;
  }

  // Backoff: don't hammer a dead DB
  if (Date.now() - lastConnectAttempt < RETRY_BACKOFF_MS && lastError) {
    return null;
  }
  lastConnectAttempt = Date.now();

  try {
    pool = new Pool(pgConfig);
    // Sanity probe — fail fast if the host/port are wrong
    const client = await pool.connect();
    client.release();
    lastError = null;
    return pool;
  } catch (err) {
    lastError = err;
    // eslint-disable-next-line no-console
    console.error(
      `[aware-db] failed to connect to ${pgConfig.host}:${pgConfig.port}/${pgConfig.database}:`,
      err.message
    );
    if (pool) {
      pool.end().catch(() => {});
    }
    pool = null;
    return null;
  }
}

/**
 * Run all SQL files in db/migrations/ in lexicographic order.
 * Idempotent — uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
 * Safe to call multiple times.
 */
export async function runMigrations() {
  if (migrationsRun) return { ran: false, reason: 'already-run' };

  const p = await getPool();
  if (!p) {
    return { ran: false, reason: 'no-pool' };
  }

  const migrationsDir = join(__dirname, '..', '..', 'db', 'migrations');
  let files;
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    lastError = err;
    // eslint-disable-next-line no-console
    console.error(`[aware-db] cannot read migrations dir ${migrationsDir}:`, err.message);
    return { ran: false, reason: 'no-migrations-dir' };
  }

  if (files.length === 0) {
    migrationsRun = true;
    return { ran: true, count: 0 };
  }

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    try {
      await p.query(sql);
      // eslint-disable-next-line no-console
      console.log(`[aware-db] migration applied: ${file}`);
    } catch (err) {
      lastError = err;
      // eslint-disable-next-line no-console
      console.error(`[aware-db] migration ${file} failed:`, err.message);
      return { ran: false, reason: 'migration-failed', file, error: err.message };
    }
  }
  migrationsRun = true;
  return { ran: true, count: files.length };
}

/**
 * Close the pool. For shutdown / tests.
 */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  migrationsRun = false;
}

export { dbStatus };

// Re-export tier-promotion audit log helpers so callers can import them
// from the db barrel: `import { recordTierPromotion } from '../db/index.js'`.
// The tier-promotion module is the persistence-side half of the AWARE v2
// /v2/tier-promotions contract (parents: t_58ba2031).
export { recordTierPromotion, buildIdempotencyKey, isValidCapability } from './tier-promotions.js';

// Re-export the mandate-acceptance writer so callers can import it from the
// db barrel: `import { recordMandate } from '../db/index.js'`.
// The mandate module is the persistence-side half of the AWARE v2
// /v2/mandates contract (card t_ae57240e).
export {
  recordMandate,
  findMandateByTriggeringEventId,
  resolveAgentConstraintTier,
  buildGrantId,
  rowToMandate,
} from './mandates.js';
