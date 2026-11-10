// src/coordinator/model-router.js — 3-tier model fallback for AWARE 2.0
// Per ADR (internal) Decision 3: primary LLM provider API as primary, Ollama as offline fallback.
//
// Tiers (resolved by MODE env var):
//   online  → primary LLM provider API only
//   hybrid  → primary LLM provider first, Ollama on primary failure
//   offline → Ollama only
//
// Design notes:
//   - The router is a *router*, not a client. It takes a list of clients
//     (already constructed by the caller) and decides which one to invoke.
//   - Failure detection is by the client's generate() throwing. The router
//     does NOT introspect error types — that's the client's job to throw
//     meaningful errors.
//   - The router does NOT swallow errors. If the last tier fails, the
//     error propagates to the caller. The caller decides whether to retry
//     or surface to the user.
//   - Health probes are async and cached for a configurable TTL, so a
//     degraded backend doesn't get hammered on every request.
//
// What this module does NOT do (out of scope for Phase 1 router):
//   - Token accounting / budget tracking (lives in process-RL pipeline budget watchdog)
//   - PRM scoring (lives in rl-pipeline's prm.js)
//   - Heavy reasoning orchestration (lives in rl-pipeline's index.js)

import { request as httpRequest } from 'node:http';

/**
 * Build a model router.
 *
 * @param {Object} options
 * @param {Array<{name: string, generate: Function, healthy?: () => Promise<boolean>}>} options.clients
 *        Ordered list of backends. The router tries them in order until one succeeds.
 *        Each client must implement generate(prompt, opts) → Promise<{reasoning, cost_usd, ...}>.
 *        `healthy()` is optional — if provided, the router probes it before invoking.
 * @param {string} [options.mode='hybrid'] — 'online' | 'hybrid' | 'offline'
 * @param {string} [options.model=null] — provider model name, surfaced on the
 *        returned object so downstream consumers (rl-pipeline's PRM cache key)
 *        can label what actually served the request.
 * @param {number} [options.healthTtlMs=30_000] — how long to cache health results
 * @param {number} [options.healthTimeoutMs=2_000] — per-probe timeout
 * @returns {{
 *   generate: (prompt, opts) => Promise<Object>,
 *   health: () => Promise<Object>,
 *   whichClient: () => string|null,
 * }}
 */
export function makeModelRouter({ clients, mode = 'hybrid', model = null, healthTtlMs = 30_000, healthTimeoutMs = 2_000 } = {}) {
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error('makeModelRouter: clients must be a non-empty array');
  }
  if (!['online', 'hybrid', 'offline'].includes(mode)) {
    throw new Error(`makeModelRouter: mode must be one of online|hybrid|offline, got '${mode}'`);
  }

  // Validate clients
  for (const c of clients) {
    if (!c || typeof c.name !== 'string' || typeof c.generate !== 'function') {
      throw new Error(`makeModelRouter: client must have {name: string, generate: function}, got ${JSON.stringify(c)}`);
    }
  }

  // Mode determines which clients are in the active set.
  // - 'online'  → only the API client (skip Ollama)
  // - 'offline' → only Ollama (skip the API client)
  // - 'hybrid'  → both, in the order provided by the caller (typically API first)
  //
  // We assume the caller orders clients with the primary first. The router
  // tries them in order until one succeeds.
  const orderedClients = clients.filter(c => {
    if (mode === 'online') {
      // Skip Ollama-style backends when the user demands online-only.
      // Heuristic: clients with a 'healthy' function that probes a localhost
      // address are Ollama. Clients without one (or with a remote probe)
      // are online APIs. We also support an explicit `offline: true` flag
      // to opt a client into the offline-only bucket.
      if (c.offline === true) return false;
    } else if (mode === 'offline') {
      // Skip online clients when the user demands offline-only.
      if (c.offline !== true) return false;
    }
    // hybrid: all clients are eligible
    return true;
  });

  if (orderedClients.length === 0) {
    throw new Error(
      `makeModelRouter: mode='${mode}' excludes all configured clients. ` +
      `Mark offline clients with {offline: true} so the router can route.`
    );
  }

  // Health cache: { [clientName]: { ok: boolean, at: epochMs } }
  const healthCache = new Map();

  async function probeHealthy(client) {
    if (typeof client.healthy !== 'function') {
      // No health probe available; assume healthy (caller's responsibility to
      // make a generate() call that fails fast if the backend is down).
      return true;
    }
    const cached = healthCache.get(client.name);
    const now = Date.now();
    if (cached && (now - cached.at) < healthTtlMs) {
      return cached.ok;
    }
    let ok = false;
    try {
      const result = await Promise.race([
        client.healthy(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('health probe timeout')), healthTimeoutMs)),
      ]);
      ok = result === true;
    } catch {
      ok = false;
    }
    healthCache.set(client.name, { ok, at: now });
    return ok;
  }

  let lastClient = null;

  async function generate(prompt, opts = {}) {
    const errors = [];
    for (const client of orderedClients) {
      // Probe health (cached) — skip if we know it's down
      const healthy = await probeHealthy(client);
      if (!healthy) {
        errors.push({ client: client.name, error: 'health probe failed' });
        continue;
      }
      try {
        const result = await client.generate(prompt, opts);
        lastClient = client.name;
        // Invalidate health cache on success so we re-probe after TTL
        // (a successful generate is a stronger signal than a cached probe)
        if (result && typeof result === 'object') {
          healthCache.set(client.name, { ok: true, at: Date.now() });
        }
        return { ...result, _routed_via: client.name };
      } catch (err) {
        errors.push({ client: client.name, error: err.message || String(err) });
        // Mark unhealthy in cache so we don't immediately retry it
        healthCache.set(client.name, { ok: false, at: Date.now() });
        // Continue to next client
      }
    }
    // All clients failed
    const modeDesc = mode;
    const err = new Error(
      `ModelRouter(${modeDesc}): all ${orderedClients.length} backends failed. ` +
      `Errors: ${JSON.stringify(errors)}`
    );
    err.routerErrors = errors;
    throw err;
  }

  async function health() {
    const now = Date.now();
    const results = {};
    for (const client of clients) {
      const cached = healthCache.get(client.name);
      if (cached && (now - cached.at) < healthTtlMs) {
        results[client.name] = { ok: cached.ok, cached: true, at: cached.at };
      } else {
        const ok = await probeHealthy(client);
        results[client.name] = { ok, cached: false, at: now };
      }
    }
    const allOk = Object.values(results).every(r => r.ok);
    return {
      mode,
      ok: allOk,
      at: now,
      clients: results,
    };
  }

  function whichClient() {
    return lastClient;
  }

  return { generate, health, whichClient, model: model || null };
}

/**
 * Build a health probe for an Ollama instance.
 * Ollama exposes GET /api/tags which returns the list of locally available models.
 * A 200 response with any body means the daemon is up.
 */
export function makeOllamaHealth({ baseUrl = 'http://127.0.0.1:11434', timeoutMs = 2_000 } = {}) {
  return async function healthy() {
    const url = new URL(baseUrl);
    return new Promise((resolve) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port || 80,
          path: '/api/tags',
          method: 'GET',
          timeout: timeoutMs,
        },
        (res) => {
          // Drain the response so the socket can close
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  };
}
