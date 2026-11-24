// test/unit/routing/task-classifier.test.js
//
// Unit tests for src/routing/task-classifier.js covering BOTH new
// classifier categories added in this branch:
//   - `notes-to-reviewer` (t_4f06c7fc, commit a6a1186)
//   - `disclaimer-piling`  (t_9881cd1d, commit e3e97ad)
//
// This file was rewritten under t_c6966800 to cover both categories
// end-to-end. The original t_4f06c7fc file had 12 cases for
// notes-to-reviewer only and one stale assertion ("disclaimer-piling
// is intentionally NOT in the enum") that this rewrite flips.
//
// Verifies:
//   A. Both keys are loaded by AWARE — enum exposure, KEYWORD_PATTERNS
//      registration, getDefaultDecayRate, getCategoryPriority.
//   B. The YAML config doc (config/pheromone-rates.yaml) carries both
//      keys as the documentation mirror of the JS-side rates.
//   C. classifyTask routes canonical phrases for each category to the
//      right value, including first-match-wins ordering quirks.
//   D. Negative case: unrelated content does not trigger either
//      category (falls through to GENERAL).
//   E. metadata.taskCategory passthrough accepts both values, rejects
//      non-enum strings.
//   F. detectMultipleCategories surfaces both when matching.
//
// Acceptance: the test suite is green AND each "should classify X"
// assertion FAILS when the matching category entry is removed from
// KEYWORD_PATTERNS / TaskCategory / decay-rate table (mutation-tested
// in VERIFY section of the worker output).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

// Re-require per test to avoid module-level state leaking between cases.
function loadFresh() {
  const classifierPath = require.resolve('../../../src/routing/task-classifier.js');
  const enumPath = require.resolve('../../../src/routing/pheromone-table.js');
  delete require.cache[classifierPath];
  delete require.cache[enumPath];
  return {
    classifier: require('../../../src/routing/task-classifier.js'),
    pheromone: require('../../../src/routing/pheromone-table.js'),
  };
}

const REPO_ROOT = path.resolve(__dirname, '../../..');

// ============================================================================
// A. Enum & keyword registration — both categories
// ============================================================================

test('TaskCategory enum exposes NOTES_TO_REVIEWER with kebab-case value', () => {
  const { pheromone } = loadFresh();
  assert.strictEqual(pheromone.TaskCategory.NOTES_TO_REVIEWER, 'notes-to-reviewer');
  const values = Object.values(pheromone.TaskCategory);
  assert.ok(values.includes('notes-to-reviewer'),
    `expected 'notes-to-reviewer' in TaskCategory values, got: ${values.join(', ')}`);
});

test('TaskCategory enum exposes DISCLAIMER_PILING with kebab-case value', () => {
  const { pheromone } = loadFresh();
  assert.strictEqual(pheromone.TaskCategory.DISCLAIMER_PILING, 'disclaimer-piling');
  const values = Object.values(pheromone.TaskCategory);
  assert.ok(values.includes('disclaimer-piling'),
    `expected 'disclaimer-piling' in TaskCategory values, got: ${values.join(', ')}`);
});

test('TaskCategory enum has both new categories simultaneously', () => {
  // Regression for t_c6966800: this test fails if either category is
  // removed from the enum (the "either category removed" half of the
  // acceptance).
  const { pheromone } = loadFresh();
  const values = Object.values(pheromone.TaskCategory);
  assert.ok(values.includes('notes-to-reviewer') && values.includes('disclaimer-piling'),
    `expected both 'notes-to-reviewer' and 'disclaimer-piling' in TaskCategory, got: ${values.join(', ')}`);
});

test('KEYWORD_PATTERNS exposes a non-empty notes-to-reviewer list', () => {
  const { classifier } = loadFresh();
  const patterns = classifier.KEYWORD_PATTERNS['notes-to-reviewer'];
  assert.ok(Array.isArray(patterns),
    'expected KEYWORD_PATTERNS["notes-to-reviewer"] to be an array');
  assert.ok(patterns.length >= 3,
    `expected at least 3 keywords for notes-to-reviewer, got ${patterns.length}`);
  // Spot-check canonical phrase.
  assert.ok(patterns.includes('notes to reviewer'),
    `expected 'notes to reviewer' in keyword list, got: ${patterns.join(', ')}`);
});

test('KEYWORD_PATTERNS exposes a non-empty disclaimer-piling list', () => {
  const { classifier } = loadFresh();
  const patterns = classifier.KEYWORD_PATTERNS['disclaimer-piling'];
  assert.ok(Array.isArray(patterns),
    'expected KEYWORD_PATTERNS["disclaimer-piling"] to be an array');
  assert.ok(patterns.length >= 3,
    `expected at least 3 keywords for disclaimer-piling, got ${patterns.length}`);
  // Spot-check canonical phrase (per t_9881cd1d commit message).
  assert.ok(patterns.includes('disclaimer'),
    `expected 'disclaimer' in disclaimer-piling keyword list, got: ${patterns.join(', ')}`);
});

