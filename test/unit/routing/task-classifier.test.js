// test/unit/routing/task-classifier.test.js
//
// Unit tests for src/routing/task-classifier.js, focused on the
// `notes-to-reviewer` category added in t_4f06c7fc.
//
// Verifies:
//   1. The category is in the TaskCategory enum (downstream consumers can
//      resolve it).
//   2. KEYWORD_PATTERNS for notes-to-reviewer classify canonical phrases.
//   3. Compound "reviewer notes" phrases win over the single-word
//      'review' match that RESEARCH owns — i.e. the
//      NOTES_TO_REVIEWER-before-RESEARCH ordering in KEYWORD_PATTERNS is
//      load-bearing.
//   4. detectMultipleCategories + getCategoryPriority surface the new
//      category with priority 30 (between RESEARCH=40 and COORDINATION=20).
//   5. metadata.taskCategory passthrough still works (the enum check at
//      task-classifier.js:100 should accept 'notes-to-reviewer').

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// Re-require per test to avoid module-level state leaking between cases.
// (task-classifier.js is pure — no module state — but we mirror the
// pattern from mcp-top10-classifier.test.js for consistency.)
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

// ----------------------------------------------------------------------------
// Enum & keyword registration
// ----------------------------------------------------------------------------

test('TaskCategory enum exposes NOTES_TO_REVIEWER with the kebab-case value', () => {
  const { pheromone } = loadFresh();
  assert.strictEqual(pheromone.TaskCategory.NOTES_TO_REVIEWER, 'notes-to-reviewer');
  // Make sure the value is part of Object.values(TaskCategory) — the
  // metadata fallback in classifyTask checks this set.
  const values = Object.values(pheromone.TaskCategory);
  assert.ok(values.includes('notes-to-reviewer'),
    `expected 'notes-to-reviewer' in TaskCategory values, got: ${values.join(', ')}`);
});

test('KEYWORD_PATTERNS exposes a non-empty notes-to-reviewer list', () => {
  const { classifier } = loadFresh();
  const patterns = classifier.KEYWORD_PATTERNS['notes-to-reviewer'];
  assert.ok(Array.isArray(patterns), 'expected KEYWORD_PATTERNS["notes-to-reviewer"] to be an array');
  assert.ok(patterns.length >= 3, `expected at least 3 keywords, got ${patterns.length}`);
  // Spot-check that the canonical phrase is present.
  assert.ok(patterns.includes('notes to reviewer'),
    `expected 'notes to reviewer' in keyword list, got: ${patterns.join(', ')}`);
});

test('getDefaultDecayRate returns a non-default value for notes-to-reviewer', () => {
  const { pheromone } = loadFresh();
  const rate = pheromone.getDefaultDecayRate('notes-to-reviewer');
  assert.strictEqual(typeof rate, 'number');
  // The default fallback (line 154) is 0.10. notes-to-reviewer has an
  // explicit entry of 0.07 (slower decay for durable review patterns).
  // If this assertion fails with 0.10, the decay-rate entry was lost.
  assert.notStrictEqual(rate, 0.10,
    'notes-to-reviewer should have an explicit decay rate, not the 0.10 default');
});

// ----------------------------------------------------------------------------
// Classification behavior
// ----------------------------------------------------------------------------

