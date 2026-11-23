// test/unit/acs/schema-drift.test.js
// The vendored schemas must match the pinned upstream bytes.
//
// WHAT THIS GUARDS
// -----------------
// The adapter validates against the VENDORED schemas, not against the
// network. That is what makes the conformance claim reproducible, and it is
// also what makes it stale the moment upstream changes. This test fails when
// a vendored file no longer matches the pinned SHA-256, so a spec bump is a
// DELIBERATE act: the pin in docs/acs/VERSION is updated, the schemas are
// re-vendored, and this table is updated with them.
//
// The hash table is the authority. It is NOT read from docs/acs/VERSION,
// because a test that reads its expectation from the same file it is
// checking proves nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'acs', 'schemas');

/**
 * The pinned SHA-256 of every vendored schema.
 *
 * Upstream: https://github.com/responsibleai/agent-control-spec
 * Tag:      v0.4.0-beta.2
 * Commit:   b11ae38b1bd53d299789c1724f4f94f80a0c6540
 *
 * The receipt schema comes from Agent Hooks, because ACS defines the receipt
 * by reference to AGENT-HOOKS-0.1 section 10.3 rather than shipping its own
 * copy. Commit: 7e13a74b34af30f2049d902cc656c247c81d2f95
 */
const PINNED_SHA256 = Object.freeze({
  'approval.schema.json': '780e4dd570b405f95a565a7080d0018808a26a698dbf76cd4988ac956b04ab43',
  'interception-record.schema.json': '82a08006a2e9b4b85277435c40c9a81d878c0456f8259b7a137ead7cadeaf3e5',
  'manifest.schema.json': '6a897f5930d500b470ba30369f530bdccd378aac080d8505d1ac4aca2007c570',
  'policy-input.schema.json': 'e0ee81de0f3f9fc2a98e3ef52966d888cc49c4eabe136cfe29b64bd71da38e38',
  'request.schema.json': 'bbbfe0893f11cd197133f9bd53602cdd4b702b19777de7fd1d99d4ae5c37c190',
  'reserved-reasons.json': 'd54b1de88c0d32bbc18244c10d1525ba4d7862f09ca522c0436fd81f91c66cdb',
  'result.schema.json': '9c7ba788ab8d2788bed5cfb805700db1446b717639fc6b858688efde4094fd72',
  'snapshot.schema.json': '4bb8dff18b67e3d10c8340e68548dbfea69a3dc6e96e8f1fcb869a16560b37b8',
  'verdict.schema.json': '57971b0178826bcb15e8e58d0c70f5137053e7420d37ef99c1ddf3623ffdefe8',
});

/**
 * The pinned upstream versions, read from docs/acs/VERSION.
 *
 * The version file is a RECORD, not the authority for the hashes. It is
 * checked here so a version bump that forgets to update the hashes is
 * caught.
 */
const VERSION_FILE = path.join(__dirname, '..', '..', '..', 'docs', 'acs', 'VERSION');

test('acs drift: every vendored schema matches its pinned SHA-256', () => {
  const files = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no vendored schemas found');

  for (const file of files) {
    const expected = PINNED_SHA256[file];
    assert.ok(
      expected,
      `${file} is vendored but has no pinned SHA-256. Either pin it or remove it.`,
    );
    const actual = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(SCHEMA_DIR, file)))
      .digest('hex');
    assert.equal(
      actual,
      expected,
      `${file} does not match the pinned upstream bytes. The spec pin moved; ` +
      're-vendor the schema and update PINNED_SHA256 deliberately.',
    );
  }
});

test('acs drift: every pinned schema is present on disk', () => {
  for (const file of Object.keys(PINNED_SHA256)) {
    assert.ok(
      fs.existsSync(path.join(SCHEMA_DIR, file)),
      `${file} is pinned but not vendored`,
    );
  }
});

test('acs drift: the VERSION file records the pinned release and commit', () => {
  const version = fs.readFileSync(VERSION_FILE, 'utf8');
  assert.match(version, /^SPEC_RELEASE_TAG=v0\.4\.0-beta\.2$/m);
  assert.match(
    version,
    /^SPEC_COMMIT=b11ae38b1bd53d299789c1724f4f94f80a0c6540$/m,
    'the pinned commit must match the one the schemas were taken from',
  );
  assert.match(version, /^SPEC_VERSION=0\.5\.0-alpha\.1$/m);
  assert.match(version, /^SPEC_VERSION_COMPAT=0\.4\.0-alpha\.1$/m);
  assert.match(
    version,
    /^AGENT_HOOKS_COMMIT=7e13a74b34af30f2049d902cc656c247c81d2f95$/m,
    'the receipt schema comes from Agent Hooks, so its commit must be pinned',
  );
});

test('acs drift: the vendored schemas parse as JSON', () => {
  for (const file of Object.keys(PINNED_SHA256)) {
    const parsed = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));
    assert.ok(parsed, `${file} must parse to an object`);
  }
});

test('acs drift: the MIT licence notice is present for the vendored material', () => {
  const acsDir = path.join(__dirname, '..', '..', '..', 'docs', 'acs');
  assert.ok(fs.existsSync(path.join(acsDir, 'LICENSE.acs')), 'the MIT notice must ship');
  const notice = fs.readFileSync(path.join(acsDir, 'LICENSE.acs'), 'utf8');
  assert.match(notice, /^MIT License/);
  assert.match(notice, /Copyright \(c\) Microsoft Corporation/);
  assert.ok(
    fs.existsSync(path.join(acsDir, 'VENDORED.md')),
    'the provenance file must ship',
  );
  const vendored = fs.readFileSync(path.join(acsDir, 'VENDORED.md'), 'utf8');
  for (const file of Object.keys(PINNED_SHA256)) {
    assert.ok(
      vendored.includes(file),
      `VENDORED.md must record the provenance of ${file}`,
    );
  }
});