test('getDefaultDecayRate returns an explicit rate for both new categories', () => {
  const { pheromone } = loadFresh();
  // The default fallback (line 154 of pheromone-table.js) is 0.10. An
  // explicit entry returns a different number — if this fails with
  // 0.10, the decay-rate entry was lost.
  const notesRate = pheromone.getDefaultDecayRate('notes-to-reviewer');
  const disRate = pheromone.getDefaultDecayRate('disclaimer-piling');
  assert.notStrictEqual(notesRate, 0.10,
    `notes-to-reviewer should have an explicit decay rate, got ${notesRate}`);
  assert.notStrictEqual(disRate, 0.10,
    `disclaimer-piling should have an explicit decay rate, got ${disRate}`);
  // Known-good values from the parents' commits (notes-to-reviewer=0.07,
  // disclaimer-piling=0.25). If a future change moves these, this test
  // surfaces the intentional re-tune.
  assert.strictEqual(notesRate, 0.07,
    `notes-to-reviewer decay rate expected 0.07, got ${notesRate}`);
  assert.strictEqual(disRate, 0.25,
    `disclaimer-piling decay rate expected 0.25, got ${disRate}`);
});

// ============================================================================
// B. config/pheromone-rates.yaml — both keys present (documentation mirror)
// ============================================================================

test('config/pheromone-rates.yaml contains notes-to-reviewer entry', () => {
  const yamlPath = path.join(REPO_ROOT, 'config/pheromone-rates.yaml');
  assert.ok(fs.existsSync(yamlPath), `expected ${yamlPath} to exist`);
  const yaml = fs.readFileSync(yamlPath, 'utf8');
  // Match the decay_rates block key (not just any mention in comments).
  assert.match(yaml, /^\s*notes-to-reviewer:\s*0\.07\s*$/m,
    `expected 'notes-to-reviewer: 0.07' line in pheromone-rates.yaml\n---\n${yaml}`);
});

test('config/pheromone-rates.yaml contains disclaimer-piling entry', () => {
  const yamlPath = path.join(REPO_ROOT, 'config/pheromone-rates.yaml');
  const yaml = fs.readFileSync(yamlPath, 'utf8');
  assert.match(yaml, /^\s*disclaimer-piling:\s*0\.25\s*$/m,
    `expected 'disclaimer-piling: 0.25' line in pheromone-rates.yaml\n---\n${yaml}`);
});

// ============================================================================
// C. Classification behavior — positive cases for both
// ============================================================================

test('classifyTask routes canonical reviewer-note phrases to notes-to-reviewer', () => {
  const { classifier } = loadFresh();
  const cases = [
    'Please send notes to reviewer before merging.',
    'Editorial notes from the security team attached.',
    'Please leave a note for the architectural reviewer.',
    'Reviewer feedback on the new flow has been recorded.',
    'Please flag for review if you change the schema.',
  ];
  for (const prompt of cases) {
    const cat = classifier.classifyTask({ prompt });
    assert.strictEqual(cat, 'notes-to-reviewer',
      `prompt "${prompt}" → ${cat}, expected notes-to-reviewer`);
  }
});

test('classifyTask routes canonical disclaimer-piling phrases to disclaimer-piling', () => {
  const { classifier } = loadFresh();
  // Each prompt below uses ONLY disclaimer-piling phrasing (no overlap
  // with code-generation or security-review keywords).
  const cases = [
    'Strip the redundant disclaimer preamble from the assistant reply.',
    'Remove the safety notice and as an ai hedge from the output.',
    'Cut the hedging language; the answer is fine without the preamble.',
    'Stack of disclaimer / safety boilerplate is bloating the response — strip it.',
    'The disclaimer / safety notice intro is unnecessary here.',
  ];
  for (const prompt of cases) {
    const cat = classifier.classifyTask({ prompt });
    assert.strictEqual(cat, 'disclaimer-piling',
      `prompt "${prompt}" → ${cat}, expected disclaimer-piling`);
  }
});

// ============================================================================
// D. Negative case — unrelated content does NOT trigger either category
// ============================================================================

test('classifyTask does NOT match notes-to-reviewer for unrelated prompts', () => {
  const { classifier } = loadFresh();
  const cases = [
    'Hello there',
    'Refactor the user authentication module.',
    'Run the integration test suite for the routing layer.',
    'Survey the literature on ACO routing.',
  ];
  for (const prompt of cases) {
    const cat = classifier.classifyTask({ prompt });
    assert.notStrictEqual(cat, 'notes-to-reviewer',
      `prompt "${prompt}" should NOT classify as notes-to-reviewer, got ${cat}`);
  }
});

