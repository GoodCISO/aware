// test/unit/db/mandates.test.js
// Unit tests for src/db/mandates.js — AWARE v2 mandate-acceptance writer.
//
// Strategy: pure-function tests for buildGrantId / rowToMandate /
// resolveAgentConstraintTier, then stub-pool tests for recordMandate's
// happy path, idempotency collision, unique_violation collision, validation
// failures, and pool-unavailable paths. We don't need a real Postgres — the
// writer takes the connection as an argument, so a stub with .query() is
// sufficient.
//
// Matches the rest of the v2 suite: Node's built-in test runner
// (node --test), strict assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  recordMandate,
  findMandateByTriggeringEventId,
  resolveAgentConstraintTier,
  buildGrantId,
  rowToMandate,
  DEFAULT_CONSTRAINT_TIER,
} = await import('../../../src/db/mandates.js');

// --- Pure helpers ---------------------------------------------------------

test('mandates: buildGrantId returns a canonical UUID', () => {
  const id = buildGrantId();
  assert.equal(typeof id, 'string');
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
});

test('mandates: buildGrantId returns a different id each call', () => {
  assert.notEqual(buildGrantId(), buildGrantId());
});

test('mandates: rowToMandate maps a DB row onto the MandateResponse shape', () => {
  const mandate = rowToMandate({
    grant_id: '11111111-2222-4333-8444-555555555555',
    granted_by: 'user:alvin',
    scope: ['read:document'],
    expiry: new Date('2026-12-01T00:00:00Z'),
    interval: '1d',
    direction: 'reduce',
    underwriters: ['user:alvin'],
    control_ids: ['IAM-01'],
    lethal_trifecta_flag: false,
    triggering_event_type: 'tier_promotion',
    triggering_event_id: 'aaaa-bbbb',
    created_at: new Date('2026-11-01T09:00:00Z'),
    agent_constraint_tier: 'T2',
    id: 42, // surrogate column — must NOT appear on the wire
  });
  assert.equal(mandate.grant_id, '11111111-2222-4333-8444-555555555555');
  assert.equal(mandate.expiry, '2026-12-01T00:00:00.000Z');
  assert.equal(mandate.created_at, '2026-11-01T09:00:00.000Z');
  assert.equal(mandate.agent_constraint_tier, 'T2');
  assert.equal(mandate.lethal_trifecta_flag, false);
  assert.equal(mandate.id, undefined);
  assert.equal(Object.keys(mandate).includes('id'), false);
});

test('mandates: rowToMandate omits lethal_trifecta_flag when it was not computed', () => {
  const mandate = rowToMandate({
    grant_id: 'g',
    granted_by: 'user:alvin',
    scope: [],
    expiry: '2026-12-01T00:00:00.000Z',
    interval: '1d',
    direction: 'reduce',
    underwriters: ['user:alvin'],
    control_ids: [],
    lethal_trifecta_flag: null,
    triggering_event_type: 'tier_promotion',
    triggering_event_id: 'e1',
    created_at: '2026-11-01T09:00:00.000Z',
    agent_constraint_tier: 'T0',
  });
  assert.equal('lethal_trifecta_flag' in mandate, false);
});

test('mandates: rowToMandate returns null for a non-row', () => {
  assert.equal(rowToMandate(null), null);
  assert.equal(rowToMandate('nope'), null);
});

// --- resolveAgentConstraintTier -------------------------------------------

test('mandates: resolveAgentConstraintTier reads the tier off the tier promotion', async () => {
  const calls = [];
  const conn = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ to_tier: 'T3' }] };
    },
  };
  const resolved = await resolveAgentConstraintTier(conn, {
    triggering_event_type: 'tier_promotion',
    triggering_event_id: '11111111-2222-4333-8444-555555555555',
  });
  assert.equal(resolved.tier, 'T3');
  assert.equal(resolved.source, 'tier-promotion');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /aware_tier_promotions/);
  assert.deepEqual(calls[0].params, ['11111111-2222-4333-8444-555555555555']);
});

