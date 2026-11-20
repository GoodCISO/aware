// test/unit/governance/quantity.test.js
//
// The governance-quantity provenance contract.
//
// WHY THIS TEST EXISTS
// --------------------
// A governance quantity is "typed, transported, and consumed, but not
// computed" — and the type system cannot tell you that. This suite pins the
// primitive that makes the distinction expressible:
//
//   P1 Typed  /  P2 Transported  /  P3 Displayed
//   P4 Produced  <-- a producer exists and is WIRED
//   P5 Consumed
//
// It also pins the third origin value, 'orphaned': a producer exists and is
// implemented, but is not connected to the quantity that ships. That is the
// case a naive "does a producer exist?" audit misses, and it is the case
// AWARE's trust score is in.
//
// SEE ALSO
//   src/governance/quantity.js
//   src/governance/registry.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QUANTITY_ORIGIN,
  NON_DERIVED_ORIGINS,
  TRUST_SCORE_SCALE,
  BLAST_RADIUS_KIND,
  BLAST_RADIUS_UNITS,
  ORIGIN_LABELS,
  defineQuantity,
  isDerived,
  normaliseTrustScore,
  formatTrustScore,
  bandTrustScore,
} = require('../../../src/governance/quantity');

// ─── The origin enum ────────────────────────────────────────────────────────

test('the origin enum has exactly three values', () => {
  assert.deepEqual(Object.keys(QUANTITY_ORIGIN).sort(), [
    'DECLARED',
    'DERIVED',
    'ORPHANED',
  ]);
  assert.equal(QUANTITY_ORIGIN.DERIVED, 'derived');
  assert.equal(QUANTITY_ORIGIN.DECLARED, 'declared');
  assert.equal(QUANTITY_ORIGIN.ORPHANED, 'orphaned');
});

test('the origin enum is frozen', () => {
  assert.ok(Object.isFrozen(QUANTITY_ORIGIN));
});

test('every origin has a human-readable label', () => {
  for (const origin of Object.values(QUANTITY_ORIGIN)) {
    assert.equal(typeof ORIGIN_LABELS[origin], 'string');
    assert.ok(ORIGIN_LABELS[origin].length > 0, `no label for ${origin}`);
  }
});

test('only DERIVED counts as derived', () => {
  assert.ok(isDerived(QUANTITY_ORIGIN.DERIVED));
  assert.ok(!isDerived(QUANTITY_ORIGIN.DECLARED));
  assert.ok(!isDerived(QUANTITY_ORIGIN.ORPHANED));
});

test('DECLARED and ORPHANED are both non-derived origins', () => {
  assert.ok(NON_DERIVED_ORIGINS.has(QUANTITY_ORIGIN.DECLARED));
  assert.ok(NON_DERIVED_ORIGINS.has(QUANTITY_ORIGIN.ORPHANED));
  assert.ok(!NON_DERIVED_ORIGINS.has(QUANTITY_ORIGIN.DERIVED));
});

// ─── defineQuantity ─────────────────────────────────────────────────────────

test('defineQuantity accepts a derived quantity that names its producer', () => {
  const q = defineQuantity({
    name: 'example',
    origin: QUANTITY_ORIGIN.DERIVED,
    producer: 'computeExample',
  });
  assert.equal(q.origin, 'derived');
  assert.equal(q.producer, 'computeExample');
  assert.ok(Object.isFrozen(q));
});

test('defineQuantity rejects a derived quantity with no producer', () => {
  assert.throws(
    () => defineQuantity({ name: 'x', origin: QUANTITY_ORIGIN.DERIVED }),
    /names no producer/
  );
});

test('defineQuantity rejects a non-derived quantity that names a wired producer', () => {
  // This is the invariant that stops a declared quantity from being
  // documented as computed. An orphaned quantity names the producer that
  // exists but is NOT wired — via the note, not via `producer`.
  assert.throws(
    () =>
      defineQuantity({
        name: 'x',
        origin: QUANTITY_ORIGIN.ORPHANED,
        producer: 'computeExample',
      }),
    /must not name a wired producer/
  );
});

test('defineQuantity rejects an unknown origin', () => {
  assert.throws(
    () => defineQuantity({ name: 'x', origin: 'vibes' }),
    /unknown origin/
  );
});

test('defineQuantity rejects an empty name', () => {
  assert.throws(
    () => defineQuantity({ name: '', origin: QUANTITY_ORIGIN.DECLARED }),
    /non-empty string/
  );
});

