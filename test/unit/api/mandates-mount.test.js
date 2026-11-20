// test/unit/api/mandates-mount.test.js
// Mount verification for POST /v2/mandates (card t_ae57240e).
//
// The sibling suite (mandates-handler.test.js) exercises the router in
// isolation. This file proves the ROUTE IS ACTUALLY MOUNTED in the real
// gateway, behind the real bearer-auth gate — the two things the acceptance
// criteria name and the thing a unit test of the router alone cannot prove.
//
// It boots the real APIGateway (src/api/index.js) and drives it with
// supertest. SECRET_KEY must be set BEFORE the module graph is required
// (src/api/middleware/auth.js calls process.exit(1) when it is missing).
//
// Run: node --test test/unit/api/mandates-mount.test.js

'use strict';

// >= 32 chars — src/api/middleware/auth.js enforces the minimum.
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-for-mandates-mount-check-0123456789';
// The DB is not reachable in a unit-test environment; the mandate endpoint
// must report that honestly (503) rather than inventing a 201.
process.env.AWARE_DB_ENABLED = process.env.AWARE_DB_ENABLED || 'false';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app = null;
let token = null;

const VALID_PAYLOAD = {
  granted_by: 'user:alvin',
  scope: ['read:document'],
  expiry: '2026-12-01T00:00:00.000Z',
  interval: '1d',
  direction: 'reduce',
  underwriters: ['user:alvin'],
  triggering_event_type: 'tier_promotion',
  triggering_event_id: '11111111-2222-4333-8444-555555555555',
};

before(async () => {
  // Required lazily so the SECRET_KEY above is in place first.
  const APIGateway = require('../../../src/api/index.js');
  const gateway = new APIGateway({ port: 0, secretKey: process.env.SECRET_KEY });
  app = gateway.app;
  token = jwt.sign({ username: 'alvin', role: 'admin' }, process.env.SECRET_KEY, {
    expiresIn: '1h',
  });
});

// The real gateway's module graph starts a metrics-collector flush timer
// (src/api/routes/metrics.js → metrics-collector.start() → setInterval).
// That timer is unrelated to this card and would keep the test process alive
// forever, so stop it in teardown. Without this, `node --test` on this file
// hangs after the last assertion.
after(async () => {
  try {
    const { getCollector } = require('../../../src/monitoring/metrics-collector.js');
    if (typeof getCollector === 'function') {
      const collector = getCollector();
      if (collector && typeof collector.stop === 'function') collector.stop();
    }
  } catch (err) {
    // Teardown must never mask a test failure.
  }
});

describe('POST /v2/mandates is mounted in the real gateway', () => {
  test('returns 401 when the bearer token is absent', async () => {
    const res = await request(app).post('/v2/mandates').send(VALID_PAYLOAD);
    assert.strictEqual(res.status, 401);
  });

  test('returns 403 when the bearer token is invalid', async () => {
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', 'Bearer not-a-jwt')
      .send(VALID_PAYLOAD);
    assert.strictEqual(res.status, 403);
  });

  test('returns 400 with the Error shape for a malformed payload', async () => {
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', `Bearer ${token}`)
      .send({ interval: '2h', bogus: 1 });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(typeof res.body.error, 'string');
    assert.strictEqual(typeof res.body.details, 'string');
  });

  test('returns 400 for an unknown top-level key (additionalProperties: false)', async () => {
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_PAYLOAD, evil: 'yes' });
    assert.strictEqual(res.status, 400);
  });

  test('never claims 201 when the database is unreachable', async () => {
    // 201 means "recorded". Without storage that promise is false, so the
    // endpoint must answer 503 instead of lying to the client.
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_PAYLOAD);
    assert.notStrictEqual(res.status, 201);
    assert.strictEqual(res.status, 503);
  });

  test('the mandates route is not shadowed by the tier-promotions router', async () => {
    // /v2/tier-promotions answers 202 for every valid body. If the mandates
    // request were falling into that router, we would see a 202 with an
    // event_id body instead of the mandates response.
    const res = await request(app)
      .post('/v2/mandates')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_PAYLOAD);
    assert.ok(!res.body || res.body.event_id === undefined, 'mandates was handled by the sibling router');
  });

  test('the sibling /v2/tier-promotions endpoint is unaffected', async () => {
    const res = await request(app)
      .post('/v2/tier-promotions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        id: '11111111-2222-4333-8444-555555555555',
        agent_id: 'agent:coder',
        from_tier: 'T1',
        to_tier: 'T2',
        promoted_by: 'svc:test',
        promoted_at: '2026-07-06T12:00:00.000Z',
      });
    assert.strictEqual(res.status, 202, JSON.stringify(res.body));
    assert.strictEqual(res.body.event_id, '11111111-2222-4333-8444-555555555555');
  });
});
