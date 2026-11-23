// src/acs/approval.js
// The ACS approval seam.
//
// THE GAP THIS FILLS
// ------------------
// AWARE represents human approval as a BOOLEAN FLAG. The tool catalogue has
// `requiresApproval(toolName)` (src/policies/tool-catalog.js:296) and the
// policy model has `ConditionType.REQUIRED_APPROVAL` (src/policies/model.js:44).
// There is no request object, no resolution object, no outcome state
// machine, and no identity binding.
//
// ACS requires all four. ACS SPEC section 13: a `deny` carrying an `approval`
// block is LIFTABLE through the host's approval seam. ACS SPEC section 17:
// the host MUST route an `escalate` verdict (a deny carrying an approval
// block) to an approval path and MUST NOT carry out the action until that
// path resolves.
//
// AGENT-HOOKS-0.1 section 9 (vendored as docs/acs/schemas/approval.schema.json)
// adds the ECHO RULE: "MUST equal the request's context_identity byte for
// byte (echo rule, section 9); null echoes as null." A resolution that does
// not echo the identity is rejected.
//
// WHY NOT REUSE src/emergency/recovery-manager.js
// -------------------------------------------------
// That module has a PENDING/APPROVED state machine, but it is for
// RE-ONBOARDING AFTER A KILL SIGNAL. It is a different concern with a
// different lifecycle. Reusing it would conflate "may this agent act again"
// with "may this one tool call proceed". The adapter defines its own seam.

'use strict';

const crypto = require('crypto');
const { failClosed } = require('./fail-closed');

/**
 * The approval outcomes (AGENT-HOOKS-0.1 section 9).
 */
const ApprovalOutcome = Object.freeze({
  APPROVE: 'approve',
  REJECT: 'reject',
  UNRESOLVED: 'unresolved',
});

/**
 * The default lifetime of an approval request, in milliseconds.
 *
 * An expired approval fails closed: the deny stands. The spec requires an
 * unresolved approval to deny, and an expired approval is unresolved.
 */
const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

/**
 * Compute the context identity for an approval request.
 *
 * When an identity provider is declared, the identity is a content-derived
 * digest over the context shown to the approver. That is what makes an
 * approval obtained for one content unusable against another content
 * (AGENT-HOOKS-0.1 section 10.1).
 *
 * THE CANONICAL FORM
 * ------------------
 * The digest MUST cover the whole context, including nested values. A
 * top-level-only serialisation would drop every nested member, so an
 * approval granted for one tool argument could be replayed against a
 * different argument. That is precisely the attack the echo rule exists to
 * prevent, so the serialisation here sorts object keys at EVERY level.
 *
 * @param {Object} context - The context presented to the approver.
 * @returns {string} A `sha256:<hex>` context identity.
 */
function computeContextIdentity(context) {
  const canonical = canonicalise(context === undefined ? null : context);
  const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:${digest}`;
}

/**
 * Canonical JSON serialisation with sorted keys at every level.
 *
 * The ordering must be stable across processes, so the keys are sorted by
 * their UTF-16 code units, which is what JSON.stringify does for an object
 * literal's own keys.
 *
 * @param {*} value - The value to serialise.
 * @returns {string} The canonical form.
 */
function canonicalise(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const members = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalise(value[key])}`,
  );
  return `{${members.join(',')}}`;
}

/**
 * The in-memory approval store.
 *
 * The store is pluggable: a host that needs durable storage can inject its
 * own. The default keeps requests in memory, which is enough for the
 * reviewable branch and for a single-process host. Every request and every
 * resolution is also written to the audit trail by the decision engine, so
 * the TRAIL is durable even when this map is not.
 */
class ApprovalStore {
  constructor() {
    /** @type {Map<string, Object>} */
    this.requests = new Map();
  }

  /**
   * @param {string} id - The request id.
   * @param {Object} request - The request record.
   * @returns {void}
   */
  put(id, request) {
    this.requests.set(id, request);
  }

  /**
   * @param {string} id - The request id.
   * @returns {Object|undefined} The request record.
   */
  get(id) {
    return this.requests.get(id);
  }

  /**
   * @param {string} id - The request id.
   * @returns {void}
   */
  delete(id) {
    this.requests.delete(id);
  }

  /**
   * @returns {number} The number of stored requests.
   */
  get size() {
    return this.requests.size;
  }
}

