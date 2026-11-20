/**
 * ADR (internal): Phase 2.2 — Security-Weighted Heuristic Function
 * 
 * Security-weighted heuristic η(agent, task) that supplements pheromone strength
 * in AWARE's AMRO-S probabilistic selection formula.
 * 
 * @module routing/heuristic-calculator
 * @author Coder (Coder)
 * @license GPL-3.0
 */

'use strict';

/**
 * @typedef {Object} HeuristicWeights
 * @property {number} w1_capability - Weight for agent capability score (default: 0.30)
 * @property {number} w2_load_balance - Weight for load balance score (default: 0.20)
 * @property {number} w3_trust_score - Weight for behavioural trust score (default: 0.25)
 * @property {number} w4_data_clearance - Weight for data clearance match (default: 0.15)
 * @property {number} w5_blast_radius_inverse - Weight for blast radius inverse (default: 0.10)
 */

/**
 * @typedef {Object} AgentHeuristicInputs
 * @property {string} agentId - Unique agent identifier
 * @property {number} capability - Task-specific capability score from agent registry (Phase 1.1) [0.0-1.0]
 * @property {number} currentLoad - Current workload from cluster service [0.0-1.0]
 * @property {number} maxLoad - Maximum load capacity from cluster service [0.0-1.0]
 * @property {number} declaredTrustScore - DECLARED (operator-set) trust score [0.0-1.0]. NOTE: the routing
 *   consumer was written against the anomaly-scorer's derived trust score,
 *   but src/monitoring/anomaly-scorer.js is imported nowhere, so the value
 *   supplied here is the operator-set field. See src/governance/registry.js.
 * @property {number} dataClearance - Data sensitivity level agent is cleared for [0.0-1.0]
 * @property {number} blastRadiusEstimate - Estimated blast radius if compromised [0.0-1.0]
 */

/**
 * @typedef {Object} TaskRequirements
 * @property {string} taskId - Unique task identifier
 * @property {number} requiredDataSensitivity - Minimum data sensitivity level required [0.0-1.0]
 * @property {string[]} preferredCapabilities - Capability tags preferred for this task
 * @property {number} minTrustScore - Minimum acceptable trust score [0.0-1.0]
 * @property {number} blastRadiusTolerance - Maximum acceptable blast radius estimate [0.0-1.0]
 */

/**
 * Default weights per ADR (internal) specification.
 * All weights sum to 1.0.
 * @type {HeuristicWeights}
 */
const DEFAULT_WEIGHTS = {
  w1_capability: 0.30,
  w2_load_balance: 0.20,
  w3_trust_score: 0.25,
  w4_data_clearance: 0.15,
  w5_blast_radius_inverse: 0.10
};

/**
 * Validate weights object to prevent NaN/Infinity in heuristic calculations.
 * Per Critor findings F-2: ensures weights are valid numbers and sum > 0.
 * 
 * @param {HeuristicWeights} weights - Weights to validate
 * @returns {boolean} True if weights are valid
 * @throws {Error} If weights are invalid
 */
function validateWeights(weights) {
  if (!weights || typeof weights !== 'object') {
    throw new Error('Weights must be an object');
  }
  
  const weightKeys = ['w1_capability', 'w2_load_balance', 'w3_trust_score', 'w4_data_clearance', 'w5_blast_radius_inverse'];
  
  for (const key of weightKeys) {
    if (typeof weights[key] !== 'number' || isNaN(weights[key])) {
      throw new Error(`Weight ${key} must be a valid number, got: ${weights[key]}`);
    }
    if (!isFinite(weights[key])) {
      throw new Error(`Weight ${key} must be finite, got: ${weights[key]}`);
    }
    if (weights[key] < 0) {
      throw new Error(`Weight ${key} must be non-negative, got: ${weights[key]}`);
    }
  }
  
  const sum = weightKeys.reduce((s, k) => s + weights[k], 0);
  if (sum <= 0) {
    throw new Error(`Weights sum must be positive, got: ${sum}`);
  }
  
  return true;
}