test('mandates: resolveAgentConstraintTier falls back to T0 for a non-tier trigger', async () => {
  let queried = false;
  const conn = {
    query: async () => {
      queried = true;
      return { rows: [{ to_tier: 'T4' }] };
    },
  };
  const resolved = await resolveAgentConstraintTier(conn, {
    triggering_event_type: 'pre_tool_block',
    triggering_event_id: '11111111-2222-4333-8444-555555555555',
  });
  assert.equal(resolved.tier, DEFAULT_CONSTRAINT_TIER);
  assert.equal(resolved.source, 'default');
  assert.equal(queried, false, 'a non-tier trigger must not be looked up in the promotion table');
});

test('mandates: resolveAgentConstraintTier falls back to T0 when the event id is not a UUID', async () => {
  let queried = false;
  const conn = {
    query: async () => {
      queried = true;
      return { rows: [{ to_tier: 'T4' }] };
    },
  };
  const resolved = await resolveAgentConstraintTier(conn, {
    triggering_event_type: 'tier_promotion',
    triggering_event_id: 'not-a-uuid',
  });
  assert.equal(resolved.tier, DEFAULT_CONSTRAINT_TIER);
  assert.equal(queried, false);
});

test('mandates: resolveAgentConstraintTier falls back to T0 when the promotion is unknown', async () => {
  const conn = { query: async () => ({ rows: [] }) };
  const resolved = await resolveAgentConstraintTier(conn, {
    triggering_event_type: 'tier_promotion',
    triggering_event_id: '11111111-2222-4333-8444-555555555555',
  });
  assert.equal(resolved.tier, DEFAULT_CONSTRAINT_TIER);
  assert.equal(resolved.source, 'default');
});

test('mandates: resolveAgentConstraintTier degrades to T0 when the lookup throws', async () => {
  const conn = {
    query: async () => {
      throw new Error('relation "aware_tier_promotions" does not exist');
    },
  };
  const resolved = await resolveAgentConstraintTier(conn, {
    triggering_event_type: 'tier_promotion',
    triggering_event_id: '11111111-2222-4333-8444-555555555555',
  });
  assert.equal(resolved.tier, DEFAULT_CONSTRAINT_TIER);
});

test('mandates: resolveAgentConstraintTier ignores a bogus tier value from the DB', async () => {
  const conn = { query: async () => ({ rows: [{ to_tier: 'T9' }] }) };
  const resolved = await resolveAgentConstraintTier(conn, {
    triggering_event_type: 'tier_promotion',
    triggering_event_id: '11111111-2222-4333-8444-555555555555',
  });
  assert.equal(resolved.tier, DEFAULT_CONSTRAINT_TIER);
});

// --- findMandateByTriggeringEventId ---------------------------------------

test('mandates: findMandateByTriggeringEventId returns null without a connection', async () => {
  assert.equal(await findMandateByTriggeringEventId(null, 'e1'), null);
});

test('mandates: findMandateByTriggeringEventId returns null for an empty event id', async () => {
  const conn = { query: async () => ({ rows: [{ grant_id: 'g' }] }) };
  assert.equal(await findMandateByTriggeringEventId(conn, ''), null);
});

test('mandates: findMandateByTriggeringEventId maps the row onto the response shape', async () => {
  let seen = null;
  const conn = {
    query: async (sql, params) => {
      seen = { sql, params };
      return {
        rows: [
          {
            grant_id: 'g-1',
            granted_by: 'user:alvin',
            scope: ['read:document'],
            expiry: '2026-12-01T00:00:00.000Z',
            interval: '1d',
            direction: 'reduce',
            underwriters: ['user:alvin'],
            control_ids: [],
            lethal_trifecta_flag: null,
            triggering_event_type: 'tier_promotion',
            triggering_event_id: 'e1',
            created_at: '2026-11-01T09:00:00.000Z',
            agent_constraint_tier: 'T2',
          },
        ],
      };
    },
  };
  const mandate = await findMandateByTriggeringEventId(conn, 'e1');
  assert.equal(mandate.grant_id, 'g-1');
  assert.equal(mandate.agent_constraint_tier, 'T2');
  assert.match(seen.sql, /aware_mandates/);
  assert.match(seen.sql, /triggering_event_id\s*=\s*\$1/);
  assert.deepEqual(seen.params, ['e1']);
});

