/**
 * ADR (internal): Phase 2.1 — Task Classifier
 * 
 * Rule-based task classification by keyword matching.
 * Classifies incoming tasks into TaskCategory for pheromone routing.
 * 
 * @module routing/task-classifier
 * @author Coder (Coder)
 * @license GPL-3.0
 */

'use strict';

const { TaskCategory } = require('./pheromone-table');

// ============================================================================
// Keyword Patterns
// ============================================================================

/**
 * Keyword patterns for task classification.
 * Per ADR (internal) §Task Category Classification.
 * 
 * @type {Record<string, string[]>}
 */
const KEYWORD_PATTERNS = {
  [TaskCategory.CODE_GENERATION]: [
    'write', 'implement', 'refactor', 'debug', 'test',
    'function', 'class', 'module', 'api', 'endpoint',
    'code', 'script', 'algorithm', 'database', 'query'
  ],
  // NOTES_TO_REVIEWER is checked BEFORE RESEARCH on purpose: keyword
  // matching is case-insensitive substring, and RESEARCH owns the word
  // 'review'. Reviewer-note phrases ("reviewer notes", "flag for
  // review") all contain the substring "review" or "reviewer" and would
  // otherwise match RESEARCH first. We rely on NOTES_TO_REVIEWER's
  // compound phrases being more specific than RESEARCH's single-word
  // 'review' — and on the loop visiting NOTES_TO_REVIEWER first.
  [TaskCategory.NOTES_TO_REVIEWER]: [
    'notes to reviewer', 'reviewer notes',
    'editorial notes', 'feedback notes', 'reviewer feedback',
    'leave a note', 'flag for review', 'note for reviewer'
  ],
  [TaskCategory.RESEARCH]: [
    'research', 'find', 'analyse', 'investigate', 'compare',
    'review', 'survey', 'explore', 'evaluate', 'assess',
    'study', 'search', 'discover', 'understand'
  ],
  [TaskCategory.SECURITY_REVIEW]: [
    'security', 'vulnerability', 'audit', 'penetration',
    'CVE', 'exploit', 'threat', 'risk', 'attack', 'defence',
    'secure', 'protect', 'scan', 'pentest'
  ],
  [TaskCategory.DATA_ANALYSIS]: [
    'data', 'statistics', 'chart', 'graph', 'calculate',
    'trend', 'metric', 'report', 'analytics', 'insight',
    'visualisation', 'aggregation', 'correlation'
  ],
  [TaskCategory.COORDINATION]: [
    'orchestrate', 'coordinate', 'delegate', 'route', 'schedule',
    'assign', 'dispatch', 'manage', 'organise', 'allocate'
  ],
  // GENERAL has no keywords — default fallback
};

/**
 * Case-insensitive keyword matching.
 * 
 * @param {string} text 
 * @param {string[]} keywords 
 * @returns {boolean}
 */
function matchesAnyKeyword(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

// ============================================================================
// Classification
// ============================================================================

/**
 * Classify a task into a TaskCategory by keyword matching.
 * 
 * @param {Object} task - Task object
 * @param {string} task.prompt - Task prompt/description
 * @param {Object} [task.metadata] - Optional task metadata
 * @returns {string} TaskCategory
 * 
 * @example
 * const category = classifyTask({ prompt: 'Write a new API endpoint for user authentication' });
 * // Returns: TaskCategory.CODE_GENERATION
 */
function classifyTask(task) {
  const { prompt, metadata } = task;
  
  if (!prompt || typeof prompt !== 'string') {
    return TaskCategory.GENERAL;
  }
  
  // Check each category (skip GENERAL as it's the default)
  for (const [category, keywords] of Object.entries(KEYWORD_PATTERNS)) {
    if (category === TaskCategory.GENERAL) continue;
    if (matchesAnyKeyword(prompt, keywords)) {
      // Log classification for audit trail (Phase 2.4)
      logClassification(task, category);
      return category;
    }
  }
  
  // Check metadata for category hint
  if (metadata && metadata.taskCategory && Object.values(TaskCategory).includes(metadata.taskCategory)) {
    return metadata.taskCategory;
  }
  
  // Default to GENERAL
  logClassification(task, TaskCategory.GENERAL);
  return TaskCategory.GENERAL;
}

/**
 * Classification audit log entry.
 * @param {Object} task 
 * @param {string} category 
 */
function logClassification(task, category) {
  // TODO: Phase 2.4 — integrate with audit trail
  // For now, just console log for observability
  console.log(`[task-classifier] ${task.prompt?.substring(0, 50)}... → ${category}`);
}

/**
 * Get the priority score for a category (for tie-breaking).
 * Higher priority categories are checked first.
 * 
 * @param {string} category 
 * @returns {number}
 */
function getCategoryPriority(category) {
  const priorities = {
    [TaskCategory.SECURITY_REVIEW]: 100,  // Highest — security is critical
    [TaskCategory.CODE_GENERATION]: 80,
    [TaskCategory.DATA_ANALYSIS]: 60,
    [TaskCategory.RESEARCH]: 40,
    [TaskCategory.NOTES_TO_REVIEWER]: 30,  // Above COORDINATION — reviewer intent outranks routing intent
    [TaskCategory.COORDINATION]: 20,
    [TaskCategory.GENERAL]: 0           // Lowest — default
  };
  return priorities[category] ?? 0;
}

/**
 * Multi-category detection for mixed-intent tasks.
 * Returns array of categories sorted by relevance.
 * 
 * @param {Object} task 
 * @returns {string[]} Sorted array of matching categories
 */
function detectMultipleCategories(task) {
  const { prompt } = task;
  if (!prompt || typeof prompt !== 'string') {
    return [TaskCategory.GENERAL];
  }
  
  const matches = [];
  for (const [category, keywords] of Object.entries(KEYWORD_PATTERNS)) {
    if (category === TaskCategory.GENERAL) continue;
    if (matchesAnyKeyword(prompt, keywords)) {
      matches.push({
        category,
        priority: getCategoryPriority(category),
        score: keywords.filter(k => prompt.toLowerCase().includes(k)).length
      });
    }
  }
  
  // Sort by score desc, then priority desc
  matches.sort((a, b) => b.score - a.score || b.priority - a.priority);
  
  if (matches.length === 0) {
    return [TaskCategory.GENERAL];
  }
  
  return matches.map(m => m.category);
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  TaskCategory,
  KEYWORD_PATTERNS,
  classifyTask,
  detectMultipleCategories,
  getCategoryPriority,
  matchesAnyKeyword
};
