// src/clients/minimax.js — minimax client for heavy_think
// Reads LLM_API_KEY from env at call time (not at module load).
// Refuses to start without a key. Provides the { generate(prompt, opts) }
// interface heavy_think expects.
//
// Endpoints (from ${OPENCLAW_CONFIG}/openclaw.json):
//   baseUrl: https://api.minimax.io/anthropic  (Anthropic-compatible)
//   model:   MiniMax-M3  (1M context, 131072 max output, xhigh thinking)
//
// This module is hermetic — no env read at import time, no key extraction,
// no network call until generate() is invoked. Tests pass a stub client.

const DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic';
const DEFAULT_MODEL = 'MiniMax-M3';
const DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_VERSION = '2023-06-01';

// PRM judges must be deterministic for ranking to be reproducible.
// K-parallel reasoning attempts should stay diverse (API-default temperature).
// Per ADR-038 (noise floor finding): without temperature=0, PRM scoring is
// dominated by sampling noise (|mean|/stddev < 1.0 on 2/3 tested prompts).
// Override via opts.temperature (explicit non-null value wins).
function resolveTemperature(opts) {
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'temperature')) {
    return opts.temperature;
  }
  if (opts && opts.phase === 'prm_score') {
    return 0;
  }
  return null;  // let the API decide (default = 1.0 for Anthropic-compatible)
}

export function makeMinimaxClient(options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const model = options.model || DEFAULT_MODEL;
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const apiKey = options.apiKey || process.env.LLM_API_KEY;
  const fetchImpl = options._fetch || globalThis.fetch;

  if (!apiKey) {
    throw new Error(
      'makeMinimaxClient: LLM_API_KEY is not set. ' +
      'Set it in your environment (e.g. `export LLM_API_KEY=*** ' +
      'or pass { apiKey } explicitly. ' +
      'For tests, use a mock client instead.'
    );
  }

  return {
    provider: 'minimax',
    model,
    // Wrapped generate(): the single chokepoint for upstream retry.
    // The unwrapped body lives in generateOnce() so retry logic stays
    // out of the request-shaping code path.
    async generate(prompt, opts = {}) {
      return withRateLimitRetry(
        () => generateOnce(prompt, opts, {
          baseUrl, model, maxTokens, apiKey, fetchImpl,
        }),
        opts.retryOpts,
      );
    },
  };
}

// One non-retrying upstream call. Throws on HTTP 429 with a structured
// { code: 'upstream_rate_limited', statusCode: 429, retryAfterMs } error.
// 5xx and other 4xx return a plain Error (no `code`) so callers that
// pre-date the retry layer still classify them as `upstream_error`.
async function generateOnce(prompt, opts, ctx) {
  const { baseUrl, model, maxTokens, apiKey, fetchImpl } = ctx;
  const useMaxTokens = opts.max_tokens || maxTokens;
  const useModel = opts.model || model;
  const temperature = resolveTemperature(opts);

  // MR-HIGH-002 fix: accept either a string (legacy) or { system, user }
  // shape. When given { system, user }, build two-role messages so the
  // model has architectural separation between system instructions and
  // user input. This is the actual fix for the prompt-injection
  // structural ambiguity — user content cannot impersonate system.
  let messages;
  if (typeof prompt === 'string') {
    messages = [{ role: 'user', content: prompt }];
  } else if (prompt && typeof prompt === 'object') {
    if (prompt.system && prompt.user) {
      messages = [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ];
    } else if (prompt.user) {
      // system omitted → fall back to single user role
      messages = [{ role: 'user', content: prompt.user }];
    } else {
      throw new Error('minimax generate: prompt object must have either .system+.user or just .user');
    }
  } else {
    throw new Error(`minimax generate: prompt must be a string or {system,user} object, got ${typeof prompt}`);
  }

  const body = {
    model: useModel,
    max_tokens: useMaxTokens,
    messages,
  };
  if (temperature !== null) {
    body.temperature = temperature;
  }

  const res = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    // Capture Retry-After and consume body once — Retry-After is the
    // upstream's authored backoff budget; we honour it below the capMs.
    const retryAfterMs = parseRetryAfterHeader(res);
    const respBody = await res.text();
    const err = new Error(
      `minimax API 429 rate limited: ${respBody.slice(0, 500)}`
    );
    err.code = 'upstream_rate_limited';
    err.statusCode = 429;
    err.retryAfterMs = retryAfterMs;  // ms; null when header absent
    throw err;
  }

  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(
      `minimax API ${res.status} ${res.statusText}: ${respBody.slice(0, 500)}`
    );
  }

  const data = await res.json();
  const text = extractText(data);
  const cost = estimateCost(useModel, useMaxTokens, data);

  return {
    reasoning: text,
    cost_usd: cost,
    // The model this client ACTUALLY put on the wire (kanban
    // t_49d955b7). `useModel` is `opts.model || model` — the
    // per-call override wins — so this is the served model, not the
    // client's default. The pair record trusts this over the resolved
    // intent.
    served_model: useModel,
  };
}