test('classifyTask routes canonical reviewer-note phrases to notes-to-reviewer', () => {
  const { classifier } = loadFresh();
  // Each prompt below uses ONLY reviewer-note phrasing (no overlapping
  // keywords from other categories). The 'API contract' phrasing was
  // intentionally excluded — CODE_GENERATION's 'api' keyword wins on
  // first-match-wins for ambiguous prompts, which is documented behavior.
  // 'flag for review' is checked as a literal substring match, so the
  // prompt must contain that exact phrase contiguously — natural English
  // like "flag this for review tomorrow" doesn't (has intervening words)
  // and falls through to RESEARCH's 'review' keyword. That's a real
  // limitation of substring matching and is documented as such.
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

test('first-match-wins: ambiguous prompts route to the earliest-enumerated matching category', () => {
  // Documented behavior, not a bug. CODE_GENERATION comes before
  // NOTES_TO_REVIEWER in KEYWORD_PATTERNS, so a prompt with both
  // 'reviewer notes' AND 'api' codes as code-generation. Operators who
  // want the reverse precedence should re-order KEYWORD_PATTERNS.
  const { classifier } = loadFresh();
  const cat = classifier.classifyTask({
    prompt: 'Add reviewer notes about the API contract.',
  });
  assert.strictEqual(cat, 'code-generation');
});

test('compound "reviewer notes" wins over RESEARCH\'s single-word "review"', () => {
  // This is the load-bearing ordering test: 'review' is in RESEARCH's
  // keyword list, and substring matching means 'reviewer notes' contains
  // 'review'. If NOTES_TO_REVIEWER were not visited BEFORE RESEARCH in
  // KEYWORD_PATTERNS, this would classify as RESEARCH.
  const { classifier } = loadFresh();
  const cat = classifier.classifyTask({ prompt: 'Reviewer notes on the new schema' });
  assert.strictEqual(cat, 'notes-to-reviewer',
    'expected notes-to-reviewer to win over RESEARCH for compound "reviewer notes"');
});

test('research verbs without reviewer-note phrasing still classify as RESEARCH', () => {
  const { classifier } = loadFresh();
  // Sanity check that the ordering fix didn't break RESEARCH classification
  // for prompts that don't contain reviewer-note phrases.
  const cat = classifier.classifyTask({ prompt: 'Survey the literature on ACO routing' });
  assert.strictEqual(cat, 'research');
});

test('prompts with no matching keywords fall through to GENERAL', () => {
  const { classifier } = loadFresh();
  const cat = classifier.classifyTask({ prompt: 'Hello there' });
  assert.strictEqual(cat, 'general');
});

// ----------------------------------------------------------------------------
// Priority + multi-category
// ----------------------------------------------------------------------------

test('getCategoryPriority for notes-to-reviewer is between COORDINATION and RESEARCH', () => {
  const { classifier } = loadFresh();
  const notes = classifier.getCategoryPriority('notes-to-reviewer');
  const coord = classifier.getCategoryPriority('coordination');
  const research = classifier.getCategoryPriority('research');
  assert.strictEqual(typeof notes, 'number');
  assert.ok(notes > coord, `notes-to-reviewer priority ${notes} should exceed coordination ${coord}`);
  assert.ok(notes < research, `notes-to-reviewer priority ${notes} should be below research ${research}`);
});

test('detectMultipleCategories surfaces notes-to-reviewer when matching', () => {
  const { classifier } = loadFresh();
  const cats = classifier.detectMultipleCategories({
    prompt: 'Please add reviewer notes about the security implications.',
  });
  assert.ok(cats.includes('notes-to-reviewer'),
    `expected notes-to-reviewer in detected categories, got: ${cats.join(', ')}`);
});

// ----------------------------------------------------------------------------
// metadata.taskCategory passthrough
// ----------------------------------------------------------------------------

test('metadata.taskCategory accepts notes-to-reviewer as a valid override', () => {
  const { classifier } = loadFresh();
  // Even with no keyword match, the metadata override path should accept
  // 'notes-to-reviewer' because it's in the enum values list.
  const cat = classifier.classifyTask({
    prompt: 'Do something arbitrary',
    metadata: { taskCategory: 'notes-to-reviewer' },
  });
  assert.strictEqual(cat, 'notes-to-reviewer');
});

test('metadata.taskCategory rejects strings not in the enum', () => {
  const { classifier } = loadFresh();
  // 'disclaimer-piling' is intentionally NOT in the enum (see parent
  // report t_cd92ebde §7). The override should NOT take effect, and the
  // classifier should fall back to keyword matching → GENERAL.
  const cat = classifier.classifyTask({
    prompt: 'arbitrary prompt',
    metadata: { taskCategory: 'disclaimer-piling' },
  });
  assert.notStrictEqual(cat, 'disclaimer-piling');
});
