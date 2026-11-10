// src/policies/model.js
// Policy Model — Schema definitions for per-agent sandbox policies
// Phase 1.2: Per-Agent Sandbox Policies

const crypto = require('crypto');

// 2026-11-10 (scribe): the `AgentState` import was DEAD — this module
// never referenced it (grep count was 1: the import line itself).
// It was not harmless: `api/models/Agent.js` calls process.exit(1) at
// MODULE LOAD when neither AWARE_CREDENTIAL_PEPPER nor SECRET_KEY is set,
// so requiring it from the policy schema meant the whole gateway booted,
// bound its port, and then died — crashing the container on every restart
// with:
//
//   FATAL: Either AWARE_CREDENTIAL_PEPPER or SECRET_KEY must be set
//
// The require chain was: src/gateway/server.js -> compliance/evidence-
// collector.js -> policies/store.js -> policies/model.js -> api/models/
// Agent.js.
//
// The gateway does NOT need the agent credential model, so the dead import
// is removed rather than papered over with a secret in the compose file.

/**
 * Policy action types
 */
const PolicyAction = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  AUDIT: 'AUDIT'
};

/**
 * Policy schema version
 */
const POLICY_VERSION = '1.0';

/**
 * Condition types that can be evaluated
 */
const ConditionType = {
  MAX_FREQUENCY: 'maxFrequency',
  ALLOWED_TARGETS: 'allowedTargets',
  REQUIRED_APPROVAL: 'requireApproval',
  TIME_WINDOW: 'timeWindow',
  DATA_TIER: 'dataTier',
  TOKEN_BUDGET: 'tokenBudget',
  MAX_ERROR_RATE: 'maxErrorRate'
};

/**
 * Tool risk levels
 */
const ToolRiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL'
};

/**
 * Data classification tiers
 */
const DataTier = {
  PUBLIC: 'PUBLIC',
  INTERNAL: 'INTERNAL',
  CONFIDENTIAL: 'CONFIDENTIAL',
  RESTRICTED: 'RESTRICTED'
};

/**
 * Creates a new policy object with validation
 * @param {Object} policyData - Policy data
 * @returns {Object} Validated policy object
 */
function createPolicy(policyData) {
  const errors = validatePolicy(policyData);
  if (errors.length > 0) {
    throw new Error(`Invalid policy: ${errors.join(', ')}`);
  }

  return {
    policyId: policyData.policyId || generatePolicyId(),
    agentId: policyData.agentId,
    tool: policyData.tool,
    action: policyData.action,
    conditions: policyData.conditions || {},
    priority: policyData.priority || 0, // Higher priority policies evaluated first
    enabled: policyData.enabled !== false,
    createdAt: policyData.createdAt || new Date().toISOString(),
    createdBy: policyData.createdBy || 'system',
    updatedAt: policyData.updatedAt || new Date().toISOString(),
    version: POLICY_VERSION,
    metadata: policyData.metadata || {}
  };
}

/**
 * Validates a policy object
 * @param {Object} policy - Policy to validate
 * @returns {Array} Array of validation errors
 */
function validatePolicy(policy) {
  const errors = [];

  if (!policy.agentId || typeof policy.agentId !== 'string') {
    errors.push('agentId is required and must be a string');
  }

  if (!policy.tool || typeof policy.tool !== 'string') {
    errors.push('tool is required and must be a string');
  }

  if (!Object.values(PolicyAction).includes(policy.action)) {
    errors.push(`action must be one of: ${Object.values(PolicyAction).join(', ')}`);
  }

  if (policy.conditions) {
    if (typeof policy.conditions !== 'object') {
      errors.push('conditions must be an object');
    } else {
      // Validate maxFrequency if present
      if (policy.conditions.maxFrequency) {
        if (!validateFrequency(policy.conditions.maxFrequency)) {
          errors.push('conditions.maxFrequency must be in format "N/period" e.g., "10/minute"');
        }
      }

      // Validate allowedTargets if present
      if (policy.conditions.allowedTargets) {
        if (!Array.isArray(policy.conditions.allowedTargets)) {
          errors.push('conditions.allowedTargets must be an array');
        }
      }

      // Validate tokenBudget if present
      if (policy.conditions.tokenBudget) {
        if (typeof policy.conditions.tokenBudget !== 'number' || policy.conditions.tokenBudget < 0) {
          errors.push('conditions.tokenBudget must be a non-negative number');
        }
      }
    }
  }

  if (policy.priority !== undefined && (typeof policy.priority !== 'number' || policy.priority < 0)) {
    errors.push('priority must be a non-negative number');
  }

  return errors;
}