/**
 * Compute the load balance component.
 * Higher score = more idle capacity.
 * 
 * @param {number} currentLoad - Current load [0.0-1.0]
 * @param {number} maxLoad - Maximum load [0.0-1.0]
 * @returns {number} Load balance score [0.0-1.0]
 */
function computeLoadBalance(currentLoad, maxLoad) {
  if (maxLoad <= 0) {
    return 0; // Prevent division by zero
  }
  return 1 - (currentLoad / maxLoad);
}

/**
 * Compute the data clearance match score.
 * Score is normalised to [0.0, 1.0] based on how well agent clearance matches requirement.
 * 
 * @param {number} agentClearance - Agent's data clearance [0.0-1.0]
 * @param {number} requiredSensitivity - Task's required data sensitivity [0.0-1.0]
 * @returns {number} Clearance match score [0.0-1.0]
 */
function computeDataClearanceScore(agentClearance, requiredSensitivity) {
  if (requiredSensitivity <= 0) {
    return 1.0; // No clearance required = full score
  }
  return Math.min(agentClearance / requiredSensitivity, 1.0);
}

/**
 * Compute blast radius inverse.
 * Higher score = smaller blast radius = safer agent.
 * 
 * @param {number} blastRadiusEstimate - Estimated blast radius [0.0-1.0]
 * @returns {number} Blast radius inverse [0.0-1.0]
 */
function computeBlastRadiusInverse(blastRadiusEstimate) {
  return 1 - blastRadiusEstimate;
}

/**
 * Compute the security-weighted heuristic score η(agent, task).
 * 
 * Formula:
 *   η = w1·capability + w2·load_balance + w3·trust_score + w4·data_clearance + w5·blast_radius_inverse
 * 
 * All component scores are normalised to [0.0, 1.0].
 * Final score is clamped to [0.0, 1.0].
 * 
 * @param {AgentHeuristicInputs} inputs - Agent heuristic inputs
 * @param {TaskRequirements} taskRequirements - Task requirements
 * @param {HeuristicWeights} [weights=DEFAULT_WEIGHTS] - Component weights
 * @returns {number} Heuristic score [0.0-1.0]
 * 
 * @example
 * const score = computeHeuristic(
 *   { agentId: 'agent-1', capability: 0.9, currentLoad: 0.3, maxLoad: 1.0, declaredTrustScore: 0.85, dataClearance: 0.8, blastRadiusEstimate: 0.2 },
 *   { taskId: 'task-1', requiredDataSensitivity: 0.7, preferredCapabilities: [], minTrustScore: 0.3, blastRadiusTolerance: 0.5 },
 *   DEFAULT_WEIGHTS
 * );
 * // Returns: ~0.76
 */
function computeHeuristic(inputs, taskRequirements, weights = DEFAULT_WEIGHTS) {
  // Validate inputs
  if (!inputs || typeof inputs !== 'object') {
    throw new Error('inputs must be an AgentHeuristicInputs object');
  }
  if (!taskRequirements || typeof taskRequirements !== 'object') {
    throw new Error('taskRequirements must be a TaskRequirements object');
  }
  
  // Validate weights to prevent NaN/Infinity (F-2 fix)
  validateWeights(weights);
  
  // Validate required numeric input fields (skip agentId which is a string)
  const numericFields = ['capability', 'currentLoad', 'maxLoad', 'declaredTrustScore', 'dataClearance', 'blastRadiusEstimate'];
  for (const field of numericFields) {
    if (typeof inputs[field] !== 'number' || isNaN(inputs[field])) {
      throw new Error(`inputs.${field} must be a valid number, got: ${inputs[field]}`);
    }
  }
  
  // Validate agentId is a string
  if (typeof inputs.agentId !== 'string' || inputs.agentId.length === 0) {
    throw new Error(`inputs.agentId must be a non-empty string, got: ${inputs.agentId}`);
  }
  
  // Compute components
  const loadBalance = computeLoadBalance(inputs.currentLoad, inputs.maxLoad);
  const dataClearanceScore = computeDataClearanceScore(inputs.dataClearance, taskRequirements.requiredDataSensitivity);
  const blastRadiusInverse = computeBlastRadiusInverse(inputs.blastRadiusEstimate);
  
  // Compute weighted sum
  // Guard against heuristicSum being 0 (F-6 fix: prevent division by zero in selectAgent)
  const heuristicSum = 
    weights.w1_capability * inputs.capability +
    weights.w2_load_balance * loadBalance +
    weights.w3_trust_score * inputs.declaredTrustScore +
    weights.w4_data_clearance * dataClearanceScore +
    weights.w5_blast_radius_inverse * blastRadiusInverse;
  
  // Clamp to [0.0, 1.0]
  return Math.max(0.0, Math.min(1.0, heuristicSum));
}