test('mandates: findMandateByTriggeringEventId returns null when the query throws', async () => {
  const conn = {
    query: async () => {
      throw new Error('table missing');
    },
  };
  assert.equal(await findMandateByTriggeringEventId(conn, 'e1'), null);
});

// --- recordMandate --------------------------------------------------------

function validMandate(overrides = {}) {
  return {
    grant_id: '11111111-2222-4333-8444-555555555555',
    granted_by: 'user:alvin',
    scope: ['read:document'],
    expiry: '2026-12-01T00:00:00.000Z',
    interval: '1d',
    direction: 'reduce',
    underwriters: ['user:alvin'],
    control_ids: ['IAM-01'],
    triggering_event_type: 'tier_promotion',
    triggering_event_id: 'e1',
    agent_constraint_tier: 'T2',
    created_at: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

test('mandates: recordMandate returns no-connection when conn is null', async () => {
  const r = await recordMandate(null, validMandate());
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'no-connection');
});

test('mandates: recordMandate returns no-connection when conn has no query()', async () => {
  const r = await recordMandate({}, validMandate());
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'no-connection');
});

test('mandates: recordMandate writes a row with the right SQL and params', async () => {
  let seen = null;
  const conn = {
    query: async (sql, params) => {
      seen = { sql, params };
      return {
        rows: [
          {
            grant_id: params[0],
            granted_by: params[3],
            scope: ['read:document'],
            expiry: params[5],
            interval: params[6],
            direction: params[7],
            underwriters: ['user:alvin'],
            control_ids: ['IAM-01'],
            lethal_trifecta_flag: null,
            triggering_event_type: params[2],
            triggering_event_id: params[1],
            created_at: params[12],
            agent_constraint_tier: params[11],
          },
        ],
      };
    },
  };
  const mandate = validMandate();
  const r = await recordMandate(conn, mandate);
  assert.equal(r.recorded, true);
  assert.equal(r.mandate.grant_id, mandate.grant_id);
  assert.match(seen.sql, /INSERT INTO aware_mandates/);
  assert.match(seen.sql, /ON CONFLICT \(triggering_event_id\) DO NOTHING/);
  assert.equal(seen.params[0], mandate.grant_id);
  assert.equal(seen.params[1], mandate.triggering_event_id);
  assert.equal(seen.params[2], mandate.triggering_event_type);
  assert.equal(seen.params[3], mandate.granted_by);
  assert.equal(seen.params[4], JSON.stringify(['read:document']));
  assert.equal(seen.params[5], mandate.expiry);
  assert.equal(seen.params[6], mandate.interval);
  assert.equal(seen.params[7], mandate.direction);
  assert.equal(seen.params[8], JSON.stringify(['user:alvin']));
  assert.equal(seen.params[9], JSON.stringify(['IAM-01']));
  assert.equal(seen.params[11], 'T2');
  assert.equal(seen.params[12], mandate.created_at);
});

test('mandates: recordMandate stores a NULL lethal_trifecta_flag when it was not supplied', async () => {
  let seen = null;
  const conn = {
    query: async (sql, params) => {
      seen = params;
      return { rows: [{}] };
    },
  };
  await recordMandate(conn, validMandate());
  assert.equal(seen[10], null);
});

test('mandates: recordMandate stores the supplied lethal_trifecta_flag', async () => {
  let seen = null;
  const conn = {
    query: async (sql, params) => {
      seen = params;
      return { rows: [{}] };
    },
  };
  await recordMandate(conn, validMandate({ lethal_trifecta_flag: true }));
  assert.equal(seen[10], true);
});

test('mandates: recordMandate defaults the constraint tier to T0', async () => {
  let seen = null;
  const conn = {
    query: async (sql, params) => {
      seen = params;
      return { rows: [{}] };
    },
  };
  const mandate = validMandate();
  delete mandate.agent_constraint_tier;
  await recordMandate(conn, mandate);
  assert.equal(seen[11], 'T0');
});

