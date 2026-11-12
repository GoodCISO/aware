/**
 * ADR (internal): Phase 2.1 — Task-Specific Pheromone Specialists
 * 
 * Implements AMRO-S ACO routing with task-specific pheromone specialist matrices.
 * Prevents cross-task pheromone contamination (40-60% routing degradation in mixed-task envs).
 * 
 * @module routing/pheromone-table
 * @author Coder (Coder)
 * @license GPL-3.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// Constants
// ============================================================================

/**
 * Task categories per ADR (internal) §Task Category Definitions.
 * @enum {string}
 */
const TaskCategory = {
  CODE_GENERATION: 'code-generation',
  RESEARCH: 'research',
  SECURITY_REVIEW: 'security-review',
  DATA_ANALYSIS: 'data-analysis',
  COORDINATION: 'coordination',
  // NOTES_TO_REVIEWER — content the user wants surfaced as editorial /
  // review notes (reviewer guidance, inline feedback, "please review" intent).
  // Triggers a separate pheromone matrix so review-note traffic does NOT
  // contaminate code-generation routing (similar isolation rationale as
  // SECURITY_REVIEW vs CODE_GENERATION).
  NOTES_TO_REVIEWER: 'notes-to-reviewer',
  DISCLAIMER_PILING: 'disclaimer-piling',  // t_9881cd1d: stacked/over-redundant disclaimer content
  GENERAL: 'general'
};

/**
 * AMRO-S soft-max exponents (ADR (internal) F-5 fix).
 * ALPHA = pheromone exponent, BETA = heuristic exponent.
 * Both configurable via environment variables or config/heuristic-weights.yaml.
 */
const ALPHA = parseFloat(process.env.AMRO_ALPHA) || 1.0;
const BETA = parseFloat(process.env.AMRO_BETA) || 1.0;

/**
 * Minimum pheromone strength before pruning (ADR (internal) §Evaporate).
 */
const PHEROMONE_MIN = 0.01;

/**
 * Maximum agents per pheromone matrix (OQ-5 decision: hard limit).
 */
const MAX_AGENTS_PER_MATRIX = parseInt(process.env.MAX_AGENTS_PER_MATRIX) || 1000;

/**
 * Default fallback prevHash for genesis record.
 */
const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

// ============================================================================
// In-Memory Storage
// ============================================================================

/**
 * In-memory pheromone tables keyed by task category.
 * @type {Map<string, PheromoneMatrix>}
 */
const tables = new Map();

/**
 * Persistence path for pheromone data.
 * @type {string}
 */
const PHEROMONE_DIR = process.env.PHEROMONE_DIR || '/data/pheromones';

/**
 * Load pheromone tables from disk on startup.
 */