/**
 * Validates a frequency string (e.g., "10/minute", "100/hour")
 * @param {string} frequency - Frequency string
 * @returns {boolean} Whether frequency is valid
 */
function validateFrequency(frequency) {
  if (typeof frequency !== 'string') return false;
  const match = frequency.match(/^(\d+)\/(\w+)$/);
  if (!match) return false;
  const count = parseInt(match[1], 10);
  const period = match[2].toLowerCase();
  return count > 0 && ['second', 'minute', 'hour', 'day'].includes(period);
}

/**
 * Parses a frequency string into { count, periodMs }
 * @param {string} frequency - Frequency string (e.g., "10/minute")
 * @returns {Object} Parsed frequency with count and periodMs
 */
function parseFrequency(frequency) {
  const match = frequency.match(/^(\d+)\/(\w+)$/);
  if (!match) {
    throw new Error(`Invalid frequency format: ${frequency}`);
  }

  const count = parseInt(match[1], 10);
  const period = match[2].toLowerCase();

  const periodMs = {
    second: 1000,
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000
  }[period];

  if (!periodMs) {
    throw new Error(`Invalid period: ${period}`);
  }

  return { count, periodMs, period };
}

/**
 * Generates a unique policy ID
 * @returns {string} Policy ID
 */
function generatePolicyId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(3).toString('hex');
  return `pol_${timestamp}_${random}`;
}

/**
 * Default conditions factory
 * @param {string} action - Default action (ALLOW, DENY, AUDIT)
 * @returns {Object} Default conditions
 */
function defaultConditions(action) {
  return {
    action,
    conditions: {
      maxFrequency: action === PolicyAction.ALLOW ? '100/minute' : '10/minute',
      requireApproval: false,
      allowedTargets: action === PolicyAction.DENY ? [] : undefined
    }
  };
}

/**
 * Checks if a policy matches a given agent and tool
 * @param {Object} policy - Policy to check
 * @param {string} agentId - Agent ID
 * @param {string} tool - Tool name
 * @returns {boolean} Whether the policy matches
 */
function policyMatches(policy, agentId, tool) {
  if (!policy.enabled) return false;
  if (policy.agentId !== agentId && policy.agentId !== '*') return false;
  if (policy.tool !== tool && policy.tool !== '*') return false;
  return true;
}

/**
 * Serializes a policy for storage
 * @param {Object} policy - Policy to serialize
 * @returns {string} JSON string
 */
function serializePolicy(policy) {
  return JSON.stringify(policy, null, 2);
}

/**
 * Deserializes a policy from storage
 * @param {string} json - JSON string
 * @returns {Object} Policy object
 */
function deserializePolicy(json) {
  try {
    const policy = JSON.parse(json);
    // Ensure version compatibility
    if (!policy.version) {
      policy.version = '1.0';
    }
    return policy;
  } catch (error) {
    throw new Error(`Failed to deserialize policy: ${error.message}`);
  }
}

module.exports = {
  PolicyAction,
  PolicyVersion: POLICY_VERSION,
  ConditionType,
  ToolRiskLevel,
  DataTier,
  createPolicy,
  validatePolicy,
  validateFrequency,
  parseFrequency,
  generatePolicyId,
  defaultConditions,
  policyMatches,
  serializePolicy,
  deserializePolicy
};