test('defineQuantity leaves unit null when not supplied', () => {
  const q = defineQuantity({ name: 'x', origin: QUANTITY_ORIGIN.DECLARED });
  assert.equal(q.unit, null);
  assert.equal(q.producer, null);
});

// ─── The trust-score scale ──────────────────────────────────────────────────

test('the canonical trust-score unit is the fraction, not percent', () => {
  assert.equal(TRUST_SCORE_SCALE.UNIT, 'unit');
  assert.equal(TRUST_SCORE_SCALE.PERCENT, 'percent');
});

test('normaliseTrustScore leaves a fraction in [0,1] alone', () => {
  assert.equal(normaliseTrustScore(0), 0);
  assert.equal(normaliseTrustScore(0.85), 0.85);
  assert.equal(normaliseTrustScore(1), 1);
});

test('normaliseTrustScore converts a legacy 0..100 value', () => {
  // The UI's mock data used 92/88/45; the real stored value is 0..1.
  // Both must normalise to the same canonical unit.
  assert.equal(normaliseTrustScore(92), 0.92);
  assert.equal(normaliseTrustScore(45), 0.45);
  assert.equal(normaliseTrustScore(100), 1);
});

test('normaliseTrustScore clamps out-of-range values', () => {
  assert.equal(normaliseTrustScore(-5), 0);
  assert.equal(normaliseTrustScore(500), 1);
});

test('normaliseTrustScore returns null for non-numbers', () => {
  assert.equal(normaliseTrustScore(null), null);
  assert.equal(normaliseTrustScore(undefined), null);
  assert.equal(normaliseTrustScore(''), null);
  assert.equal(normaliseTrustScore('not-a-number'), null);
});

test('formatTrustScore renders a percentage', () => {
  assert.equal(formatTrustScore(0.85), '85%');
  assert.equal(formatTrustScore(0.5), '50%');
  assert.equal(formatTrustScore(92), '92%');
  assert.equal(formatTrustScore(null), '—');
});

test('bandTrustScore applies the agent screen cut points to the percent scale', () => {
  // The original cut points were >80 high, >50 medium, else low — always
  // meant as percentages. Applied to the fraction scale they banded every
  // real agent as "low".
  assert.equal(bandTrustScore(0.92), 'high');
  assert.equal(bandTrustScore(0.81), 'high');
  assert.equal(bandTrustScore(0.80), 'medium');
  assert.equal(bandTrustScore(0.51), 'medium');
  assert.equal(bandTrustScore(0.50), 'low');
  assert.equal(bandTrustScore(0), 'low');
});

test('bandTrustScore accepts the legacy percent scale identically', () => {
  assert.equal(bandTrustScore(92), 'high');
  assert.equal(bandTrustScore(81), 'high');
  assert.equal(bandTrustScore(80), 'medium');
  assert.equal(bandTrustScore(51), 'medium');
  assert.equal(bandTrustScore(50), 'low');
  assert.equal(bandTrustScore(0), 'low');
});

test('an unreadable score resolves to low, never to high', () => {
  assert.equal(bandTrustScore(null), 'low');
  assert.equal(bandTrustScore(undefined), 'low');
  assert.equal(bandTrustScore('not-a-number'), 'low');
});

// ─── The blast-radius kinds ─────────────────────────────────────────────────

test('the four blast-radius mechanisms have four distinct kinds', () => {
  const kinds = Object.values(BLAST_RADIUS_KIND);
  assert.equal(kinds.length, 4);
  assert.equal(new Set(kinds).size, 4);
});

test('each blast-radius kind has exactly one unit', () => {
  for (const kind of Object.values(BLAST_RADIUS_KIND)) {
    const unit = BLAST_RADIUS_UNITS[kind];
    assert.equal(typeof unit, 'string');
    assert.ok(unit.length > 0, `no unit for ${kind}`);
  }
});

test('the numeric estimate and the penalty share a unit, the impact record does not', () => {
  assert.equal(
    BLAST_RADIUS_UNITS[BLAST_RADIUS_KIND.DECLARED_ESTIMATE],
    'fraction'
  );
  assert.equal(
    BLAST_RADIUS_UNITS[BLAST_RADIUS_KIND.REVOCATION_PENALTY],
    'fraction'
  );
  assert.notEqual(
    BLAST_RADIUS_UNITS[BLAST_RADIUS_KIND.EMERGENCY_IMPACT],
    'fraction'
  );
});