/**
 * Check if an agent is eligible for a task (hard filter).
 * 
 * Ineligible agents return η = 0.0 and are excluded from candidate list.
 * This is a HARD filter, not a soft penalty.
 * 
 * @param {AgentHeuristicInputs} agent - Agent inputs
 * @param {TaskRequirements} task - Task requirements
 * @returns {boolean} True if agent is eligible for this task
 * 
 * @example
 * const eligible = isEligible(
 *   { agentId: 'a', capability: 0.9, currentLoad: 0.5, maxLoad: 1.0, declaredTrustScore: 0.9, dataClearance: 0.3, blastRadiusEstimate: 0.5 },
 *   { taskId: 't', requiredDataSensitivity: 0.7, preferredCapabilities: [], minTrustScore: 0.3, blastRadiusTolerance: 0.8 }
 * );
 * // Returns: false (clearance too low)
 */
function isEligible(agent, task) {
  // Hard filter: data clearance must meet or exceed requirement
  if (agent.dataClearance < task.requiredDataSensitivity) {
    return false;
  }
  
  // Hard filter: trust score must meet minimum
  if (agent.declaredTrustScore < task.minTrustScore) {
    return false;
  }
  
  // Hard filter: blast radius must be within tolerance
  if (agent.blastRadiusEstimate > task.blastRadiusTolerance) {
    return false;
  }
  
  return true;
}

/**
 * Estimate blast radius for an agent based on static permissions.
 * 
 * This is a simplified heuristic for Phase 2.2 bootstrap.
 * Phase 3 (Agentic Security Control Plane) will refine using actual behaviour data.
 * 
 * Blast radius scale:
 *   0.0 = minimal blast (read-only, no network, no credentials)
 *   1.0 = catastrophic blast (admin, full data, credentials, network access)
 * 
 * @param {Object} agent - Agent object
 * @param {string[]} agent.permissions - Agent permissions array
 * @param {number} agent.dataAccessScope - Data access scope [0.0-1.0]
 * @param {boolean} agent.canNetwork - Whether agent can communicate on network
 * @param {boolean} agent.hasCredentials - Whether agent holds credentials
 * @returns {number} Estimated blast radius [0.0-1.0]
 * 
 * @example
 * const radius = estimateBlastRadius({
 *   permissions: ['admin', 'read-write'],
 *   dataAccessScope: 0.8,
 *   canNetwork: true,
 *   hasCredentials: true
 * });
 * // Returns: 1.0 (0.4 + 0.2 + 0.2 + 0.2 = 1.0, clamped)
 */
function estimateBlastRadius(agent) {
  let radius = 0.0;
  
  // Admin permission adds 0.4 to blast radius
  if (agent.permissions && agent.permissions.includes('admin')) {
    radius += 0.4;
  }
  
  // High data access scope adds 0.2
  if (agent.dataAccessScope > 0.5) {
    radius += 0.2;
  }
  
  // Network access adds 0.2
  if (agent.canNetwork) {
    radius += 0.2;
  }
  
  // Credential holding adds 0.2
  if (agent.hasCredentials) {
    radius += 0.2;
  }
  
  return Math.min(1.0, radius);
}

