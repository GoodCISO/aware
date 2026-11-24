// src/policies/engine.js
// Policy Engine — Evaluates tool-call requests against policies
// Phase 1.2: Per-Agent Sandbox Policies

const { PolicyAction, parseFrequency } = require('./model');
const { getToolCatalog } = require('./tool-catalog');
const { getPolicyStore } = require('./store');

/**
 * Policy decision result
 */
const Decision = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  AUDIT: 'AUDIT',
  NO_POLICY: 'NO_POLICY'
};

/**
 * Default policy if no matching policy exists
 */
const DEFAULT_DECISION = Decision.DENY;

/**
 * In-memory request tracking for rate limiting
 */
const requestCounts = new Map(); // key -> { count, windowStart }

class PolicyEngine {
  /**
   * @param {Object} config - Configuration
   */
  constructor(config = {}) {
    this.toolCatalog = getToolCatalog(config.toolCatalog);
    this.policyStore = getPolicyStore(config.policyStore);
    this.defaultDecision = config.defaultDecision || DEFAULT_DECISION;
    this.frequencyWindows = new Map(); // Track frequency windows

    // ── Extension point ──
    // The registry is optional. With none registered, evaluate() is the
    // untouched prototype method and this is a pure pass-through.
    //
    // The wrapper is installed here rather than at each `return` site inside
    // evaluate() because evaluate() has many internal return points, and a
    // per-return hook would silently miss any return added later.
    this.extensions = config.extensions || null;
    if (this.extensions) {
      const rawEvaluate = this.evaluate.bind(this);
      this.evaluate = (request) => {
        const result = rawEvaluate(request);
        // Fire and forget: an extension must never delay or alter a policy
        // decision. The registry contains failures, so a throwing extension
        // is recorded rather than propagated.
        // The extension receives a DEEP COPY. It is an observer, not a
        // participant: handing it the live object would let it rewrite the
        // verdict in place, which would be a policy bypass. (Found by the
        // contract test in test/unit/extension/extension-contract.test.js,
        // which asserts the extension CANNOT change the decision.)
        let snapshot;
        try {
          snapshot = {
            request: structuredClone(request),
            decision: structuredClone(result),
          };
        } catch (_e) {
          // If the decision carries something structuredClone cannot handle,
          // skip the notification rather than risk handing over a live
          // reference. An extension that misses one event is better than an
          // extension that can flip a verdict.
          return result;
        }
        Promise.resolve(
          this.extensions.dispatch('onDecision', snapshot)
        ).catch(() => {});
        return result;
      };
    }
  }

  /**
   * Evaluate a tool-call request
   * @param {Object} request - Request object
   * @param {string} request.agentId - Agent ID
   * @param {string} request.tool - Tool name
   * @param {Object} request.context - Additional context (targets, dataTier, etc.)
   * @returns {Object} Decision result
   */
  evaluate(request) {
    const { agentId, tool, context = {} } = request;
    
    // Check if tool is known
    const isKnownTool = this.toolCatalog.isKnownTool(tool);
    const riskLevel = this.toolCatalog.getRiskLevel(tool);
    const toolRequiresApproval = this.toolCatalog.requiresApproval(tool);
    
    // Find matching policies
    const policies = this.policyStore.findForTool(agentId, tool);
    
    // Default result if no policies match
    if (policies.length === 0) {
      // If tool is unknown or high-risk, default to DENY
      if (!isKnownTool || riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
        return {
          decision: Decision.DENY,
          reason: `No policy found for ${tool} (default deny for ${riskLevel} risk)`,
          policyId: null,
          riskLevel,
          requiresApproval: true
        };
      }
      
      // For low-risk known tools, allow with audit
      return {
        decision: this.defaultDecision,
        reason: 'No matching policy, using default',
        policyId: null,
        riskLevel,
        requiresApproval: toolRequiresApproval
      };
    }
    
    // Sort policies by priority (already sorted in store)
    // Evaluate in order until a decision is reached
    for (const policy of policies) {
      const decision = this._evaluatePolicy(policy, request);
      
      if (decision.decision !== Decision.AUDIT) {
        return {
          ...decision,
          riskLevel,
          requiresApproval: toolRequiresApproval
        };
      }
      
      // If AUDIT, continue checking other policies but keep audit trail
    }
    
    // All policies returned AUDIT, take the last one
    return {
      decision: Decision.AUDIT,
      reason: 'Policy evaluation completed with audit decisions',
      policyId: policies[policies.length - 1]?.policyId,
      riskLevel,
      requiresApproval: toolRequiresApproval
    };
  }

