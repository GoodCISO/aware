// test/unit/governance/registry.test.js
//
// The governance-quantity registry's contract.
//
// WHY THIS TEST EXISTS
// --------------------
// The registry is where a reader goes to find out what actually happens to
// each governance quantity. If it drifts from reality, it is worse than
// having no registry: it becomes a confident lie.
//
// So this suite does three things:
//
//   1. Asserts the registry's own invariants (every entry is well-formed,
//      origins are from the closed set, units are consistent).
//   2. Asserts the FACTS about the codebase that the registry claims —
//      by reading the source. If someone wires the anomaly scorer in, or
//      adds a writer for metadata.blastRadius, this test fails and the
//      registry must be corrected.
//   3. Asserts that the quantities AWARE actually ships are all registered —
//      so a new quantity cannot be added without declaring its provenance.
//
// Point 2 is the important one. It is the "test for producer absence"
// recommendation from the paper: a claim about provenance is only worth
// anything if something checks it.
//
// SEE ALSO
//   src/governance/registry.js
//   src/governance/quantity.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  QUANTITY_ORIGIN,
  BLAST_RADIUS_KIND,
  BLAST_RADIUS_UNITS,
} = require('../../../src/governance/quantity');
const {
  GOVERNANCE_QUANTITIES,
  getQuantity,
  listNonDerivedQuantities,
  provenanceReport,
} = require('../../../src/governance/registry');

const REPO_ROOT = path.resolve(__dirname, '../../..');

// Match a real import/require of a module, not a prose mention of it.
// `require('./anomaly-scorer')`, `from './anomaly-scorer.js'`, etc.
const IMPORT_RE = {
  anomaly: /\bfrom\s+['"][^'"]*anomaly-scorer(?:\.js)?['"]/,
  anomalyRequire: /\brequire\(\s*['"][^'"]*anomaly-scorer(?:\.js)?['"]\s*\)/,
  pheromone: /\bfrom\s+['"][^'"]*pheromone-router(?:\.js)?['"]/,
  pheromoneRequire: /\brequire\(\s*['"][^'"]*pheromone-router(?:\.js)?['"]\s*\)/,
};

function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

// ─── Registry invariants ────────────────────────────────────────────────────

test('the registry is non-empty and every entry is well-formed', () => {
  const entries = Object.values(GOVERNANCE_QUANTITIES);
  assert.ok(entries.length > 0, 'registry is empty');

  for (const q of entries) {
    assert.equal(typeof q.name, 'string');
    assert.ok(q.name.length > 0);
    assert.ok(
      Object.values(QUANTITY_ORIGIN).includes(q.origin),
      `${q.name}: bad origin ${q.origin}`
    );
    assert.ok(Object.isFrozen(q), `${q.name}: not frozen`);
  }
});

test('every quantity carries a provenance note', () => {
  // A registry entry without a note is a fact with no explanation, which is
  // the thing this whole exercise exists to prevent.
  for (const q of Object.values(GOVERNANCE_QUANTITIES)) {
    assert.equal(typeof q.note, 'string', `${q.name} has no note`);
    assert.ok(q.note.length > 20, `${q.name} note is too thin to be useful`);
  }
});

test('a derived quantity names a producer; a non-derived one does not', () => {
  for (const q of Object.values(GOVERNANCE_QUANTITIES)) {
    if (q.origin === QUANTITY_ORIGIN.DERIVED) {
      assert.equal(typeof q.producer, 'string', `${q.name} names no producer`);
      assert.ok(q.producer.length > 0);
    } else {
      assert.equal(q.producer, null, `${q.name} must not name a wired producer`);
    }
  }
});

test('getQuantity returns the descriptor for a known name and undefined otherwise', () => {
  assert.equal(getQuantity('trustScore').name, 'trustScore');
  assert.equal(getQuantity('noSuchQuantity'), undefined);
  // Prototype keys must not resolve.
  assert.equal(getQuantity('constructor'), undefined);
  assert.equal(getQuantity('__proto__'), undefined);
});

test('provenanceReport is machine-readable and covers every quantity', () => {
  const report = provenanceReport();
  assert.equal(report.length, Object.keys(GOVERNANCE_QUANTITIES).length);
  for (const row of report) {
    assert.equal(typeof row.name, 'string');
    assert.ok(Object.values(QUANTITY_ORIGIN).includes(row.origin));
    assert.ok('unit' in row);
    assert.ok('producer' in row);
    assert.ok('note' in row);
  }
});

test('the non-derived list contains exactly the quantities that are not computed', () => {
  const nonDerived = listNonDerivedQuantities();
  for (const q of nonDerived) {
    assert.notEqual(q.origin, QUANTITY_ORIGIN.DERIVED);
  }
  const derived = Object.values(GOVERNANCE_QUANTITIES).filter(
    (q) => q.origin === QUANTITY_ORIGIN.DERIVED
  );
  assert.equal(
    nonDerived.length + derived.length,
    Object.keys(GOVERNANCE_QUANTITIES).length
  );
});

// ─── The registry's claims, checked against the source ─────────────────────