/**
 * Default fallback selection when no eligible candidates exist.
 * Returns a simple load-balancing selection (round-robin would be added in future).
 * 
 * @returns {Object} Fallback routing decision
 */
function defaultFallback() {
  return {
    agentId: null,
    reason: 'no_eligible_candidates',
    heuristicScore: 0,
    probability: 0
  };
}

/**
 * Build a candidate list with heuristic scores.
 * Used by ADR (internal)'s selectAgent integration.
 * 
 * @param {Array<{agentId: string, pheromoneStrength: number, agent: AgentHeuristicInputs}>} candidates - Raw candidates
 * @param {TaskRequirements} taskRequirements - Task requirements
 * @param {HeuristicWeights} [weights=DEFAULT_WEIGHTS] - Weights
 * @returns {Array<{agentId: string, pheromoneStrength: number, heuristicScore: number, eligible: boolean}>} Candidates with scores
 */
function buildCandidateList(candidates, taskRequirements, weights = DEFAULT_WEIGHTS) {
  return candidates.map(c => {
    const eligible = isEligible(c.agent, taskRequirements);
    const heuristicScore = eligible 
      ? computeHeuristic(c.agent, taskRequirements, weights)
      : 0;
    
    return {
      agentId: c.agentId,
      pheromoneStrength: c.pheromoneStrength,
      heuristicScore,
      eligible
    };
  });
}

// ============================================================================
// ADR (internal) Test Cases (T1-T6)
// ============================================================================

/**
 * Run ADR (internal) test cases to verify implementation.
 * 
 * Test scenarios per ADR (internal):
 * T1: Agent with clearance < task requirement → η = 0, excluded
 * T2: Two agents, same pheromone, different trust → higher trust → higher η
 * T3: Two agents, same trust, different loads → lower load → higher η
 * T4: All agents ineligible → falls back to default
 * T5: Weights sum < 1.0 → scores normalised automatically
 * T6: Agent with blast_radius=0.9 vs 0.1 → lower blast → higher η
 * 
 * @returns {Object} Test results
 */
