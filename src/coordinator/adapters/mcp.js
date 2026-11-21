// SPDX-License-Identifier: Apache-2.0
// src/coordinator/adapters/mcp.js
//
// MCP (Model Context Protocol) JSON-RPC adapter — ADR-051.
//
// Per ADR-051 §1.4: AWARE does not own the MCP server or client runtime;
// it sits in front of it the same way it sits in front of any other tool.
// The threat-model gap is not a coverage hole in an existing module —
// it is the absence of the protocol parser. This file IS the parser.
//
// Surface (per the card body for t_cc0b54c2):
//   - Recognises 7 MCP JSON-RPC message types:
//       initialize, tools/list, tools/call, resources/read, prompts/get,
//       notifications/*, completion/*
//   - Recognises 4 JSON-RPC 2.0 envelope shapes:
//       request, notification, response, error
//   - Recognises batched envelopes (array of envelopes).
//   - Truncates / hashes large params + result payloads (4 KB cap;
//     SHA-256 of canonical JSON, store {hash, length}, never the
//     full payload when length > 4096 bytes). The `parametersHash`
//     convention is the ast10-mapper.js precedent.
//   - Fail-open per ADR-040: parse errors log to stderr + emit a
//     `mcp_message_parse_error` source event; the adapter NEVER throws
//     out of parse() or emitMessage(). The originating MCP traffic
//     flows through regardless of audit-side failures.
//
// Out of scope (per card body, by design):
//   - No network transport (parser only).
//   - No MCP0N:2025 annotation emission (classifier card's job).
//   - No framework-mapper registration (catalog card's job).
//   - No modification to decision-logger.js or tool-observation-proxy.js;
//     we reuse the existing write path.

'use strict';

const crypto = require('crypto');

// ----------------------------------------------------------------------------
// Constants — pinned by ADR-051.
// ----------------------------------------------------------------------------

/**
 * Oversize threshold for params + result payloads.
 * Above this size we store {hash, length} instead of the full payload.
 * Matches the precedent in ast10-mapper.js (`parametersHash` JSDoc).
 */
const OVERSIZE_BYTES = 4 * 1024;

/**
 * The 7 MCP message types recognised by this adapter, plus the
 * `notifications/*` and `completion/*` namespaces which match any
 * method whose first path segment is `notifications` or `completion`.
 *
 * The shape mirrors the JSON-RPC 2.0 method taxonomy used by the
 * MCP wire spec (https://modelcontextprotocol.io); the exact set
 * here is the operational surface AWARE cares about per ADR-051
 * §1.4 — every MCP-derived call that could carry an attack class
 * (MCP03 schema/description, MCP06 context-as-instruction, MCP10
 * over-sharing) is enumerated so the downstream classifier can fire.
 */
const KNOWN_METHODS = new Set([
  'initialize',
  'tools/list',
  'tools/call',
  'resources/read',
  'resources/list',
  'resources/subscribe',
  'prompts/get',
  'prompts/list',
  'logging/setLevel',
  'ping',
]);

const NAMESPACE_PREFIXES = ['notifications', 'completion'];

/**
 * JSON-RPC 2.0 envelope shapes this adapter recognises.
 * (https://www.jsonrpc.org/specification)
 *   - request:     has `method`, has `id` (string|number|null), no `result`/`error`
 *   - notification: has `method`, NO `id`, no `result`/`error`
 *   - response:    has `result` (or both `result` + `id`), no `method`
 *   - error:       has `error` (object), no `method`
 *
 * Note: the `id` may be `null` for response shapes (per JSON-RPC 2.0 §4.1
 * "This member SHOULD NOT exist in the case of a Notification") — the
 * adapter treats `id === undefined` (missing) as the notification signal.
 */
const SHAPE_REQUEST = 'request';
const SHAPE_NOTIFICATION = 'notification';
const SHAPE_RESPONSE = 'response';
const SHAPE_ERROR = 'error';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Canonical JSON serialization for deterministic hashing. Matches the
 * shape decision-logger.js uses for `canonicalSerialize` (sorted keys
 * at one level deep) — sufficient for our `hashOf(value)` purpose, which
 * is integrity-of-evidence not chain-integrity.
 *
 * @param {*} value
 * @returns {string}
 */
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

/**
 * SHA-256 of canonicalised JSON, hex digest.
 *
 * @param {*} value
 * @returns {string}
 */