// Parse an HTTP Retry-After header into milliseconds. Per RFC 7231 the
// header is either a non-negative integer (delta-seconds) or an HTTP-date;
// we honour the integer form and treat the date form / malformed values
// as "header absent" so the exponential fallback kicks in. Cap honoured
// values at capMs so a hostile or buggy upstream can't pin us for a minute.
function parseRetryAfterHeader(res, capMs) {
  const raw = res && res.headers && res.headers.get
    ? res.headers.get('retry-after')
    : null;
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  // Delta-seconds form: integer or float-string.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const ms = Math.ceil(Number(trimmed) * 1000);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.min(ms, capMs);
  }
  // HTTP-date form: not on the spec hot path for Anthropic-compatible APIs,
  // but if the upstream sends one we treat it as absent (smallest possible
  // surface) rather than parse a Date. Returning null lets the exponential
  // fallback take over.
  return null;
}

// Backoff helper for upstream 429s. Plain JS, no deps, no jitter.
// Schedule is baseMs * 2^attempt (1s, 2s, 4s, 8s by default) capped at
// capMs. Retry-After header beats the schedule when present and shorter;
// otherwise the schedule resumes. 5xx and other 4xx are NOT retried —
// they're thrown as plain Errors and bubble out unchanged.
async function withRateLimitRetry(fn, retryOpts) {
  const opts = {
    maxRetries: 3,
    baseMs: 1000,
    capMs: 10_000,
    ...(retryOpts || {}),
  };
  const { maxRetries, baseMs, capMs } = opts;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let retriedAttempts = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fn();
    } catch (err) {
      if (err && err.code === 'upstream_rate_limited' && attempt < maxRetries) {
        const headerMs = typeof err.retryAfterMs === 'number' ? err.retryAfterMs : null;
        const fallback = baseMs * Math.pow(2, attempt);
        const sleepMs = headerMs != null ? Math.min(headerMs, capMs) : Math.min(fallback, capMs);
        await sleep(sleepMs);
        retriedAttempts += 1;
        continue;
      }
      // Non-429 (5xx / other 4xx / bad input) → bubble out, no retry.
      // Same path when we've already burned maxRetries.
      throw err;
    }
    if (retriedAttempts > 0) {
      // Additive metadata: existing destructuring of {reasoning, cost_usd}
      // still works for old callers (parallel.js:29, refine.js:13,
      // prm.js:31/39) — __retriedAttempts is a sibling key, not a
      // replacement.
      Object.defineProperty(res, '__retriedAttempts', {
        value: retriedAttempts,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return res;
  }
  // Defensive: the loop terminates via the catch's rethrow path on the
  // last attempt; this line is only reachable on a bug.
  throw new Error('withRateLimitRetry: retry loop exited without resolving');
}

// Extract text from Anthropic-compatible response shape.
// data.content is an array of { type, text } or { type, ... } blocks.
function extractText(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content
    .filter(block => block && (block.type === 'text' || typeof block.text === 'string'))
    .map(block => block.text || '')
    .join('\n');
}

// Rough cost estimate. We don't have official minimax pricing, so this is a
// conservative upper-bound placeholder. Real PRM scoring cost will be tracked
// in the budget watchdog (Phase 2) using actual token counts from the API.
function estimateCost(model, maxTokens, response) {
  if (!response || !response.usage) return 0.001;  // conservative default
  const input = response.usage.input_tokens || 0;
  const output = response.usage.output_tokens || 0;
  // Per ADR-020: PRM calls should be cheap. If M3 costs more than ~$0.01/call
  // we have a problem — the budget watchdog will catch it.
  // Assumed rates: $1/M input, $3/M output (placeholder until real pricing known).
  return (input * 1 + output * 3) / 1_000_000;
}

export { DEFAULT_BASE_URL, DEFAULT_MODEL, ANTHROPIC_VERSION, withRateLimitRetry, parseRetryAfterHeader };