/**
 * The approval seam.
 */
class ApprovalSeam {
  /**
   * @param {Object} [config] - The seam configuration.
   * @param {ApprovalStore} [config.store] - An injected store.
   * @param {number} [config.ttlMs] - The request lifetime.
   * @param {Function} [config.onEvent] - Called with each approval event, so
   *   the caller can write it to the audit trail.
   */
  constructor(config = {}) {
    this.store = config.store || new ApprovalStore();
    this.ttlMs = typeof config.ttlMs === 'number' ? config.ttlMs : DEFAULT_APPROVAL_TTL_MS;
    this.onEvent = typeof config.onEvent === 'function' ? config.onEvent : null;
  }

  /**
   * Create an approval request for a liftable deny.
   *
   * @param {Object} input - The request input.
   * @param {Object} input.verdict - The liftable deny verdict.
   * @param {string} input.interventionPoint - The intervention point.
   * @param {*} input.context - The context shown to the approver.
   * @param {string} [input.contextIdentity] - The identity. Computed from the
   *   context when omitted.
   * @param {string} [input.sessionId] - The host session id.
   * @returns {Object} The approval request, including its id.
   */
  createRequest(input) {
    const { verdict, interventionPoint, context, sessionId } = input;
    // A null context identity is MEANINGFUL, not "absent". AGENT-HOOKS-0.1
    // section 10.1: a host whose identity provider is null binds approvals
    // by request and response correlation only, and "null echoes as null".
    // So an explicit null must be preserved, and only an UNDEFINED identity
    // is computed from the context.
    const contextIdentity = input.contextIdentity === undefined
      ? computeContextIdentity(context)
      : input.contextIdentity;
    const id = `acs-appr-${crypto.randomUUID()}`;
    const now = Date.now();

    const request = {
      requestId: id,
      interventionPoint,
      contextIdentity,
      context: context === undefined ? null : context,
      sessionId: sessionId || null,
      // The verdict being consulted. A liftable deny carries decision deny.
      verdict: verdict || { decision: 'deny' },
      status: ApprovalOutcome.UNRESOLVED,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    };

    this.store.put(id, request);
    this._emit({
      type: 'approval_requested',
      requestId: id,
      interventionPoint,
      contextIdentity,
      status: ApprovalOutcome.UNRESOLVED,
      timestamp: new Date(now).toISOString(),
    });

    return request;
  }