test('CLAIM: trustScore has a producer, but that producer is orphaned', () => {
  // The producer exists and is real behavioural code.
  const scorer = readSource('src/monitoring/anomaly-scorer.js');
  assert.match(scorer, /function computeTrustScore\(/);
  assert.match(scorer, /const trustScore = Math\.max\(0, Math\.min\(1,/);

  // ...but nothing imports it, so the score that ships is not that score.
  const importers = [];
  const srcRoot = path.join(REPO_ROOT, 'src');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'build') continue;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const body = fs.readFileSync(full, 'utf8');
        // Match an ACTUAL import, not a mention in a comment or a doc
        // string. The word appears in prose in several files.
        if (IMPORT_RE.anomaly.test(body) || IMPORT_RE.anomalyRequire.test(body)) {
          importers.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  };
  walk(srcRoot);

  // The only reference is a comment in the alerts route. No import.
  const realImports = importers.filter((f) => f !== 'src/api/routes/alerts.js');
  assert.deepEqual(
    realImports,
    [],
    `anomaly-scorer is now imported by ${realImports.join(', ')} — the ` +
      `trustScore producer is no longer orphaned; correct the registry.`
  );

  assert.equal(getQuantity('trustScore').origin, QUANTITY_ORIGIN.ORPHANED);
});

test('CLAIM: the routing consumer is orphaned too', () => {
  // The heuristic calculator consumes the trust score, but its only
  // importer is the pheromone router, which the README says is not wired.
  const routerPath = 'src/routing/pheromone-router.js';
  const router = readSource(routerPath);
  assert.match(router, /require\('\.\/heuristic-calculator'\)/);

  const importers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'build') continue;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        const body = fs.readFileSync(full, 'utf8');
        if (IMPORT_RE.pheromone.test(body) || IMPORT_RE.pheromoneRequire.test(body)) {
          importers.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  };
  walk(path.join(REPO_ROOT, 'src'));
  assert.deepEqual(
    importers,
    [],
    `pheromone-router is now imported by ${importers.join(', ')} — the ` +
      `routing consumer is no longer orphaned; correct the registry.`
  );
});

test('CLAIM: nothing writes agent.metadata.blastRadius', () => {
  // The declared estimate is read with a hardcoded fallback. If a writer
  // exists, the fallback is not the effective value and the registry's
  // note is wrong.
  const candidates = [
    'src/agents/registry.js',
    'src/api/models/Agent.js',
    'src/api/routes/agents.js',
    'src/agents/identity-provider-v2.js',
  ];
  for (const rel of candidates) {
    const body = readSource(rel);
    assert.doesNotMatch(
      body,
      /metadata\s*\.\s*blastRadius\s*=/,
      `${rel} now WRITES metadata.blastRadius — the declared estimate is ` +
        `no longer always the 0.1 fallback; correct the registry.`
    );
  }
  assert.equal(
    getQuantity('declaredBlastRadiusEstimate').origin,
    QUANTITY_ORIGIN.DECLARED
  );
});

test('CLAIM: the revocation trail penalty IS computed', () => {
  const cache = readSource('src/agents/revocation-cache.js');
  assert.match(cache, /async _applyBlastRadius\(agentId, severity\)/);
  assert.match(cache, /const factor = penaltyFactors\[severity\] \|\| 0\.1;/);
  assert.equal(
    getQuantity('revocationTrailPenalty').origin,
    QUANTITY_ORIGIN.DERIVED
  );
});

test('CLAIM: the emergency impact estimate IS computed', () => {
  const estimator = readSource('src/emergency/blast-radius-estimator.js');
  assert.match(estimator, /class BlastRadiusEstimator/);
  assert.match(estimator, /async estimate\(target\)/);
  assert.match(estimator, /agentsAffected:/);
  assert.equal(
    getQuantity('emergencyImpactEstimate').origin,
    QUANTITY_ORIGIN.DERIVED
  );
  assert.equal(
    getQuantity('emergencyImpactEstimate').unit,
    BLAST_RADIUS_UNITS[BLAST_RADIUS_KIND.EMERGENCY_IMPACT]
  );
});

test('CLAIM: the protocol blast radius is a constant placeholder', () => {
  const protocol = readSource('src/agents/protocol.js');
  assert.match(protocol, /calculateBlastRadius\(\)\s*\{/);
  assert.match(protocol, /return 'low';/);
  assert.equal(
    getQuantity('protocolBlastRadiusSeverity').origin,
    QUANTITY_ORIGIN.DECLARED
  );
});

// ─── The shipped quantity must be registered ────────────────────────────────

test('every governance quantity AWARE ships is registered', () => {
  // The shipped trust score is the JWT claim. If it is renamed again, the
  // registry must be updated in the same change.
  const carrier = readSource('src/agents/identity-provider-v2.js');
  assert.match(carrier, /declaredTrustScore:/);
  assert.match(carrier, /declaredBlastRadiusEstimate:/);

  // ...and the registry must know about them.
  assert.ok(getQuantity('trustScore'), 'trustScore is not registered');
  assert.ok(
    getQuantity('declaredBlastRadiusEstimate'),
    'declaredBlastRadiusEstimate is not registered'
  );
});

test('the audit counters are registered and derived', () => {
  for (const name of ['auditRecordsVerified', 'auditSkippedRecords', 'auditResyncs']) {
    const q = getQuantity(name);
    assert.ok(q, `${name} is not registered`);
    assert.equal(q.origin, QUANTITY_ORIGIN.DERIVED);
  }
});