function hashOf(value) {
  const canonical = canonicalJSON(value);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Size-on-the-wire of a payload, measured against canonical JSON.
 * We canonicalise first so the byte count is reproducible across
 * key-ordering variants (decision-logger.js's chain integrity
 * convention).
 *
 * @param {*} value
 * @returns {number}
 */
function sizeOf(value) {
  return Buffer.byteLength(canonicalJSON(value), 'utf8');
}

/**
 * Truncate-or-hash. If the canonicalised payload exceeds the budget,
 * return `{ hash, length, truncated: true }`; otherwise return
 * `{ value, truncated: false }`. The shape is stable so the
 * downstream classifier can detect truncation by the `truncated` flag.
 *
 * @param {*} value
 * @param {number} budget  byte budget (default OVERSIZE_BYTES)
 * @returns {{hash?: string, length: number, truncated: boolean, value?: *}}
 */
function truncateOrHash(value, budget = OVERSIZE_BYTES) {
  const length = sizeOf(value);
  if (length <= budget) {
    return { value, length, truncated: false };
  }
  return {
    hash: hashOf(value),
    length,
    truncated: true,
  };
}

/**
 * Classify the JSON-RPC 2.0 envelope shape.
 * Returns one of SHAPE_REQUEST | SHAPE_NOTIFICATION | SHAPE_RESPONSE | SHAPE_ERROR.
 * Returns `null` if the envelope is malformed.
 *
 * @param {*} env
 * @returns {string|null}
 */
function classifyShape(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  if (typeof env.jsonrpc !== 'string') return null; // JSON-RPC 2.0 mandates "jsonrpc":"2.0"

  const hasMethod = typeof env.method === 'string';
  const hasResult = 'result' in env;
  const hasError = env.error && typeof env.error === 'object';
  const hasId = 'id' in env; // explicit presence check — `id: null` is valid

  if (hasMethod && !hasResult && !hasError) {
    // Distinguish request vs notification by presence of `id`.
    return hasId ? SHAPE_REQUEST : SHAPE_NOTIFICATION;
  }
  if (!hasMethod && (hasResult || hasError)) {
    return hasError ? SHAPE_ERROR : SHAPE_RESPONSE;
  }
  return null;
}

/**
 * Identify the MCP message type from the method string.
 * Returns one of: the literal method name, `notifications/<sub>` for
 * the notifications namespace, `completion/<sub>` for the completion
 * namespace, or `unknown` for anything else.
 *
 * @param {string} method
 * @returns {string}
 */
function classifyMethod(method) {
  if (typeof method !== 'string' || method.length === 0) return 'unknown';
  if (KNOWN_METHODS.has(method)) return method;
  const prefix = method.split('/', 1)[0];
  if (NAMESPACE_PREFIXES.includes(prefix)) return method; // preserve full method
  return 'unknown';
}

/**
 * Pull the JSON-RPC id (string | number | null) from an envelope.
 * Returns `undefined` when the field is absent (i.e. notification).
 *
 * @param {Object} env
 * @returns {string|number|null|undefined}
 */
function messageIdOf(env) {
  if (!('id' in env)) return undefined;
  const id = env.id;
  if (id === null) return null;
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null; // per JSON-RPC 2.0, id MUST be string|number|null
}

/**
 * Build a parsed-envelope record. Stable shape across all 4 envelope
 * types so the downstream classifier can index on `messageType`,
 * `method`, `params`/`result`/`error` uniformly.
 *
 * @param {string} shape
 * @param {Object} env
 * @returns {{
 *   messageType: string,
 *   messageId: string|number|null|undefined,
 *   method: string|null,
 *   params: *,
 *   result: *,
 *   error: *,
 *   metadata: Object
 * }}
 */
function buildParseResult(shape, env) {
  const method = typeof env.method === 'string' ? env.method : null;
  const messageType = method ? classifyMethod(method) : shape; // response/error: shape IS the type

  const paramsRaw = 'params' in env ? env.params : undefined;
  const resultRaw = 'result' in env ? env.result : undefined;
  const errorRaw = 'error' in env ? env.error : undefined;

  return {
    messageType,
    messageId: messageIdOf(env),
    method,
    params: paramsRaw === undefined ? null : truncateOrHash(paramsRaw),
    result: resultRaw === undefined ? null : truncateOrHash(resultRaw),
    error: errorRaw || null,
    metadata: {
      shape,
      jsonrpc: env.jsonrpc || null,
      truncated: false,
    },
  };
}

// ----------------------------------------------------------------------------
// MCPAdapter
// ----------------------------------------------------------------------------

/**
 * MCP JSON-RPC adapter. Pure parser + audit emitter; no network I/O.
 *
 * @class MCPAdapter
 */
class MCPAdapter {
  /**
   * @param {Object} [opts]
   * @param {Object} [opts.auditLogger] - override for decision-logger.
   *        Defaults to `require('../../audit/decision-logger')` via
   *        lazy require. Tests inject a fake.
   * @param {string} [opts.parentDecisionId=null] - chain the emitted
   *        source events under this parent (e.g. an upstream
   *        `tool_dispatch` decision). `null` = root of sub-chain.
   * @param {string} [opts.policyId='mcp-adapter-v1']
   * @param {string} [opts.policyVersion='1']
   */
  constructor(opts = {}) {
    this.auditLogger = opts.auditLogger || null; // lazy-defaulted in emitMessage
    this.parentDecisionId = opts.parentDecisionId || null;
    this.policyId = opts.policyId || 'mcp-adapter-v1';
    this.policyVersion = opts.policyVersion || '1';
    this.oversizeBytes = OVERSIZE_BYTES;
    // AC4 (t_0cb12b17): the OWASP MCP Top 10 classifier is wired into the
    // emit path. Lazy-constructed on first use so a missing/busted
    // classifier module cannot prevent the adapter from being constructed
    // (same posture as the audit logger).
    this._classifier = null;
    this._classifierLoadFailed = false;
    // Escape hatch for tests that must observe the source event WITHOUT
    // annotations being written.
    this.enableClassifierWrites = opts.enableClassifierWrites !== false;
  }

  /**
   * Lazy default for the audit logger. Mirrors the pattern from
   * ast10-mapper.js — only require the module when a caller actually
   * goes through the production emit path, so a busted decision-logger
   * (missing file, missing dep) doesn't prevent construction.
   *
   * @returns {Object|null}
   */
  _resolveAuditLogger() {
    if (this.auditLogger) return this.auditLogger;
    try {
      // eslint-disable-next-line global-require
      this.auditLogger = require('../../audit/decision-logger');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[mcp-adapter] failed to load audit logger: ${err.code || err.message}`);
      this.auditLogger = null;
    }
    return this.auditLogger;
  }

  /**
   * Parse a single JSON-RPC envelope OR a batched array of envelopes.
   * Pure function: no side effects, no I/O, no audit emission.
   * Returns `null` if the input is malformed at the envelope level
   * (per ADR-040: parse errors do NOT throw).
   *
   * Output shape:
   *   - Single envelope → { shape, parsed, batch: false, errors: [] }
   *   - Batched → { shape: 'batch', parsed: [parsed...], batch: true, errors: [<badIndex>...] }
   *   - Malformed → { shape: null, parsed: null, batch: false, errors: [<reason>] }
   *
   * @param {*} envelope
   * @returns {{shape: (string|null), parsed: (*|null), batch: boolean, errors: string[]}}
   */
  parse(envelope) {
    // Batched envelope (JSON-RPC 2.0 §6).
    if (Array.isArray(envelope)) {
      if (envelope.length === 0) {
        return { shape: 'batch', parsed: [], batch: true, errors: ['empty batch'] };
      }
      const parsed = [];
      const errors = [];
      for (let i = 0; i < envelope.length; i++) {
        const single = this.parse(envelope[i]);
        if (single.shape === null) {
          errors.push(String(i));
          parsed.push(null);
        } else {
          parsed.push(single.parsed);
        }
      }
      return { shape: 'batch', parsed, batch: true, errors };
    }

    // Single envelope.
    if (!envelope || typeof envelope !== 'object') {
      return { shape: null, parsed: null, batch: false, errors: ['not an object'] };
    }

    const shape = classifyShape(envelope);
    if (shape === null) {
      return { shape: null, parsed: null, batch: false, errors: ['unrecognised JSON-RPC envelope shape'] };
    }

    try {
      const parsed = buildParseResult(shape, envelope);
      // Mark truncated iff any payload field was truncated.
      if ((parsed.params && parsed.params.truncated) || (parsed.result && parsed.result.truncated)) {
        parsed.metadata.truncated = true;
      }
      return { shape, parsed, batch: false, errors: [] };
    } catch (err) {
      // buildParseResult is total but guard anyway — never throw out.
      return { shape: null, parsed: null, batch: false, errors: [err.message] };
    }
  }

  /**
   * Build a DecisionRecord-shaped object for an `mcp_message` source
   * event. Pure function; emits NOTHING to the audit chain — that is
   * emitMessage()'s job. Exposed so tests can inspect the wire shape
   * without coupling to the audit logger.
   *
   * Required fields per decision-logger.js DecisionRecord typedef.
   *
   * @param {Object} envelope  original raw envelope (for error case metadata)
   * @param {Object} parsed    result from this.parse(envelope).parsed (or null)
   * @param {Object} actor      { agentId, trustScore?, role? }
   * @param {string} [kind='mcp_message']
   * @returns {Object}
   */
  buildDecisionRecord(envelope, parsed, actor, kind = 'mcp_message') {
    const safeActor = actor && typeof actor === 'object'
      ? actor
      : { agentId: 'unknown' };

    const action = {
      type: kind,
      target: parsed && parsed.method ? `mcp://${parsed.method}` : 'mcp://unknown',
      reason: parsed ? `JSON-RPC ${parsed.metadata.shape} ${parsed.messageType}` : 'parse_error',
      parameters: parsed ? {
        messageType: parsed.messageType,
        shape: parsed.metadata.shape,
        method: parsed.method,
        messageId: parsed.messageId,
        params: parsed.params,        // already {value|hash, length, truncated}
        result: parsed.result,
        error: parsed.error,
        truncated: parsed.metadata.truncated,
      } : {
        rawShape: envelope && typeof envelope === 'object'
          ? (Array.isArray(envelope) ? 'batch' : 'object')
          : typeof envelope,
      },
    };

    return {
      decisionId: 'mcp-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
      parentDecisionId: this.parentDecisionId,
      timestamp: new Date().toISOString(),
      actor: {
        agentId: safeActor.agentId,
        trustScore: typeof safeActor.trustScore === 'number' ? safeActor.trustScore : 1.0,
        ...(safeActor.role ? { role: safeActor.role } : {}),
      },
      action,
      context: {
        pheromoneScores: {},
        heuristicWeights: {},
        policyId: this.policyId,
        policyVersion: this.policyVersion,
      },
      outcome: {
        success: !!parsed,
        latencyMs: 0,
        errorMessage: parsed ? null : 'mcp_message_parse_error',
      },
    };
  }

  /**
   * Run the OWASP MCP Top 10 classifier over an emitted decision record.
   *
   * AC4 of t_0cb12b17: every `mcp_message` source event must feed through
   * `classifyAndLog` so the MCP01..MCP10 annotations actually reach the
   * audit chain. Without this the classifier was dead code — the module
   * existed and was fully tested, but nothing ever called it.
   *
   * Fail-open, like every other path in this adapter: the classifier MUST
   * never be able to fail an `mcp_message` emit. A busted classifier
   * (missing module, a rule that throws) degrades to "no annotations",
   * never to a thrown error.
   *
   * @param {Object} record - the DecisionRecord just built for the event.
   * @returns {Promise<Object[]>} the annotations written (empty on any
   *   failure). Never throws.
   */
  async _classifyAndAnnotate(record) {
    let classifier = this._classifier;
    if (!classifier) {
      try {
        // eslint-disable-next-line global-require
        const mod = require('../../compliance/mcp-top10-classifier');
        classifier = mod.createMCP10Classifier({
          auditLogger: this.auditLogger,
          enableWrites: this.enableClassifierWrites,
        });
        this._classifier = classifier;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[mcp-adapter] failed to load MCP10 classifier: ${err.code || err.message}`);
        this._classifier = null;
        this._classifierLoadFailed = true;
        return [];
      }
    }

    try {
      // eslint-disable-next-line global-require
      const mod = require('../../compliance/mcp-top10-classifier');
      return await mod.classifyAndLog(classifier, record);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[mcp-adapter] MCP10 classification failed: ${err.code || err.message}`);
      return [];
    }
  }

  /**
   * Parse + emit. Fail-open per ADR-040:
   *   - parse error → log to stderr + emit `mcp_message_parse_error` source event
   *   - emit error  → log to stderr, swallow (NEVER throw)
   *
   * Returns `{ record, ok }` where `record` is the DecisionRecord that
   * was passed to logDecision (or would have been) and `ok` indicates
   * whether the audit chain accepted the write.
   *
   * @param {*} envelope
   * @param {Object} actor
   * @returns {Promise<{record: Object, ok: boolean, error?: Error}>}
   */
  async emitMessage(envelope, actor) {
    const parsed = this.parse(envelope);
    const kind = parsed.shape === null ? 'mcp_message_parse_error' : 'mcp_message';
    const record = this.buildDecisionRecord(envelope, parsed.parsed, actor, kind);

    const logger = this._resolveAuditLogger();
    if (!logger || typeof logger.logDecision !== 'function') {
      // eslint-disable-next-line no-console
      console.error(`[mcp-adapter] audit logger unavailable; dropping ${kind} event`);
      return { record, ok: false, error: new Error('audit logger unavailable') };
    }

    try {
      await logger.logDecision(record);
      // AC4: every emitted mcp_message feeds the MCP Top 10 classifier so
      // its annotations reach the audit chain. Runs AFTER the source event
      // is written (the annotations chain under the source decision id),
      // and is fail-open — a classifier failure never fails the emit.
      if (kind === 'mcp_message') {
        await this._classifyAndAnnotate(record);
      }
      return { record, ok: true };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[mcp-adapter] logDecision failed for ${kind}: ${err.code || err.message}`);
      return { record, ok: false, error: err };
    }
  }
}

// ----------------------------------------------------------------------------
// Module exports
// ----------------------------------------------------------------------------

module.exports = {
  MCPAdapter,
  // Exported for tests / future classifier card:
  classifyShape,
  classifyMethod,
  truncateOrHash,
  hashOf,
  sizeOf,
  canonicalJSON,
  KNOWN_METHODS,
  NAMESPACE_PREFIXES,
  OVERSIZE_BYTES,
};