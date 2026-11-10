// SPDX-License-Identifier: Apache-2.0
// src/compliance/mcp-top10-classifier.js
// OWASP MCP Top 10 (2025) — protocol-layer annotation classifier.
//
// 2026-11-10 (scribe): this module was referenced by three files
// (src/api/routes/compliance.js, src/compliance/framework-mapper.js,
// src/compliance/mcp-governance-catalog.js) but had never been written.
// Because src/api/routes/compliance.js required it at module scope, the
// missing file took down the ENTIRE compliance router, and with it the
// v1 APIGateway — which is why the v1 aware-backend container could not
// start, and why the compliance UI fell back to hardcoded mock scores.
//
// This is the real implementation, following the same shape as
// src/compliance/ast10-mapper.js (ADR-043): a pure `classify()` that
// returns annotations without side effects, and a `classifyAndLog()`
// that writes them onto the decision chain.
//
// The rule set maps observed MCP protocol activity onto the ten risk
// classes in src/compliance/mcp-top10-catalog.js. Rules are evidence-
// bearing: each one inspects a concrete field of the event and records
// what it saw, so an annotation can be justified or challenged by a
// reviewer without re-running the classifier.
//
// 2026-11-10 (scribe, second pass): the first release shipped 8 rules
// covering 8 of the 10 classes — MCP06, MCP07 and MCP08 had catalogue
// entries but no rule, so those three classes could never be annotated
// and the coverage claim in the CHANGELOG was overstated. Three rules
// were added (`unprovenanced-context-write`, `unpinned-plugin-install`,
// `unbound-audience-credential`) to close the gap. All ten classes are
// now reachable from a single decision record.
//
// Per ADR-051, annotations ride on the decision chain as records with
// action.type === 'mcp10_annotation' and a child `annotation` field.

'use strict';

const crypto = require('crypto');
const {
  MCP_TOP_10_CONTROLS,
  MCP_TOP_10_CONTROL_IDS,
} = require('./mcp-top10-catalog');

/**
 * @typedef {Object} MCP10Annotation
 * @property {string} rule           - the rule identifier that fired
 * @property {string[]} classes      - MCP risk-class IDs (MCP01..MCP10)
 * @property {string} confidence     - 'H' | 'M' | 'L'
 * @property {string} reference      - human-readable reference into the class doc
 * @property {Object} evidence       - what the rule observed
 * @property {string} sourceDecisionId
 * @property {string} eventType
 */

/**
 * Rule table. Each rule declares:
 *   id        - stable rule identifier
 *   classes   - MCP10 risk classes it maps to
 *   confidence- 'H' | 'M' | 'L'
 *   test      - (event, ctx) => evidence|null
 *
 * A rule fires when its `test` returns a truthy evidence object.
 */