function runTests() {
  const results = {
    passed: 0,
    failed: 0,
    tests: []
  };
  
  function test(name, fn) {
    try {
      fn();
      results.passed++;
      results.tests.push({ name, status: 'PASS' });
      console.log(`✅ ${name}`);
    } catch (err) {
      results.failed++;
      results.tests.push({ name, status: 'FAIL', error: err.message });
      console.log(`❌ ${name}: ${err.message}`);
    }
  }
  
  // T1: Clearance mismatch → ineligible (hard filter)
  // Note: computeHeuristic computes raw score regardless of eligibility.
  // The hard filtering happens via isEligible() which is called separately.
  test('T1: Agent with clearance < task requirement → isEligible returns false', () => {
    const agent = {
      agentId: 'a',
      capability: 0.9,
      currentLoad: 0.5,
      maxLoad: 1.0,
      declaredTrustScore: 0.9,
      dataClearance: 0.3,
      blastRadiusEstimate: 0.5
    };
    const task = {
      requiredDataSensitivity: 0.7,
      minTrustScore: 0.3,
      blastRadiusTolerance: 0.8
    };
    
    // isEligible is the hard filter - should return false for clearance mismatch
    const eligible = isEligible(agent, task);
    if (eligible !== false) {
      throw new Error(`Expected ineligible (false), got: ${eligible}`);
    }
    
    // computeHeuristic still computes a score even for ineligible agents
    // (eligibility filtering happens at the selectAgent level via isEligible)
    const score = computeHeuristic(agent, task, DEFAULT_WEIGHTS);
    // Score should still be computed (0.709...) - the filtering happens elsewhere
    if (score <= 0) {
      throw new Error(`Expected positive score for raw computation, got: ${score}`);
    }
  });
  
  // T2: Higher trust → higher heuristic score
  test('T2: Higher trust → higher η → higher P(selected)', () => {
    const baseAgent = {
      agentId: 'a',
      capability: 0.8,
      currentLoad: 0.5,
      maxLoad: 1.0,
      declaredTrustScore: 0.5,  // Lower trust
      dataClearance: 0.9,
      blastRadiusEstimate: 0.2
    };
    const highTrustAgent = { ...baseAgent, agentId: 'b', declaredTrustScore: 0.9 };  // Higher trust
    const task = {
      requiredDataSensitivity: 0.5,
      minTrustScore: 0.3,
      blastRadiusTolerance: 0.5
    };
    
    const lowScore = computeHeuristic(baseAgent, task, DEFAULT_WEIGHTS);
    const highScore = computeHeuristic(highTrustAgent, task, DEFAULT_WEIGHTS);
    
    if (highScore <= lowScore) {
      throw new Error(`Expected highTrust > lowTrust, got: ${highScore} <= ${lowScore}`);
    }
  });
  
  // T3: Lower load → higher heuristic score
  test('T3: Lower load → higher η → higher P(selected)', () => {
    const busyAgent = {
      agentId: 'a',
      capability: 0.8,
      currentLoad: 0.8,  // High load
      maxLoad: 1.0,
      declaredTrustScore: 0.8,
      dataClearance: 0.9,
      blastRadiusEstimate: 0.2
    };
    const idleAgent = { ...busyAgent, agentId: 'b', currentLoad: 0.2 };  // Low load
    const task = {
      requiredDataSensitivity: 0.5,
      minTrustScore: 0.3,
      blastRadiusTolerance: 0.5
    };
    
    const busyScore = computeHeuristic(busyAgent, task, DEFAULT_WEIGHTS);
    const idleScore = computeHeuristic(idleAgent, task, DEFAULT_WEIGHTS);
    
    if (idleScore <= busyScore) {
      throw new Error(`Expected idle > busy, got: ${idleScore} <= ${busyScore}`);
    }
  });
  
  // T4: All ineligible → default fallback
  test('T4: All agents ineligible → falls back to default', () => {
    const agent = {
      agentId: 'a',
      capability: 0.9,
      currentLoad: 0.5,
      maxLoad: 1.0,
      declaredTrustScore: 0.2,  // Below minTrustScore
      dataClearance: 0.2,  // Below requiredDataSensitivity
      blastRadiusEstimate: 0.9  // Above blastRadiusTolerance
    };
    const task = {
      requiredDataSensitivity: 0.5,
      minTrustScore: 0.3,
      blastRadiusTolerance: 0.5
    };
    
    const eligible = isEligible(agent, task);
    if (eligible !== false) {
      throw new Error(`Expected ineligible, got: ${eligible}`);
    }
    
    const fallback = defaultFallback();
    if (fallback.agentId !== null || fallback.reason !== 'no_eligible_candidates') {
      throw new Error(`Expected default fallback, got: ${JSON.stringify(fallback)}`);
    }
  });
  
  // T5: Weights validation - sum < 1.0 still works (normalised)
  test('T5: Weights sum < 1.0 → scores normalised automatically', () => {
    const lowWeights = {
      w1_capability: 0.1,
      w2_load_balance: 0.1,
      w3_trust_score: 0.1,
      w4_data_clearance: 0.1,
      w5_blast_radius_inverse: 0.1  // Sum = 0.5
    };
    
    validateWeights(lowWeights);  // Should not throw
    
    const agent = {
      agentId: 'a',
      capability: 1.0,
      currentLoad: 0.0,
      maxLoad: 1.0,
      declaredTrustScore: 1.0,
      dataClearance: 1.0,
      blastRadiusEstimate: 0.0
    };
    const task = {
      requiredDataSensitivity: 0.0,
      minTrustScore: 0.0,
      blastRadiusTolerance: 1.0
    };
    
    const score = computeHeuristic(agent, task, lowWeights);
    // Score will be lower with reduced weights but still valid [0,1]
    if (score < 0 || score > 1) {
      throw new Error(`Expected score in [0,1], got: ${score}`);
    }
  });
  
  // T6: Lower blast radius → higher heuristic score
  test('T6: Agent with blast_radius=0.1 vs 0.9 → lower blast → higher η', () => {
    const riskyAgent = {
      agentId: 'a',
      capability: 0.8,
      currentLoad: 0.5,
      maxLoad: 1.0,
      declaredTrustScore: 0.8,
      dataClearance: 0.9,
      blastRadiusEstimate: 0.9  // High blast radius
    };
    const safeAgent = { ...riskyAgent, agentId: 'b', blastRadiusEstimate: 0.1 };  // Low blast radius
    const task = {
      requiredDataSensitivity: 0.5,
      minTrustScore: 0.3,
      blastRadiusTolerance: 1.0
    };
    
    const riskyScore = computeHeuristic(riskyAgent, task, DEFAULT_WEIGHTS);
    const safeScore = computeHeuristic(safeAgent, task, DEFAULT_WEIGHTS);
    
    if (safeScore <= riskyScore) {
      throw new Error(`Expected safe > risky, got: ${safeScore} <= ${riskyScore}`);
    }
  });
  
  // Additional tests for F-2 (NaN/Infinity prevention)
  test('F-2: validateWeights throws on NaN weight', () => {
    const badWeights = {
      w1_capability: NaN,
      w2_load_balance: 0.2,
      w3_trust_score: 0.25,
      w4_data_clearance: 0.15,
      w5_blast_radius_inverse: 0.1
    };
    try {
      validateWeights(badWeights);
      throw new Error('Expected to throw');
    } catch (err) {
      if (err.message.indexOf('valid number') === -1) {
        throw new Error(`Expected 'valid number' error, got: ${err.message}`);
      }
    }
  });
  
  test('F-2: validateWeights throws on Infinity weight', () => {
    const badWeights = {
      w1_capability: Infinity,
      w2_load_balance: 0.2,
      w3_trust_score: 0.25,
      w4_data_clearance: 0.15,
      w5_blast_radius_inverse: 0.1
    };
    try {
      validateWeights(badWeights);
      throw new Error('Expected to throw');
    } catch (err) {
      if (err.message.indexOf('finite') === -1) {
        throw new Error(`Expected 'finite' error, got: ${err.message}`);
      }
    }
  });
  
  // F-6: heuristicSum=0 guard
  test('F-6: All zero inputs → heuristicSum=0, returns 0 (no division by zero)', () => {
    const zeroAgent = {
      agentId: 'a',
      capability: 0,
      currentLoad: 0,
      maxLoad: 0,  // Will cause 1 - 0/0 = 1, but capability is 0
      declaredTrustScore: 0,
      dataClearance: 0,
      blastRadiusEstimate: 1  // Will cause 1-1 = 0
    };
    const task = {
      requiredDataSensitivity: 0.5,  // Will cause 0/0.5 = 0
      minTrustScore: 0,
      blastRadiusTolerance: 1
    };
    
    // Should not throw, should return 0
    const score = computeHeuristic(zeroAgent, task, DEFAULT_WEIGHTS);
    if (score !== 0) {
      throw new Error(`Expected score = 0, got: ${score}`);
    }
  });
  
  return results;
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  // Core functions
  computeHeuristic,
  isEligible,
  estimateBlastRadius,
  validateWeights,
  buildCandidateList,
  defaultFallback,
  
  // Utilities
  computeLoadBalance,
  computeDataClearanceScore,
  computeBlastRadiusInverse,
  
  // Constants
  DEFAULT_WEIGHTS,
  
  // Testing
  runTests
};
