// test/unit/api/mandates-handler.test.js
// Unit tests for src/v2/mandates_handler.js
//
// Coverage:
//   - validateMandateCreate: every required-field branch, every enum, the
//     RFC3339 format check, additionalProperties:false at root, non-object
//     body, scope / underwriters / control_ids shape, minItems on
//     underwriters, optional lethal_trifecta_flag, canonical value on
//     success.
//   - createMandatesRouter: end-to-end POST /v2/mandates through Express +
//     supertest, covering 201 / 400 / 401 / 409 / 503 / 500 and the
//     DB-success / DB-duplicate / DB-throws / DB-disabled cases via the
//     getConn / recordMandate / findMandate / resolveTier factory overrides.
//
// Persistence is delegated to the DB-backed writer (src/db/mandates.js);
// we exercise that integration with stubs here.
//
// Run: node --test test/unit/api/mandates-handler.test.js
// or: npm test (it'll be picked up by the unit glob)

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const express = require('express');

const {
  validateMandateCreate,
  createMandatesRouter,
} = require('../../../src/v2/mandates_handler');

// A canonical, valid MandateCreate payload. Used as the base for all
// success-path tests; mutation-test variants override one field at a time
// to exercise each validation branch.
const VALID_EVENT_ID = '11111111-2222-4333-8444-555555555555';

function validPayload(overrides = {}) {
  return {
    granted_by: 'user:alvin',
    scope: ['read:document', 'write:db:tenant'],
    expiry: '2026-12-01T00:00:00.000Z',
    interval: '1d',
    direction: 'reduce',
    underwriters: ['user:alvin', 'user:grc-lead'],
    triggering_event_type: 'tier_promotion',
    triggering_event_id: VALID_EVENT_ID,
    ...overrides,
  };
}

// Stub factories. The handler's `createMandatesRouter({ getConn,
// recordMandate, findMandate, resolveTier })` accepts all four — letting
// tests pin the persistence outcome without touching a real database.
function stubGetConn(conn) {
  return async () => conn;
}
function stubRecord(result) {
  return async () => result;
}
function stubFind(existing) {
  return async () => existing;
}
function stubResolveTier(tier) {
  return async () => ({ tier, source: 'stub' });
}
function throwingRecord() {
  return async () => {
    throw new Error('boom');
  };
}

// A MandateResponse-shaped object, as the DB writer would return it.
function existingMandate(overrides = {}) {
  return {
    grant_id: '99999999-8888-4777-8666-555555555555',
    granted_by: 'user:alvin',
    scope: ['read:document'],
    expiry: '2026-12-01T00:00:00.000Z',
    interval: '1d',
    direction: 'reduce',
    underwriters: ['user:alvin'],
    control_ids: [],
    triggering_event_type: 'tier_promotion',
    triggering_event_id: VALID_EVENT_ID,
    created_at: '2026-11-01T09:00:00.000Z',
    agent_constraint_tier: 'T2',
    ...overrides,
  };
}

// Build a minimal Express app with the same bearer-auth gate the real
// APIGateway provides, so the 401 path is exercised here too.
function buildApp({ withAuth = true, getConn, recordMandate, findMandate, resolveTier } = {}) {
  const app = express();
  app.use(express.json());
  if (withAuth) {
    app.use((req, res, next) => {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
      }
      next();
    });
  }
  app.use(
    '/v2',
    createMandatesRouter({ getConn, recordMandate, findMandate, resolveTier })
  );
  return app;
}

// ---------------------------------------------------------------------------