test('classifyTask does NOT match disclaimer-piling for unrelated prompts', () => {
  const { classifier } = loadFresh();
  const cases = [
    'Hello there',
    'Refactor the user authentication module.',
    'Run the integration test suite for the routing layer.',
    'Survey the literature on ACO routing.',
    'Please send notes to reviewer before merging.',  // notes-to-reviewer input — must NOT bleed into disclaimer-piling
  ];
  for (const prompt of cases) {
    const cat = classifier.classifyTask({ prompt });
    assert.notStrictEqual(cat, 'disclaimer-piling',
      `prompt "${prompt}" should NOT classify as disclaimer-piling, got ${cat}`);
  }
});

test('classifyTask returns GENERAL for prompts with no matching keywords', () => {
  const { classifier } = loadFresh();
  const cat = classifier.classifyTask({ prompt: 'Hello there' });
  assert.strictEqual(cat, 'general');
});

// ============================================================================
// E. metadata.taskCategory passthrough
// ============================================================================

test('metadata.taskCategory accepts notes-to-reviewer as a valid override', () => {
  const { classifier } = loadFresh();
  const cat = classifier.classifyTask({
    prompt: 'Do something arbitrary',
    metadata: { taskCategory: 'notes-to-reviewer' },
  });
  assert.strictEqual(cat, 'notes-to-reviewer');
});

test('metadata.taskCategory accepts disclaimer-piling as a valid override', () => {
  // Updated from the t_4f06c7fc file (which asserted the opposite —
  // disclaimer-piling was not in the enum at the time of writing).
  // t_c6966800 rewrites this to reflect that disclaimer-piling IS now
  // a registered TaskCategory.
  const { classifier } = loadFresh();
  const cat = classifier.classifyTask({
    prompt: 'Do something arbitrary',
    metadata: { taskCategory: 'disclaimer-piling' },
  });
  assert.strictEqual(cat, 'disclaimer-piling');
});

test('metadata.taskCategory rejects strings not in the enum', () => {
  const { classifier } = loadFresh();
  // 'not-a-real-category' should NOT be accepted; classifier falls back
  // to keyword matching → GENERAL for an arbitrary prompt.
  const cat = classifier.classifyTask({
    prompt: 'arbitrary prompt',
    metadata: { taskCategory: 'not-a-real-category' },
  });
  assert.notStrictEqual(cat, 'not-a-real-category');
  assert.strictEqual(cat, 'general');
});

// ============================================================================
// F. detectMultipleCategories surfaces both when matching
// ============================================================================

test('detectMultipleCategories surfaces notes-to-reviewer when matching', () => {
  const { classifier } = loadFresh();
  const cats = classifier.detectMultipleCategories({
    prompt: 'Please add reviewer notes about the security implications.',
  });
  assert.ok(cats.includes('notes-to-reviewer'),
    `expected notes-to-reviewer in detected categories, got: ${cats.join(', ')}`);
});

test('detectMultipleCategories surfaces disclaimer-piling when matching', () => {
  const { classifier } = loadFresh();
  const cats = classifier.detectMultipleCategories({
    prompt: 'Strip the redundant disclaimer / safety notice preamble.',
  });
  assert.ok(cats.includes('disclaimer-piling'),
    `expected disclaimer-piling in detected categories, got: ${cats.join(', ')}`);
});

// ============================================================================
// Ordering / priority regressions from the parent commits
// ============================================================================

test('first-match-wins: NOTES_TO_REVIEWER beats RESEARCH for compound phrases', () => {
  // Load-bearing ordering test from t_4f06c7fc. If NOTES_TO_REVIEWER
  // were moved after RESEARCH in KEYWORD_PATTERNS, this would route to
  // RESEARCH because 'review' is in RESEARCH's keyword list.
  const { classifier } = loadFresh();
  const cat = classifier.classifyTask({ prompt: 'Reviewer notes on the new schema' });
  assert.strictEqual(cat, 'notes-to-reviewer',
    'expected notes-to-reviewer to win over RESEARCH for compound "reviewer notes"');
});

test('getCategoryPriority returns a number for both new categories', () => {
  const { classifier } = loadFresh();
  const notesPri = classifier.getCategoryPriority('notes-to-reviewer');
  const disPri = classifier.getCategoryPriority('disclaimer-piling');
  assert.strictEqual(typeof notesPri, 'number');
  assert.strictEqual(typeof disPri, 'number');
  // Parents chose: notes-to-reviewer=30 (above coordination=20, below
  // research=40); disclaimer-piling=25 (between coordination=20 and
  // research=40). Verify the cross-priority relationship stays valid.
  const coord = classifier.getCategoryPriority('coordination');
  const research = classifier.getCategoryPriority('research');
  assert.ok(notesPri > coord && notesPri < research,
    `notes-to-reviewer priority ${notesPri} should be between coordination ${coord} and research ${research}`);
  assert.ok(disPri > coord && disPri < research,
    `disclaimer-piling priority ${disPri} should be between coordination ${coord} and research ${research}`);
});