function loadFromDisk() {
  if (!fs.existsSync(PHEROMONE_DIR)) {
    fs.mkdirSync(PHEROMONE_DIR, { recursive: true });
    return;
  }
  
  for (const category of Object.values(TaskCategory)) {
    const filePath = path.join(PHEROMONE_DIR, `${category}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        tables.set(category, data);
        console.log(`[pheromone-table] Loaded ${category}: ${tables.get(category).agents.size} agents, ${tables.get(category).transitions.size} transitions`);
      } catch (err) {
        console.error(`[pheromone-table] Failed to load ${category}: ${err.message}`);
      }
    }
  }
}

/**
 * Persist a pheromone table to disk.
 * @param {string} category 
 */
function persistTable(category) {
  const table = tables.get(category);
  if (!table) return;
  
  const filePath = path.join(PHEROMONE_DIR, `${category}.json`);
  fs.writeFileSync(filePath, JSON.stringify(table, null, 2));
}

// ============================================================================
// Data Model
// ============================================================================

/**
 * @typedef {Object} PheromoneMatrix
 * @property {string} category - Task category
 * @property {Map<string, number>} transitions - fromAgentId → toAgentId → pheromone strength
 * @property {Map<string, number>} agents - agentId → pheromone strength (terminal nodes)
 * @property {Date} updatedAt
 * @property {number} decayRate - Per-hour decay coefficient
 * @property {number} version - Optimistic concurrency control
 */

/**
 * Create a new pheromone matrix for a category.
 * @param {string} category 
 * @param {number} decayRate - Per-hour decay rate
 * @returns {PheromoneMatrix}
 */
function createTable(category, decayRate) {
  return {
    category,
    transitions: new Map(),  // fromAgentId → Map(toAgentId → strength)
    agents: new Map(),       // agentId → strength
    updatedAt: new Date(),
    decayRate: decayRate || getDefaultDecayRate(category),
    version: 1
  };
}

/**
 * Get default decay rate per task category (ADR (internal) §Per-Category Decay Rates).
 * @param {string} category 
 * @returns {number} Per-hour decay rate
 */
function getDefaultDecayRate(category) {
  const rates = {
    [TaskCategory.CODE_GENERATION]: 0.15,
    [TaskCategory.RESEARCH]: 0.05,
    [TaskCategory.SECURITY_REVIEW]: 0.20,
    [TaskCategory.DATA_ANALYSIS]: 0.03,
    [TaskCategory.COORDINATION]: 0.30,
    // NOTES_TO_REVIEWER: slower decay (0.07) — review-note patterns are
    // durable across sessions (a style note flagged today still applies
    // tomorrow). Sits between RESEARCH (0.05, very long-lived knowledge)
    // and GENERAL (0.10, short-lived catch-all).
    [TaskCategory.NOTES_TO_REVIEWER]: 0.07,
    [TaskCategory.DISCLAIMER_PILING]: 0.25,  // t_9881cd1d: medium-fast decay — content drifts as model updates ship
    [TaskCategory.GENERAL]: 0.10
  };
  return rates[category] || 0.10;
}

/**
 * Get or create pheromone table for a category.
 * @param {string} category 
 * @returns {PheromoneMatrix}
 */
function getOrCreateTable(category) {
  if (!tables.has(category)) {
    tables.set(category, createTable(category));
  }
  return tables.get(category);
}

/**
 * Get pheromone table for a category (returns undefined if not exists).
 * @param {string} category 
 * @returns {PheromoneMatrix|undefined}
 */
function getTable(category) {
  return tables.get(category);
}

/**
 * Get all pheromone tables.
 * @returns {PheromoneMatrix[]}
 */
function allTables() {
  return Array.from(tables.values());
}

// ============================================================================
// Pheromone Operations
// ============================================================================

/**
 * Set a transition pheromone value.
 * @param {PheromoneMatrix} table 
 * @param {string} from 
 * @param {string} to 
 * @param {number} strength 
 */
function setTransition(table, from, to, strength) {
  if (!table.transitions.has(from)) {
    table.transitions.set(from, new Map());
  }
  table.transitions.get(from).set(to, strength);
}

/**
 * Get a transition pheromone value.
 * @param {PheromoneMatrix} table 
 * @param {string} from 
 * @param {string} to 
 * @returns {number}
 */
function getTransition(table, from, to) {
  return table.transitions.get(from)?.get(to) ?? 0.0;
}

/**
 * Log pheromone deposit being skipped (quality/security gate failed).
 * @param {Object} deposit 
 */
function logPheromoneSkipped(deposit) {
  console.log(`[pheromone-table] SKIPPED deposit: task=${deposit.taskCategory} taskId=${deposit.taskId} reason=gate_failed`);
}

/**
 * Log pheromone penalty applied.
 * @param {Object} deposit 
 * @param {number} penalty 
 */
function logPheromonePenalty(deposit, penalty) {
  console.log(`[pheromone-table] PENALTY: task=${deposit.taskCategory} taskId=${deposit.taskId} penalty=${penalty}`);
}

/**
 * Deposit pheromone for a completed task path.
 * 
 * AMRO-S reinforcement formula: τ_new = (1-ρ)·τ_old + Δτ
 * Where Δτ = w_t(q) · Q / (f_sys(P) + ε)
 * 
 * AWARE extension: combined quality-security score.
 * 
 * @param {Object} deposit - PheromoneDeposit from ADR (internal) §Pheromone Deposit
 * @returns {void}
 */
function depositPheromone(deposit) {
  const { taskCategory, pathAgents, qualityGate, securityGate } = deposit;
  
  // Phase 2.3 quality gate must pass before reinforcement
  if (!qualityGate.passed || !securityGate.passed) {
    logPheromoneSkipped(deposit);
    return;
  }
  
  const table = getOrCreateTable(taskCategory);
  
  // Combined quality-security score (ADR (internal) defines exact weights)
  // w_quality = 0.7, w_security = 0.3
  const qualityWeight = 0.7;
  const securityWeight = 0.3;
  const combinedScore = 
    (qualityGate.qualityScore * qualityWeight) +
    ((securityGate.contentFilterPassed ? 1.0 : 0.0) * securityWeight);
  
  // AMRO-S reinforcement: τ_new = (1-ρ)·τ_old + (1-τ_old)·Δτ
  // Simplified to: τ_new = τ_old + (1-τ_old)·reinforcement
  const reinforcement = combinedScore;
  
  // Check agent limit (OQ-5)
  if (table.agents.size >= MAX_AGENTS_PER_MATRIX) {
    console.warn(`[pheromone-table] Agent limit reached for ${taskCategory}, skipping deposit`);
    return;
  }
  
  // Update transition pheromones (fromAgent → toAgent)
  for (let i = 0; i < pathAgents.length - 1; i++) {
    const from = pathAgents[i];
    const to = pathAgents[i + 1];
    const current = getTransition(table, from, to);
    const updated = current + (1 - current) * reinforcement;
    setTransition(table, from, to, updated);
  }
  
  // Update terminal agent pheromone (last agent in path)
  const terminalAgent = pathAgents[pathAgents.length - 1];
  const terminalCurrent = table.agents.get(terminalAgent) ?? 0.0;
  table.agents.set(terminalAgent, terminalCurrent + (1 - terminalCurrent) * reinforcement);
  
  table.updatedAt = new Date();
  table.version++;
  
  // Persist asynchronously
  setImmediate(() => persistTable(taskCategory));
}

/**
 * Apply negative reinforcement for policy violations.
 * 
 * @param {Object} deposit - PheromoneDeposit
 * @param {number} violationSeverity - 0.0–1.0, higher = more severe
 * @returns {void}
 */
function applyNegativeReinforcement(deposit, violationSeverity = 1.0) {
  const { taskCategory, pathAgents } = deposit;
  
  // Penalty proportional to severity: severity 1.0 → 50% reduction
  const penalty = violationSeverity * 0.5;
  
  const table = getOrCreateTable(taskCategory);
  
  // Reduce terminal agent pheromones
  for (const agentId of pathAgents) {
    const current = table.agents.get(agentId) ?? 0.0;
    table.agents.set(agentId, current * (1 - penalty));
  }
  
  // Reduce transition pheromones
  for (let i = 0; i < pathAgents.length - 1; i++) {
    const from = pathAgents[i];
    const to = pathAgents[i + 1];
    const current = getTransition(table, from, to);
    setTransition(table, from, to, current * (1 - penalty));
  }
  
  table.updatedAt = new Date();
  table.version++;
  
  logPheromonePenalty(deposit, penalty);
  setImmediate(() => persistTable(taskCategory));
}

/**
 * Evaporate pheromones periodically.
 * 
 * AMRO-S: τ_new = (1-ρ)·τ_old
 * Trails below PHEROMONE_MIN are pruned.
 * 
 * ADR (internal) F-1 fix: use table.agents and table.transitions, not table.trails.
 * 
 * @returns {void}
 */
function evaporatePheromones() {
  for (const table of allTables()) {
    const decayPerSecond = table.decayRate / 3600;  // per-second decay
    
    // Evaporate agent pheromones
    for (const [agentId, strength] of table.agents) {
      const evaporated = strength * (1 - decayPerSecond);
      if (evaporated < PHEROMONE_MIN) {
        table.agents.delete(agentId);  // prune near-zero trails
      } else {
        table.agents.set(agentId, evaporated);
      }
    }
    
    // Evaporate transition pheromones
    for (const [from, toMap] of table.transitions) {
      for (const [to, strength] of toMap) {
        const evaporated = strength * (1 - decayPerSecond);
        if (evaporated < PHEROMONE_MIN) {
          toMap.delete(to);  // prune near-zero trails
        } else {
          toMap.set(to, evaporated);
        }
      }
      // Clean up empty transition maps
      if (toMap.size === 0) {
        table.transitions.delete(from);
      }
    }
    
    table.updatedAt = new Date();
    table.version++;
  }
}

/**
 * Initialise evaporation job.
 * Runs every 60 seconds per ADR (internal) §Evaporate.
 * 
 * @returns {IntervalHandle}
 */
function startEvaporationJob() {
  return setInterval(() => {
    try {
      evaporatePheromones();
    } catch (err) {
      console.error(`[pheromone-table] Evaporation error: ${err.message}`);
    }
  }, 60 * 1000);  // 60 seconds
}

// ============================================================================
// Agent Selection (AMRO-S Soft-Max)
// ============================================================================

/**
 * @typedef {Object} RoutingCandidate
 * @property {string} agentId
 * @property {number} pheromoneStrength
 * @property {number} heuristicScore
 */

/**
 * Weighted random selection using soft-max probabilities.
 * 
 * @param {Array<{agentId: string, probability: number}>} candidates
 * @returns {string|null}
 */
function weightedRandomSelect(candidates) {
  const total = candidates.reduce((s, c) => s + c.probability, 0);
  if (total <= 0) return null;
  
  // SC-HIGH-005: routing jitter; not a security primitive.
  let r = crypto.randomInt(0, total);
  for (const c of candidates) {
    r -= c.probability;
    if (r <= 0) return c.agentId;
  }
  return candidates[candidates.length - 1].agentId;
}

/**
 * Build candidate list from pheromone table.
 * 
 * @param {PheromoneMatrix} table
 * @returns {Array<{agentId: string, pheromoneStrength: number}>}
 */
function buildCandidateList(table) {
  const candidates = [];
  
  // Terminal agents (no outgoing transition)
  for (const [agentId, pheromone] of table.agents) {
    candidates.push({ agentId, pheromoneStrength: pheromone });
  }
  
  // Agents reachable via transitions from other agents
  for (const [from, toMap] of table.transitions) {
    for (const [to, pheromone] of toMap) {
      if (!candidates.find(c => c.agentId === to)) {
        candidates.push({ agentId: to, pheromoneStrength: pheromone });
      }
    }
  }
  
  return candidates;
}

/**
 * Select an agent using AMRO-S soft-max probabilistic selection.
 * 
 * P(agent) ∝ exp(α · τ_agent) × exp(β · η_agent)
 * 
 * ADR (internal) F-2 fix: ADR (internal) is APPROVED — use ADR (internal) weights.
 * 
 * @param {string} taskCategory
 * @param {Object} task - Task object with heuristic inputs
 * @param {Function} computeHeuristic - Heuristic function from ADR (internal)
 * @returns {RoutingCandidate|null}
 */
function selectAgent(taskCategory, task, computeHeuristic) {
  const table = getTable(taskCategory);
  if (!table || (table.transitions.size === 0 && table.agents.size === 0)) {
    return defaultFallback();
  }
  
  const candidates = buildCandidateList(table);
  if (candidates.length === 0) {
    return defaultFallback();
  }
  
  // Compute pheromone sum for normalisation
  const pheromoneSum = candidates.reduce((s, c) => s + c.pheromoneStrength, 0);
  
  // Compute heuristic scores using ADR (internal) function
  const candidatesWithHeuristic = candidates.map(c => {
    let heuristicScore = 0;
    try {
      heuristicScore = computeHeuristic(c.agentId, task);
    } catch (err) {
      console.warn(`[pheromone-table] Heuristic computation failed for ${c.agentId}: ${err.message}`);
    }
    return { ...c, heuristicScore };
  });
  
  const heuristicSum = candidatesWithHeuristic.reduce((s, c) => s + c.heuristicScore, 0);
  
  // AMRO-S soft-max selection
  const probabilities = candidatesWithHeuristic.map(c => ({
    agentId: c.agentId,
    probability: pheromoneSum > 0
      ? (Math.pow(c.pheromoneStrength / pheromoneSum, ALPHA)) * 
        (heuristicSum > 0 ? Math.pow(c.heuristicScore / heuristicSum, BETA) : 1)
      : 0
  }));
  
  const selectedAgentId = weightedRandomSelect(probabilities);
  if (!selectedAgentId) {
    return defaultFallback();
  }
  
  const selected = candidatesWithHeuristic.find(c => c.agentId === selectedAgentId);
  return {
    agentId: selectedAgentId,
    pheromoneStrength: selected.pheromoneStrength,
    heuristicScore: selected.heuristicScore,
    allScores: candidatesWithHeuristic  // for audit logging
  };
}

/**
 * Default fallback when no pheromone history exists.
 * @returns {Object}
 */
function defaultFallback() {
  return {
    agentId: null,
    reason: 'no_pheromone_history',
    pheromoneStrength: 0,
    heuristicScore: 0,
    probability: 0
  };
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get pheromone table statistics.
 * @param {string} category
 * @returns {Object}
 */
function getStats(category) {
  const table = getTable(category);
  if (!table) {
    return { category, exists: false };
  }
  
  const agentStrengths = Array.from(table.agents.values());
  const transitionStrengths = [];
  for (const toMap of table.transitions.values()) {
    for (const strength of toMap.values()) {
      transitionStrengths.push(strength);
    }
  }
  
  return {
    category,
    exists: true,
    agentCount: table.agents.size,
    transitionCount: Array.from(table.transitions.values()).reduce((s, m) => s + m.size, 0),
    updatedAt: table.updatedAt,
    version: table.version,
    decayRate: table.decayRate,
    maxAgentStrength: agentStrengths.length > 0 ? Math.max(...agentStrengths) : 0,
    avgAgentStrength: agentStrengths.length > 0 ? agentStrengths.reduce((s, v) => s + v, 0) / agentStrengths.length : 0,
    maxTransitionStrength: transitionStrengths.length > 0 ? Math.max(...transitionStrengths) : 0,
    avgTransitionStrength: transitionStrengths.length > 0 ? transitionStrengths.reduce((s, v) => s + v, 0) / transitionStrengths.length : 0
  };
}

/**
 * Get statistics for all categories.
 * @returns {Object[]}
 */
function getAllStats() {
  return Object.values(TaskCategory).map(cat => getStats(cat));
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  // Constants
  TaskCategory,
  ALPHA,
  BETA,
  PHEROMONE_MIN,
  GENESIS_HASH,
  
  // Data model
  createTable,
  getOrCreateTable,
  getTable,
  allTables,
  loadFromDisk,
  
  // Operations
  depositPheromone,
  applyNegativeReinforcement,
  evaporatePheromones,
  startEvaporationJob,
  
  // Selection
  selectAgent,
  buildCandidateList,
  weightedRandomSelect,
  defaultFallback,
  
  // Utilities
  setTransition,
  getTransition,
  getStats,
  getAllStats,
  getDefaultDecayRate
};