  /**
   * Resolve an approval request.
   *
   * The echo rule is enforced here: a resolution whose `contextIdentity` does
   * not match the request byte for byte is REJECTED and the deny stands.
   *
   * @param {string} requestId - The request to resolve.
   * @param {Object} resolution - The resolution.
   * @param {string} resolution.outcome - One of approve, reject, unresolved.
   * @param {string} [resolution.resolvedBy] - Who resolved it.
   * @param {string} [resolution.contextIdentity] - The echoed identity.
   * @returns {{ok: boolean, verdict: Object, reason: string|null, request: Object|null}}
   *   The outcome. When ok is false the verdict is the fail-closed deny.
   */
  resolve(requestId, resolution) {
    const request = this.store.get(requestId);
    if (!request) {
      return {
        ok: false,
        verdict: failClosed(
          'runtime_error:approval_resolver_failed',
          'The approval request is unknown to the seam.',
        ),
        reason: 'runtime_error:approval_resolver_failed',
        request: null,
      };
    }

    if (!resolution || typeof resolution !== 'object') {
      return {
        ok: false,
        verdict: failClosed(
          'runtime_error:approval_resolver_failed',
          'The approval resolution is missing or is not an object.',
        ),
        reason: 'runtime_error:approval_resolver_failed',
        request,
      };
    }

    const outcome = resolution.outcome;
    if (!Object.values(ApprovalOutcome).includes(outcome)) {
      return {
        ok: false,
        verdict: failClosed(
          'runtime_error:approval_resolver_failed',
          'The approval resolution carries an unknown outcome.',
        ),
        reason: 'runtime_error:approval_resolver_failed',
        request,
      };
    }

    // An approval request is resolved ONCE. A request that has already
    // been rejected or left unresolved must not be re-resolved to an
    // approval: that would let a rejected action be replayed into a
    // permitted one. A second resolution fails closed and the FIRST
    // resolution stands.
    if (request.status !== ApprovalOutcome.UNRESOLVED) {
      this._emit({
        type: 'approval_already_resolved',
        requestId,
        interventionPoint: request.interventionPoint,
        status: request.status,
        timestamp: new Date().toISOString(),
      });
      return {
        ok: false,
        verdict: failClosed(
          'runtime_error:approval_resolver_failed',
          'The approval request has already been resolved.',
        ),
        reason: 'runtime_error:approval_resolver_failed',
        request,
      };
    }

    // The echo rule. `null` echoes as `null`, so the comparison is exact.
    // The identity must also be a string or null: an object or a number
    // would compare unequal to any real identity and could never echo, but
    // it must be REJECTED explicitly rather than merely failing the
    // comparison, so the failure is reported as a malformed resolution.
    if (
      resolution.contextIdentity !== null
      && typeof resolution.contextIdentity !== 'string'
    ) {
      return {
        ok: false,
        verdict: failClosed(
          'runtime_error:approval_resolver_failed',
          'The approval resolution carries a context identity that is neither a string nor null.',
        ),
        reason: 'runtime_error:approval_resolver_failed',
        request,
      };
    }

    if (resolution.contextIdentity !== request.contextIdentity) {
      request.status = ApprovalOutcome.UNRESOLVED;
      this._emit({
        type: 'approval_identity_mismatch',
        requestId,
        interventionPoint: request.interventionPoint,
        timestamp: new Date().toISOString(),
      });
      return {
        ok: false,
        verdict: failClosed(
          'runtime_error:approval_resolver_failed',
          'The approval resolution does not echo the request context identity.',
        ),
        reason: 'runtime_error:approval_resolver_failed',
        request,
      };
    }

    // An expired request cannot be approved. The deny stands.
    if (Date.now() > request.expiresAt) {
      request.status = ApprovalOutcome.UNRESOLVED;
      this._emit({
        type: 'approval_expired',
        requestId,
        interventionPoint: request.interventionPoint,
        timestamp: new Date().toISOString(),
      });
      return {
        ok: false,
        verdict: failClosed(
          'runtime_error:approval_resolver_failed',
          'The approval request has expired.',
        ),
        reason: 'runtime_error:approval_resolver_failed',
        request,
      };
    }

    request.status = outcome;
    request.resolvedAt = Date.now();
    request.resolvedBy = resolution.resolvedBy || null;
    request.resolution = {
      outcome,
      contextIdentity: resolution.contextIdentity,
      resolvedBy: request.resolvedBy,
    };

    this._emit({
      type: 'approval_resolved',
      requestId,
      interventionPoint: request.interventionPoint,
      outcome,
      contextIdentity: request.contextIdentity,
      timestamp: new Date(request.resolvedAt).toISOString(),
    });

    if (outcome === ApprovalOutcome.APPROVE) {
      // The deny is LIFTED. The verdict becomes an allow.
      return {
        ok: true,
        verdict: {
          decision: 'allow',
          reason: 'approval_granted',
          message: 'The action was approved by a human reviewer.',
        },
        reason: null,
        request,
      };
    }

    // reject and unresolved both leave the deny standing. An unresolved
    // approval is a fail-closed condition, never an allow.
    const reason = outcome === ApprovalOutcome.REJECT
      ? 'approval_rejected'
      : 'approval_unresolved';
    return {
      ok: false,
      verdict: {
        decision: 'deny',
        reason,
        message: outcome === ApprovalOutcome.REJECT
          ? 'The action was rejected by a human reviewer.'
          : 'The approval did not resolve; the deny stands.',
      },
      reason,
      request,
    };
  }

  /**
   * @param {string} requestId - The request id.
   * @returns {Object|null} The request record, or null.
   */
  getRequest(requestId) {
    return this.store.get(requestId) || null;
  }

  /**
   * Emit an event to the configured listener.
   *
   * @param {Object} event - The event.
   * @returns {void}
   */
  _emit(event) {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (err) {
      // An audit-write failure must not turn an approval into an allow. The
      // decision engine records the approval event separately, and the
      // verdict path never consults this listener's success.
      // eslint-disable-next-line no-console
      console.error(`[acs] approval event write failed: ${err.message}`);
    }
  }
}

module.exports = {
  ApprovalOutcome,
  ApprovalStore,
  ApprovalSeam,
  DEFAULT_APPROVAL_TTL_MS,
  computeContextIdentity,
};