describe('validateMandateCreate', () => {
  test('accepts a minimal valid payload', () => {
    const r = validateMandateCreate(validPayload());
    assert.strictEqual(r.valid, true, JSON.stringify(r));
    assert.strictEqual(r.value.granted_by, 'user:alvin');
    assert.strictEqual(r.value.direction, 'reduce');
  });

  test('accepts a payload with all optional fields populated', () => {
    const r = validateMandateCreate(
      validPayload({
        control_ids: ['IAM-01', 'LLM01'],
        lethal_trifecta_flag: true,
      })
    );
    assert.strictEqual(r.valid, true, JSON.stringify(r));
    assert.deepStrictEqual(r.value.control_ids, ['IAM-01', 'LLM01']);
    assert.strictEqual(r.value.lethal_trifecta_flag, true);
  });

  test('rejects null body', () => {
    const r = validateMandateCreate(null);
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.message.includes('JSON object')));
  });

  test('rejects array body', () => {
    const r = validateMandateCreate([1, 2, 3]);
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.message.includes('JSON object')));
  });

  test('rejects primitive body', () => {
    const r = validateMandateCreate('not a payload');
    assert.strictEqual(r.valid, false);
  });

  test('rejects extra top-level fields (additionalProperties: false)', () => {
    const r = validateMandateCreate(validPayload({ sneaky: 'value' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'sneaky'));
  });

  test('rejects a client-supplied grant_id (server-generated field)', () => {
    const r = validateMandateCreate(validPayload({ grant_id: 'x' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'grant_id'));
  });

  test('rejects a client-supplied agent_constraint_tier (server-set field)', () => {
    const r = validateMandateCreate(validPayload({ agent_constraint_tier: 'T4' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'agent_constraint_tier'));
  });

  test('rejects a client-supplied created_at (server-generated field)', () => {
    const r = validateMandateCreate(validPayload({ created_at: '2026-11-01T00:00:00Z' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'created_at'));
  });

  // --- Required-field enforcement ----------------------------------------

  for (const field of [
    'granted_by',
    'scope',
    'expiry',
    'interval',
    'direction',
    'underwriters',
    'triggering_event_type',
    'triggering_event_id',
  ]) {
    test(`rejects missing ${field}`, () => {
      const payload = validPayload();
      delete payload[field];
      const r = validateMandateCreate(payload);
      assert.strictEqual(r.valid, false);
      assert.ok(
        r.violations.some(v => v.path === field && v.message.includes('required')),
        `expected a required violation for ${field}, got ${JSON.stringify(r.violations)}`
      );
    });
  }

  // --- Type / format enforcement ------------------------------------------

  test('rejects non-string granted_by', () => {
    const r = validateMandateCreate(validPayload({ granted_by: 42 }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'granted_by'));
  });

  test('rejects scope as non-array', () => {
    const r = validateMandateCreate(validPayload({ scope: 'read:document' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'scope'));
  });

  test('rejects scope with a non-string element', () => {
    const r = validateMandateCreate(validPayload({ scope: ['read:document', 42] }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'scope'));
  });

  test('rejects expiry that is not RFC3339 (date-only)', () => {
    const r = validateMandateCreate(validPayload({ expiry: '2026-12-01' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'expiry'));
  });

  test('rejects expiry with timezone offset missing colon', () => {
    const r = validateMandateCreate(validPayload({ expiry: '2026-12-01T00:00:00+0000' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'expiry'));
  });

  test('accepts expiry with positive timezone offset', () => {
    const r = validateMandateCreate(validPayload({ expiry: '2026-12-01T02:00:00+02:00' }));
    assert.strictEqual(r.valid, true, JSON.stringify(r));
  });

  test('rejects expiry with month 13 (impossible calendar date)', () => {
    const r = validateMandateCreate(validPayload({ expiry: '2026-13-01T00:00:00Z' }));
    assert.strictEqual(r.valid, false);
    assert.ok(
      r.violations.some(v => v.path === 'expiry' && v.message.includes('not a valid calendar date'))
    );
  });

  test('rejects an invalid interval enum', () => {
    const r = validateMandateCreate(validPayload({ interval: '2h' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'interval' && v.message.includes('1h, 4h, 1d, 1w, 1m, 6m')));
  });

  test('rejects an invalid direction enum', () => {
    const r = validateMandateCreate(validPayload({ direction: 'deny' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'direction'));
  });

  test('rejects underwriters as non-array', () => {
    const r = validateMandateCreate(validPayload({ underwriters: 'user:alvin' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'underwriters'));
  });

  test('rejects an empty underwriters array (minItems: 1)', () => {
    const r = validateMandateCreate(validPayload({ underwriters: [] }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'underwriters' && v.message.includes('at least 1')));
  });

  test('rejects underwriters with a non-string element', () => {
    const r = validateMandateCreate(validPayload({ underwriters: ['user:alvin', 7] }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'underwriters'));
  });

  test('rejects control_ids as non-array', () => {
    const r = validateMandateCreate(validPayload({ control_ids: 'IAM-01' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'control_ids'));
  });

  test('rejects control_ids with a non-string element', () => {
    const r = validateMandateCreate(validPayload({ control_ids: ['IAM-01', 3] }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'control_ids'));
  });

  test('rejects a non-boolean lethal_trifecta_flag', () => {
    const r = validateMandateCreate(validPayload({ lethal_trifecta_flag: 'yes' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'lethal_trifecta_flag'));
  });

  test('accepts a false lethal_trifecta_flag', () => {
    const r = validateMandateCreate(validPayload({ lethal_trifecta_flag: false }));
    assert.strictEqual(r.valid, true, JSON.stringify(r));
  });

  test('rejects an invalid triggering_event_type enum', () => {
    const r = validateMandateCreate(validPayload({ triggering_event_type: 'tier-demotion' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'triggering_event_type'));
  });

  test('accepts every triggering_event_type in the enum', () => {
    for (const t of ['tier_promotion', 'pre_tool_block', 'cascade_revoke', 'spawn_request']) {
      const r = validateMandateCreate(validPayload({ triggering_event_type: t }));
      assert.strictEqual(r.valid, true, `${t}: ${JSON.stringify(r)}`);
    }
  });

  test('rejects a non-string triggering_event_id', () => {
    const r = validateMandateCreate(validPayload({ triggering_event_id: 123 }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'triggering_event_id'));
  });

  test('rejects an empty triggering_event_id', () => {
    const r = validateMandateCreate(validPayload({ triggering_event_id: '' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.violations.some(v => v.path === 'triggering_event_id'));
  });

  test('reports all violations in one pass (no short-circuit on first)', () => {
    const r = validateMandateCreate({
      granted_by: 42,
      interval: '2h',
      unknown_field: 'oops',
    });
    assert.strictEqual(r.valid, false);
    const paths = r.violations.map(v => v.path);
    for (const expected of [
      'granted_by',
      'interval',
      'unknown_field',
      'scope',
      'expiry',
      'direction',
      'underwriters',
      'triggering_event_type',
      'triggering_event_id',
    ]) {
      assert.ok(paths.includes(expected), `expected '${expected}' in ${JSON.stringify(paths)}`);
    }
  });

  test('canonical value drops unknown keys and preserves declared order', () => {
    const r = validateMandateCreate({
      triggering_event_id: VALID_EVENT_ID,
      triggering_event_type: 'tier_promotion',
      underwriters: ['user:alvin'],
      direction: 'reduce',
      interval: '1d',
      expiry: '2026-12-01T00:00:00Z',
      scope: ['read:document'],
      granted_by: 'user:alvin',
    });
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(Object.keys(r.value), [
      'granted_by',
      'scope',
      'expiry',
      'interval',
      'direction',
      'underwriters',
      'triggering_event_type',
      'triggering_event_id',
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('createMandatesRouter (HTTP)', () => {
  test('returns 401 when no bearer token is supplied', async () => {
    const app = buildApp({ withAuth: true });
    const res = await request(app)
      .post('/v2/mandates')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 401);
  });

  test('returns 201 with a MandateResponse body for a valid payload', async () => {
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [{ id: 1 }] }) }),
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T2'),
      recordMandate: async (conn, mandate) => ({
        recorded: true,
        mandate: { ...mandate, control_ids: [], created_at: mandate.created_at },
      }),
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.grant_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.strictEqual(res.body.granted_by, 'user:alvin');
    assert.strictEqual(res.body.agent_constraint_tier, 'T2');
    assert.match(res.body.created_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('the 201 body carries every MandateResponse required field', async () => {
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [{ id: 1 }] }) }),
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T1'),
      recordMandate: async (conn, mandate) => ({ recorded: true, mandate }),
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 201);
    for (const field of [
      'grant_id',
      'granted_by',
      'scope',
      'expiry',
      'interval',
      'direction',
      'underwriters',
      'triggering_event_type',
      'triggering_event_id',
      'agent_constraint_tier',
    ]) {
      assert.ok(res.body[field] !== undefined, `expected '${field}' in the 201 body`);
    }
  });

  test('returns 409 with the EXISTING mandate when the event id is already recorded', async () => {
    const existing = existingMandate();
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [{ id: 1 }] }) }),
      findMandate: stubFind(existing),
      resolveTier: stubResolveTier('T2'),
      recordMandate: stubRecord({ recorded: false, reason: 'duplicate', mandate: existing }),
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.grant_id, existing.grant_id);
    assert.strictEqual(res.body.triggering_event_id, VALID_EVENT_ID);
  });

  test('returns 409 when the writer detects the duplicate at insert time', async () => {
    const existing = existingMandate();
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [{ id: 1 }] }) }),
      // The pre-check missed it (a race) but the UNIQUE constraint caught it.
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T2'),
      recordMandate: stubRecord({ recorded: false, reason: 'duplicate', mandate: existing }),
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.grant_id, existing.grant_id);
  });

  test('does NOT write when the pre-check finds an existing mandate', async () => {
    let wrote = false;
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [{ id: 1 }] }) }),
      findMandate: stubFind(existingMandate()),
      resolveTier: stubResolveTier('T2'),
      recordMandate: async () => {
        wrote = true;
        return { recorded: true };
      },
    });
    await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(wrote, false, 'writer should not run on the idempotency hit');
  });

  test('returns 400 with the Error shape for a malformed payload', async () => {
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: stubFind(null),
      recordMandate: stubRecord({ recorded: false, reason: 'no-connection' }),
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send({ interval: '2h' })
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(typeof res.body.error, 'string');
    assert.strictEqual(typeof res.body.details, 'string');
    assert.match(res.body.error, /Malformed/);
    assert.ok(Array.isArray(res.body.violations));
    assert.ok(res.body.violations.length > 0);
  });

  test('returns 400 for an unknown top-level key (additionalProperties: false)', async () => {
    const app = buildApp({ withAuth: true });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload({ evil: 'yes' }))
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.violations.some(v => v.path === 'evil'));
  });

  test('returns 400 when the body is an array', async () => {
    const app = buildApp({ withAuth: true });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send([1, 2, 3])
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 400);
  });

  test('does NOT call the writer on a 400', async () => {
    let called = false;
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn(null),
      findMandate: stubFind(null),
      recordMandate: async () => {
        called = true;
        return { recorded: true };
      },
    });
    await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send({ interval: '2h' })
      .set('Content-Type', 'application/json');
    assert.strictEqual(called, false, 'writer should not be called on validation failure');
  });

  test('returns 503 when the database connection is unavailable', async () => {
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn(null),
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T0'),
      recordMandate: stubRecord({ recorded: false, reason: 'no-connection' }),
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 503, JSON.stringify(res.body));
    assert.match(res.body.error, /persistence unavailable/i);
  });

  test('returns 500 when the writer throws', async () => {
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T2'),
      recordMandate: throwingRecord(),
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 500, JSON.stringify(res.body));
    assert.match(res.body.error, /could not be recorded/i);
  });

  test('returns 500 when the writer reports an unexpected failure', async () => {
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T2'),
      recordMandate: stubRecord({ recorded: false, reason: 'insert-failed', error: 'pg down' }),
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 500, JSON.stringify(res.body));
    assert.strictEqual(res.body.details, 'pg down');
  });

  test('returns 400 when the writer rejects a payload the handler accepted', async () => {
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T2'),
      recordMandate: stubRecord({ recorded: false, reason: 'invalid-underwriters' }),
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  });

  test('passes the canonicalised payload to the writer', async () => {
    let observed = null;
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T3'),
      recordMandate: async (conn, mandate) => {
        observed = { conn, mandate };
        return { recorded: true, mandate };
      },
    });
    const payload = validPayload({
      control_ids: ['IAM-01'],
      lethal_trifecta_flag: true,
    });
    await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(payload)
      .set('Content-Type', 'application/json');
    assert.ok(observed, 'recordMandate was never called');
    assert.strictEqual(observed.mandate.granted_by, payload.granted_by);
    assert.strictEqual(observed.mandate.triggering_event_id, payload.triggering_event_id);
    assert.deepStrictEqual(observed.mandate.scope, payload.scope);
    assert.deepStrictEqual(observed.mandate.control_ids, ['IAM-01']);
    assert.strictEqual(observed.mandate.lethal_trifecta_flag, true);
  });

  test('the writer receives a server-generated grant_id, never the client one', async () => {
    let observed = null;
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T2'),
      recordMandate: async (conn, mandate) => {
        observed = mandate;
        return { recorded: true, mandate };
      },
    });
    await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.ok(observed);
    assert.ok(observed.grant_id);
    assert.notStrictEqual(observed.grant_id, VALID_EVENT_ID);
  });

  test('the resolved constraint tier is passed to the writer', async () => {
    let observed = null;
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: stubFind(null),
      resolveTier: stubResolveTier('T4'),
      recordMandate: async (conn, mandate) => {
        observed = mandate;
        return { recorded: true, mandate };
      },
    });
    await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(observed.agent_constraint_tier, 'T4');
  });

  test('falls back to T0 when the tier resolver returns nothing usable', async () => {
    let observed = null;
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: stubFind(null),
      resolveTier: async () => ({}),
      recordMandate: async (conn, mandate) => {
        observed = mandate;
        return { recorded: true, mandate };
      },
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 201);
    assert.strictEqual(observed.agent_constraint_tier, 'T0');
  });

  test('the idempotency lookup uses the client triggering_event_id', async () => {
    let seen = null;
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: async (conn, eventId) => {
        seen = eventId;
        return null;
      },
      resolveTier: stubResolveTier('T2'),
      recordMandate: async (conn, mandate) => ({ recorded: true, mandate }),
    });
    await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(seen, VALID_EVENT_ID);
  });

  test('a failed idempotency lookup still proceeds to the write', async () => {
    let wrote = false;
    const app = buildApp({
      withAuth: true,
      getConn: stubGetConn({ query: async () => ({ rows: [] }) }),
      findMandate: async () => {
        throw new Error('lookup blew up');
      },
      resolveTier: stubResolveTier('T2'),
      recordMandate: async (conn, mandate) => {
        wrote = true;
        return { recorded: true, mandate };
      },
    });
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer faketoken')
      .send(validPayload())
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(wrote, true);
  });
});
