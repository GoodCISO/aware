-- Backfill prm_model labels in the PRM cache.
--
-- 2026-11-10 (scribe): all 515,320 rows read 'primary-model' because the
-- coordinator never passed a model name and rl-pipeline's cache key read
-- `client?.model` from a router object that had no `model` property.
-- The source is now fixed (src/coordinator/model-router.js exposes `model`,
-- src/coordinator/index.js passes config.model.providerModel), so newly
-- written rows carry the real model name.
--
-- This backfill relabels the existing rows so the table is internally
-- consistent and a query by model returns the right population.
--
-- It does NOT recompute content_hash. The hash is computed over a
-- canonicalisation that includes prm_model, so changing prm_model without
-- recomputing the hash would make the stored hash disagree with
-- buildCacheKey() for the same inputs. The rows were written with
-- prm_model='primary-model' in the hash, so the correct, safe action is:
--
--   - relabel the column for reporting/attribution purposes, and
--   - leave the hash alone (it is the lookup key).
--
-- Rows written AFTER the fix carry the true model in both the column and
-- the hash. The backfill therefore distinguishes them by collected_at:
-- rows older than the fix are relabelled; rows newer are left alone.
--
-- Run against the aware2 database.

BEGIN;

-- Report before.
SELECT prm_model, count(*) AS rows, min(last_hit_at)::date AS first_seen,
       max(last_hit_at)::date AS last_seen
  FROM aware_prm_cache
 GROUP BY prm_model
 ORDER BY rows DESC;

-- Relabel the legacy 'primary-model' population to the deployed model.
UPDATE aware_prm_cache
   SET prm_model = 'MiniMax-M3.1-Flash'
 WHERE prm_model = 'primary-model';

-- Report after.
SELECT prm_model, count(*) AS rows
  FROM aware_prm_cache
 GROUP BY prm_model
 ORDER BY rows DESC;

COMMIT;