const RULES = [
  {
    id: 'credential-in-tool-parameters',
    classes: ['MCP01'],
    confidence: 'H',
    reference: 'MCP01#token-mismanagement',
    description:
      'A credential-shaped value appears in tool parameters, which is a path ' +
      'the tool author did not intend to carry secrets.',
    test(event) {
      const params = event?.action?.parameters;
      if (!params || typeof params !== 'object') return null;
      const secretish = [];
      // 2026-11-10 (scribe): this rule only inspected the TOP LEVEL of
      // action.parameters, so a credential in a nested object — the
      // common shape, e.g. parameters.headers.authorization — was not
      // detected. The rule now walks nested objects and arrays.
      //
      // Depth is bounded to 6 and the visited-set is bounded to 200
      // entries so a cyclic or pathologically large parameter object
      // cannot hang the classifier.
      const SECRET_KEY_RE = /api[_-]?key|secret|token|password|passwd|credential|authorization|bearer|private[_-]?key/i;
      const MAX_DEPTH = 6;
      const MAX_NODES = 200;
      const seen = new Set();
      let nodes = 0;

      const walk = (value, path, depth) => {
        if (nodes >= MAX_NODES || depth > MAX_DEPTH) return;
        if (value === null || typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        nodes++;

        if (Array.isArray(value)) {
          value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
          return;
        }

        for (const [key, child] of Object.entries(value)) {
          const childPath = path ? `${path}.${key}` : key;
          if (SECRET_KEY_RE.test(key) && typeof child === 'string' && child.length >= 8) {
            secretish.push({ key: childPath, length: child.length });
            continue;
          }
          walk(child, childPath, depth + 1);
        }
      };

      walk(params, '', 0);

      if (secretish.length === 0) return null;
      return { secretishKeys: secretish.map((s) => s.key), count: secretish.length };
    },
  },
  {
    id: 'credential-in-tool-result',
    classes: ['MCP01'],
    confidence: 'H',
    reference: 'MCP01#secret-exposure',
    description:
      'A tool result echoes a credential-shaped key back to the model, ' +
      'placing a secret into the context window.',
    test(event) {
      const result = event?.action?.result;
      if (!result || typeof result !== 'object') return null;
      const text = JSON.stringify(result);
      const matches = text.match(/("?(?:api[_-]?key|secret|access[_-]?token|password|bearer)"?\s*[:=]\s*"[^"]{8,}")/gi);
      if (!matches || matches.length === 0) return null;
      return { echoedCredentialFields: matches.length };
    },
  },
  {
    id: 'shell-metacharacters-in-parameters',
    classes: ['MCP05'],
    confidence: 'H',
    reference: 'MCP05#command-injection',
    description:
      'Tool parameters carry shell metacharacters, which is the classic ' +
      'command-injection shape.',
    test(event) {
      const params = event?.action?.parameters;
      if (!params || typeof params !== 'object') return null;
      const findings = [];
      for (const [key, value] of Object.entries(params)) {
        if (typeof value !== 'string') continue;
        if (!/[;&|`$()\n]|\$\(|\|\||&&/.test(value)) continue;
        findings.push({ key });
      }
      if (findings.length === 0) return null;
      return { parameterKeys: findings.map((f) => f.key), count: findings.length };
    },
  },
  {
    id: 'untrusted-content-fetch',
    classes: ['MCP04'],
    confidence: 'M',
    reference: 'MCP04#indirect-prompt-injection',
    description:
      'The agent fetches external content, which may carry instructions ' +
      'that the model will treat as directives.',
    test(event, ctx) {
      const action = event?.action || {};
      const toolId = String(action.toolId || action.target || '').toLowerCase();
      if (!/fetch|http|url|web|browse|read_url|request/.test(toolId)) return null;
      const url = action.parameters?.url || action.parameters?.uri || action.parameters?.href;
      if (!url || typeof url !== 'string') return null;
      let hostname = null;
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = null;
      }
      // A host on the allowlist is an operator-sanctioned fetch.
      const allowlist = ctx?.allowlist;
      if (Array.isArray(allowlist) && hostname && allowlist.includes(hostname)) {
        return null;
      }
      return { url, hostname, allowlisted: false };
    },
  },
  {
    id: 'shadow-server-not-allowlisted',
    classes: ['MCP09'],
    confidence: 'H',
    reference: 'MCP09#shadow-mcp-servers',
    description:
      'A tool call targets an MCP server that is not on the operator ' +
      'allowlist.',
    test(event, ctx) {
      const action = event?.action || {};
      const server = action.serverId || action.server || action.mcpServer || action.target;
      if (!server) return null;
      const allowlist = ctx?.serverAllowlist;
      if (!Array.isArray(allowlist) || allowlist.length === 0) return null;
      if (allowlist.includes(server)) return null;
      return { server, allowlistSize: allowlist.length };
    },
  },
  {
    id: 'cross-session-context',
    classes: ['MCP10'],
    confidence: 'M',
    reference: 'MCP10#cross-session-context',
    description:
      'A session identifier other than the current one is referenced, ' +
      'which crosses a trust boundary between sessions.',
    test(event, ctx) {
      const action = event?.action || {};
      const context = event?.context || {};
      const sessionId = context.sessionId || action.sessionId;
      const other = action.otherSessionId || action.parentSessionId || action.sharedWith;
      if (!sessionId || !other) return null;
      if (sessionId === other) return null;
      return { currentSessionId: sessionId, referencedSessionId: other };
    },
  },
  {
    id: 'broad-permission-grant',
    classes: ['MCP03'],
    confidence: 'M',
    reference: 'MCP03#excessive-agency',
    description:
      'A tool is granted broader permissions than its function requires.',
    test(event) {
      const params = event?.action?.parameters || {};
      const perms = params.permissions || params.scope || params.capabilities;
      if (!Array.isArray(perms)) return null;
      const broad = perms.filter((p) => /^(read|write|exec|admin|root|\*|all|network|fs)$/i.test(String(p)));
      if (broad.length === 0) return null;
      return { broadPermissions: broad, count: broad.length };
    },
  },
  {
    id: 'tool-purpose-scope-creep',
    classes: ['MCP02'],
    confidence: 'L',
    reference: 'MCP02#tool-misuse',
    description:
      'A write-capable tool is invoked against a target outside the ' +
      'declared scope of the action.',
    test(event) {
      const action = event?.action || {};
      const toolId = String(action.toolId || '').toLowerCase();
      if (!/write|delete|remove|destroy|drop|exec|run/.test(toolId)) return null;
      const target = action.target;
      if (!target || typeof target !== 'string') return null;
      if (!/^([a-z]+:)?\/\//i.test(target)) return null;
      let hostname = null;
      try {
        hostname = new URL(target).hostname;
      } catch {
        return null;
      }
      // A write against a remote host is the scope-creep shape.
      return { toolId, target, hostname, remote: true };
    },
  },
  {
    // 2026-11-10 (scribe): MCP06 (Context Window & Memory Poisoning) had
    // a catalogue entry but no rule, so the class could never be annotated
    // from a decision record. The event-only shape that IS detectable is a
    // write into persistent working memory whose payload carries no
    // provenance — i.e. the content is adopted as a fact about the agent's
    // own context rather than as data it read. A `context_write` /
    // `memory_write` / `context_append` action whose parameters carry
    // content but no provenance/source/uri field is that shape.
    id: 'unprovenanced-context-write',
    classes: ['MCP06'],
    confidence: 'M',
    reference: 'MCP06#memory-poisoning',
    description:
      'Content is written into the agent\'s working memory without a ' +
      'provenance field, so a poisoned read can persist across the session.',
    test(event) {
      const action = event?.action || {};
      const type = String(action.type || '');
      if (!/^(context|memory)[-_](write|append|insert|update|store)$/.test(type)) {
        return null;
      }
      const params = action.parameters || {};
      const hasContent =
        typeof params.content === 'string' ||
        typeof params.text === 'string' ||
        typeof params.value === 'string' ||
        typeof params.message === 'string';
      if (!hasContent) return null;
      // A provenance field means the writer knew where the content came
      // from — that is the control working, not the failure shape.
      const PROVENANCE_KEYS = [
        'provenance',
        'source',
        'sourceUri',
        'source_uri',
        'uri',
        'url',
        'origin',
        'originId',
        'origin_id',
        'resource',
        'resourceUri',
        'retrievedFrom',
        'retrieved_from',
      ];
      const hasProvenance = PROVENANCE_KEYS.some(
        (k) => params[k] !== undefined && params[k] !== null && params[k] !== ''
      );
      if (hasProvenance) return null;
      return { actionType: type, provenanceAbsent: true };
    },
  },
  {
    // 2026-11-10 (scribe): MCP07 (Supply Chain — Servers / Plugins) had a
    // catalogue entry but no rule. The event-only detectable shape is an
    // install/fetch of an MCP server or plugin that carries no integrity
    // pin: no version digest, no hash, no publisher-key signature, and no
    // pinned version. An install action naming a package/server without
    // those fields is the supply-chain risk shape.
    id: 'unpinned-plugin-install',
    classes: ['MCP07'],
    confidence: 'M',
    reference: 'MCP07#supply-chain',
    description:
      'An MCP server or plugin is installed without a content-hash pin, ' +
      'version digest, or publisher-key verification.',
    test(event) {
      const action = event?.action || {};
      const type = String(action.type || '');
      if (!/install|add|register|enable|load/.test(type)) return null;
      // Only supply-chain relevant subjects.
      const subject =
        action.serverId ||
        action.server ||
        action.mcpServer ||
        action.plugin ||
        action.package ||
        action.target;
      if (!subject) return null;
      const params = action.parameters || {};
      const PIN_KEYS = [
        'sha256',
        'sha512',
        'digest',
        'hash',
        'integrity',
        'checksum',
        'signature',
        'sig',
        'publisherKey',
        'publisher_key',
        'pinnedVersion',
        'pinned_version',
        'pin',
      ];
      const hasPin = PIN_KEYS.some(
        (k) => params[k] !== undefined && params[k] !== null && params[k] !== ''
      );
      if (hasPin) return null;
      // A registry that is the operator's own allowlisted source is fine
      // to install without a hash — that is a reviewed decision.
      const registry = params.registry || params.source || params.registryUrl;
      if (registry && /\b(goodciso|local|internal|private)\b/i.test(String(registry))) {
        return null;
      }
      return { subject: String(subject), integrityPinAbsent: true };
    },
  },
  {
    // 2026-11-10 (scribe): MCP08 (Authentication & Identity) had a
    // catalogue entry but no rule. The event-only detectable shape is a
    // per-call authZ that is not audience-bound: a credential is presented
    // to a server without an `audience`/`aud` claim tying it to that
    // server, so a credential minted for one MCP server would be accepted
    // by another. Absence of audience binding is the detectable failure.
    id: 'unbound-audience-credential',
    classes: ['MCP08'],
    confidence: 'M',
    reference: 'MCP08#identity',
    description:
      'A credential is presented to an MCP server without an audience ' +
      'binding, so a token minted for one server may be replayed against ' +
      'another.',
    test(event) {
      const action = event?.action || {};
      const params = action.parameters || {};
      // Find a credential-shaped field, at any depth (bounded).
      const CRED_KEY_RE = /^(authorization|bearer|token|api[_-]?key|access[_-]?token|id[_-]?token|credential)$/i;
      const AUD_KEY_RE = /^(aud|audience|audiences|target[_-]?audience|intended[_-]?audience|azp|client[_-]?id)$/i;
      const MAX_DEPTH = 5;
      const MAX_NODES = 120;
      const seen = new Set();
      let nodes = 0;

      const walk = (value, path, depth) => {
        if (nodes >= MAX_NODES || depth > MAX_DEPTH) return null;
        if (value === null || typeof value !== 'object') return null;
        if (seen.has(value)) return null;
        seen.add(value);
        nodes += 1;

        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i += 1) {
            const hit = walk(value[i], `${path}[${i}]`, depth + 1);
            if (hit) return hit;
          }
          return null;
        }

        const keys = Object.keys(value);
        const credKey = keys.find(
          (k) => CRED_KEY_RE.test(k) && typeof value[k] === 'string' && value[k].length >= 8
        );
        if (credKey) {
          const hasAudience = keys.some(
            (k) => AUD_KEY_RE.test(k) && value[k] !== undefined && value[k] !== null && value[k] !== ''
          );
          if (!hasAudience) {
            return { credentialField: path ? `${path}.${credKey}` : credKey, audienceAbsent: true };
          }
        }
        for (const k of keys) {
          const hit = walk(value[k], path ? `${path}.${k}` : k, depth + 1);
          if (hit) return hit;
        }
        return null;
      };

      const hit = walk(params, '', 0);
      if (!hit) return null;
      // A credential for the SAME server the call is going to is fine; the
      // risk is a credential with no audience claim at all.
      return hit;
    },
  },
];

/**
 * Stable hash of an arbitrary value, for evidence fingerprints.
 */
function hashOf(value) {
  try {
    return crypto
      .createHash('sha256')
      .update(typeof value === 'string' ? value : JSON.stringify(value || {}))
      .digest('hex')
      .slice(0, 16);
  } catch {
    return 'unhashable';
  }
}

/**
 * Default audit logger. Mirrors ast10-mapper's defaultAuditLogger:
 * resolves the decision-logger lazily and fails open (returns null) if
 * it is unavailable, so classification never breaks the caller.
 */
function defaultAuditLogger() {
  try {
    const { logDecision } = require('../audit/decision-logger');
    return { logDecision };
  } catch {
    return null;
  }
}

/**
 * Create an MCP10 classifier.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.enableWrites=true] - when false, classifyAndLog()
 *        returns annotations but writes nothing.
 * @param {string[]} [opts.serverAllowlist] - canonical MCP server names.
 * @param {string[]} [opts.allowlist] - hostnames whose fetched content is
 *        operator-sanctioned (no indirect-injection annotation).
 * @param {Object} [opts.auditLogger] - {logDecision} for chain writes.
 * @returns {Object} the classifier
 */
function createMCP10Classifier(opts = {}) {
  return {
    config: {
      enableWrites: opts.enableWrites !== false,
      serverAllowlist: Array.isArray(opts.serverAllowlist) ? opts.serverAllowlist : null,
      allowlist: Array.isArray(opts.allowlist) ? opts.allowlist : null,
    },
    defaultLogger: opts.auditLogger || defaultAuditLogger(),
    rules: RULES,
  };
}

/**
 * Pure classifier. No side effects.
 *
 * @param {Object} mapper - classifier instance
 * @param {Object} event - decision-chain event
 * @returns {MCP10Annotation[]}
 */
function classify(mapper, event) {
  if (!event || typeof event !== 'object') return [];

  const ctx = {
    allowlist: mapper?.config?.allowlist || null,
    serverAllowlist: mapper?.config?.serverAllowlist || null,
  };

  const matched = [];
  for (const rule of RULES) {
    let evidence;
    try {
      evidence = rule.test(event, ctx);
    } catch {
      // A rule that throws must not take down the classifier.
      continue;
    }
    if (!evidence) continue;
    matched.push({
      rule: rule.id,
      classes: rule.classes,
      confidence: rule.confidence,
      reference: rule.reference,
      description: rule.description,
      evidence: { ...evidence, parametersHash: hashOf(event?.action?.parameters) },
      sourceDecisionId: event.decisionId || null,
      eventType: event?.action?.type || null,
    });
  }
  return matched;
}

/**
 * Classify and write each annotation onto the decision chain.
 *
 * @param {Object} mapper
 * @param {Object} event
 * @param {Object} [hooks] - {onError}
 * @returns {Promise<Array>} the annotations that were written
 */
async function classifyAndLog(mapper, event, hooks = {}) {
  const annotations = classify(mapper, event);
  if (!mapper?.config?.enableWrites) return [];
  if (annotations.length === 0) return [];

  const logger = mapper.defaultLogger;
  if (!logger || typeof logger.logDecision !== 'function') {
    if (typeof hooks.onError === 'function') {
      for (const a of annotations) {
        hooks.onError(a, new Error('No audit logger configured on classifier'));
      }
    }
    return [];
  }

  const written = [];
  for (const ann of annotations) {
    const decisionRecord = {
      decisionId: require('crypto').randomUUID(),
      parentDecisionId: ann.sourceDecisionId,
      timestamp: new Date().toISOString(),
      actor: {
        agentId: event?.actor?.agentId || 'mcp10-classifier',
        trustScore: 1.0,
      },
      action: {
        type: 'mcp10_annotation',
        target: ann.classes.join(','),
        reason: ann.rule,
        annotation: ann,
      },
      context: {
        sourceDecisionId: ann.sourceDecisionId,
        eventType: ann.eventType,
      },
      outcome: {
        success: true,
        latencyMs: 0,
        errorMessage: null,
      },
    };
    try {
      await logger.logDecision(decisionRecord);
      written.push(ann);
    } catch (err) {
      if (typeof hooks.onError === 'function') hooks.onError(ann, err);
    }
  }
  return written;
}

/**
 * Classify a chain segment — every record in it that carries MCP activity.
 *
 * @param {Object} mapper
 * @param {Array} segment - chain records
 * @returns {Array} all annotations across the segment
 */
function classifyChainSegment(mapper, segment) {
  if (!Array.isArray(segment)) return [];
  const out = [];
  for (const record of segment) {
    if (!record || !record.action) continue;
    const type = record.action.type;
    if (type !== 'tool_dispatch' && type !== 'mcp_message' && type !== 'mcp_tool_call') {
      continue;
    }
    out.push(...classify(mapper, record));
  }
  return out;
}

module.exports = {
  createMCP10Classifier,
  classify,
  classifyAndLog,
  classifyChainSegment,
  MCP_TOP_10_CONTROLS,
  MCP_TOP_10_CONTROL_IDS,
  RULES,
};