  /**
   * Evaluate a single policy against a request
   * @private
   */
  _evaluatePolicy(policy, request) {
    const { agentId, tool, context = {} } = request;
    
    // Check enabled
    if (!policy.enabled) {
      return { decision: Decision.NO_POLICY, reason: 'Policy disabled' };
    }
    
    // Check conditions
    if (policy.conditions) {
      // Check frequency limit
      if (policy.conditions.maxFrequency) {
        const freqResult = this._checkFrequency(agentId, tool, policy.conditions.maxFrequency);
        if (!freqResult.allowed) {
          return {
            decision: Decision.DENY,
            reason: `Rate limit exceeded: ${policy.conditions.maxFrequency}`,
            policyId: policy.policyId
          };
        }
      }
      
      // Check allowed targets
      if (policy.conditions.allowedTargets && policy.conditions.allowedTargets.length > 0) {
        const target = context.target || context.url || '*';
        if (!this._matchesAnyPattern(target, policy.conditions.allowedTargets)) {
          return {
            decision: Decision.DENY,
            reason: `Target ${target} not in allowed targets`,
            policyId: policy.policyId
          };
        }
      }
      
      // Check data tier
      if (policy.conditions.dataTier) {
        const requestedTier = context.dataTier || 'INTERNAL';
        if (!this._meetsDataTierRequirement(requestedTier, policy.conditions.dataTier)) {
          return {
            decision: Decision.DENY,
            reason: `Data tier ${requestedTier} does not meet requirement ${policy.conditions.dataTier}`,
            policyId: policy.policyId
          };
        }
      }
      
      // Check token budget
      if (policy.conditions.tokenBudget !== undefined) {
        const tokenUsage = context.tokenUsage || 0;
        if (tokenUsage > policy.conditions.tokenBudget) {
          return {
            decision: Decision.DENY,
            reason: `Token usage ${tokenUsage} exceeds budget ${policy.conditions.tokenBudget}`,
            policyId: policy.policyId
          };
        }
      }
    }
    
    // All conditions passed, return the policy's action
    return {
      decision: policy.action,
      reason: `Policy ${policy.policyId} allows`,
      policyId: policy.policyId
    };
  }

  /**
   * Check frequency limit
   * @private
   */
  _checkFrequency(agentId, tool, maxFrequency) {
    const key = `${agentId}:${tool}`;
    const { count, periodMs } = parseFrequency(maxFrequency);
    
    const now = Date.now();
    const record = this.frequencyWindows.get(key);
    
    // Initialize or reset window
    if (!record || (now - record.windowStart) >= periodMs) {
      this.frequencyWindows.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: count - 1 };
    }
    
    // Increment count
    record.count++;
    this.frequencyWindows.set(key, record);
    
    return {
      allowed: record.count <= count,
      remaining: Math.max(0, count - record.count)
    };
  }

  /**
   * Check if a value matches any pattern in a list
   * @private
   */
  _matchesAnyPattern(value, patterns) {
    return patterns.some(pattern => {
      if (pattern === '*') return true;
      if (pattern.includes('*')) {
        // Glob pattern matching
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(value);
      }
      return value === pattern;
    });
  }

  /**
   * Check if data tier meets requirement
   * @private
   * Data tier hierarchy: PUBLIC < INTERNAL < CONFIDENTIAL < RESTRICTED
   */
  _meetsDataTierRequirement(actual, required) {
    const tierOrder = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
    const actualIndex = tierOrder.indexOf(actual);
    const requiredIndex = tierOrder.indexOf(required);
    
    // If actual is higher or equal, it meets the requirement
    return actualIndex >= requiredIndex;
  }

  /**
   * Pre-authorization check (for UI display)
   *
   * This DELEGATES to `evaluate()` rather than reimplementing the decision.
   * A previous implementation computed its own answer from the risk level
   * alone (`riskLevel !== 'HIGH' && riskLevel !== 'CRITICAL'`), which made the
   * preview STRICTLY MORE PERMISSIVE than the decision it previewed: in a
   * default-deny system, a reader who took the preview for the decision would
   * believe low-risk tools were allowed when `evaluate()` denies them.
   *
   * `evaluate()` has no side effects — it reads the policy store and the tool
   * catalogue and returns a decision — so delegating is safe for a read-only
   * preview endpoint and guarantees the two cannot drift apart.
   *
   * @param {string} agentId - Agent ID
   * @param {string} tool - Tool name
   * @returns {Object} Preview of what decision would be
   */
  preview(agentId, tool) {
    const policies = this.policyStore.findForTool(agentId, tool);
    const riskLevel = this.toolCatalog.getRiskLevel(tool);
    const toolRequiresApproval = this.toolCatalog.requiresApproval(tool);

    const result = this.evaluate({ agentId, tool });

    return {
      // `wouldBeAllowed` is derived from the SAME decision `evaluate()` would
      // return, so the preview cannot disagree with the enforcement path.
      wouldBeAllowed: result.decision === Decision.ALLOW,
      decision: result.decision,
      riskLevel,
      requiresApproval: result.requiresApproval ?? toolRequiresApproval,
      matchingPolicies: policies.map(p => p.policyId),
      reason: result.reason
    };
  }

  /**
   * Get all policies that would affect a tool for an agent
   * @param {string} agentId - Agent ID
   * @param {string} tool - Tool name
   * @returns {Array} Matching policies
   */
  getApplicablePolicies(agentId, tool) {
    return this.policyStore.findForTool(agentId, tool);
  }

  /**
   * Reset frequency counters (for testing)
   */
  resetCounters() {
    this.frequencyWindows.clear();
  }
}

// Singleton instance
let policyEngineInstance = null;

/**
 * Get or create the policy engine singleton
 * @param {Object} config - Configuration
 * @returns {PolicyEngine}
 */
function getPolicyEngine(config = {}) {
  if (!policyEngineInstance) {
    policyEngineInstance = new PolicyEngine(config);
  }
  return policyEngineInstance;
}

module.exports = {
  PolicyEngine,
  getPolicyEngine,
  Decision,
  DEFAULT_DECISION
};