test('mandates: recordMandate returns duplicate (with the existing grant) on a conflict', async () => {
  const queries = [];
  const conn = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/INSERT/i.test(sql)) return { rows: [] }; // ON CONFLICT DO NOTHING
      return {
        rows: [
          {
            grant_id: 'existing-grant',
            granted_by: 'user:alvin',
            scope: [],
            expiry: '2026-12-01T00:00:00.000Z',
            interval: '1d',
            direction: 'reduce',
            underwriters: ['user:alvin'],
            control_ids: [],
            lethal_trifecta_flag: null,
            triggering_event_type: 'tier_promotion',
            triggering_event_id: 'e1',
            created_at: '2026-11-01T09:00:00.000Z',
            agent_constraint_tier: 'T2',
          },
        ],
      };
    },
  };
  const r = await recordMandate(conn, validMandate());
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'duplicate');
  assert.equal(r.mandate.grant_id, 'existing-grant');
  assert.equal(queries.length, 2, 'the duplicate path must re-read the existing grant');
});

test('mandates: recordMandate treats a 23505 unique violation as a duplicate', async () => {
  const queries = [];
  const conn = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/INSERT/i.test(sql)) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      return {
        rows: [
          {
            grant_id: 'existing-grant',
            granted_by: 'user:alvin',
            scope: [],
            expiry: '2026-12-01T00:00:00.000Z',
            interval: '1d',
            direction: 'reduce',
            underwriters: ['user:alvin'],
            control_ids: [],
            lethal_trifecta_flag: null,
            triggering_event_type: 'tier_promotion',
            triggering_event_id: 'e1',
            created_at: '2026-11-01T09:00:00.000Z',
            agent_constraint_tier: 'T2',
          },
        ],
      };
    },
  };
  const r = await recordMandate(conn, validMandate());
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'duplicate');
  assert.equal(r.mandate.grant_id, 'existing-grant');
});

test('mandates: recordMandate reports a non-23505 error as insert-failed', async () => {
  const conn = {
    query: async () => {
      const err = new Error('connection terminated');
      err.code = '57P01';
      throw err;
    },
  };
  const r = await recordMandate(conn, validMandate());
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'insert-failed');
  assert.match(r.error, /connection terminated/);
});

test('mandates: recordMandate never throws on bad input — always returns a structured result', async () => {
  const conn = { query: async () => ({ rows: [{}] }) };
  for (const bad of [null, undefined, {}, { grant_id: 'g' }]) {
    const r = await recordMandate(conn, bad);
    assert.equal(r.recorded, false);
    assert.equal(typeof r.reason, 'string');
  }
});

test('mandates: recordMandate rejects an invalid interval', async () => {
  const r = await recordMandate({ query: async () => ({ rows: [] }) }, validMandate({ interval: '2h' }));
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'invalid-interval');
});

test('mandates: recordMandate rejects an invalid direction', async () => {
  const r = await recordMandate({ query: async () => ({ rows: [] }) }, validMandate({ direction: 'deny' }));
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'invalid-direction');
});

test('mandates: recordMandate rejects an invalid triggering_event_type', async () => {
  const r = await recordMandate(
    { query: async () => ({ rows: [] }) },
    validMandate({ triggering_event_type: 'tier-demotion' })
  );
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'invalid-triggering_event_type');
});

test('mandates: recordMandate rejects an empty underwriters array', async () => {
  const r = await recordMandate({ query: async () => ({ rows: [] }) }, validMandate({ underwriters: [] }));
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'invalid-underwriters');
});

test('mandates: recordMandate rejects a non-array scope', async () => {
  const r = await recordMandate({ query: async () => ({ rows: [] }) }, validMandate({ scope: 'read' }));
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'invalid-scope');
});

test('mandates: recordMandate rejects an invalid agent_constraint_tier', async () => {
  const r = await recordMandate(
    { query: async () => ({ rows: [] }) },
    validMandate({ agent_constraint_tier: 'T9' })
  );
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'invalid-agent_constraint_tier');
});

test('mandates: src/db/index.js re-exports the mandate writer and helpers', async () => {
  const mod = await import('../../../src/db/index.js');
  assert.equal(typeof mod.recordMandate, 'function');
  assert.equal(typeof mod.findMandateByTriggeringEventId, 'function');
  assert.equal(typeof mod.resolveAgentConstraintTier, 'function');
  assert.equal(typeof mod.buildGrantId, 'function');
  assert.equal(typeof mod.rowToMandate, 'function');
});
