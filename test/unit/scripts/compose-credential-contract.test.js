// test/unit/scripts/compose-credential-contract.test.js
//
// Regression guard for the AWARE v2 compose credential contract.
//
// ADR-083. The defect this guards against was NOT "the compose file
// interpolates a key from the shell". It was that Docker Compose merges
// `environment:` and `env_file:` into ONE container environment and
// `environment:` WINS on every key it names. The compose file declared
// `LLM_API_KEY=*** `environment:` while ALSO declaring an
// `env_file:` pointing at the operator's credential store. The store's
// value was therefore dead code: the coordinator received the EMPTY
// string, the online-mode guard at src/config/index.cjs:436 fired, and
// the container crash-looped.
//
// A second, independent defect: `env_file: required: false` made a
// missing credential store a soft dependency, so the failure presented as
// a restart loop naming the KEY rather than a compose error naming the
// missing FILE.
//
// A third: `aware-2-ui` depends on `gateway`, which lives behind the
// "full" profile, so `docker compose up -d` without `--profile full`
// failed with "depends on undefined service".
//
// These are STATIC assertions on the compose file. They need no Docker
// daemon, no network, and no credentials. The behavioural half of the
// contract (a missing store creates ZERO containers and names the file)
// is verified live on the kanban card; this test is the cheap guard that
// stops the file drifting back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const COMPOSE_PATH = path.join(REPO_ROOT, 'docker-compose.coordinator.yml');

const raw = fs.readFileSync(COMPOSE_PATH, 'utf8');
const compose = yaml.load(raw);
const services = compose.services;

// The keys the credential store owns. Declaring any of these in a
// service's `environment:` block silently overrides the store's value
// and makes the store's entry dead code for that key.
//
// AWARE_POSTGRES_PASSWORD is deliberately NOT in this list: the postgres
// password is baked into the postgres data volume at INIT time, so it
// cannot be re-read from the store without invalidating the password the
// existing volume was created with. It stays in `environment:` and is
// paired with postgres's own POSTGRES_PASSWORD by a separate assertion.
const STORE_OWNED_SECRETS = [
  'LLM_API_KEY',
  'MINIMAX_API_KEY',
  'AWARE_COORDINATOR_TOKEN',
];

// Services that read the credential store.
const STORE_CONSUMERS = ['gateway', 'coordinator', 'trainer'];

// --- helpers ---------------------------------------------------------

function envKeys(service) {
  const env = services[service].environment || [];
  return env.map((e) => String(e).split('=')[0]);
}

function envEntry(service, key) {
  const env = services[service].environment || [];
  return env.find((e) => String(e).split('=')[0] === key);
}

function envFilePath(service) {
  const entries = services[service].env_file || [];
  assert.equal(entries.length, 1, `${service} must have exactly one env_file entry`);
  return entries[0].path;
}

function envFileRequired(service) {
  const entries = services[service].env_file || [];
  assert.equal(entries.length, 1, `${service} must have exactly one env_file entry`);
  return entries[0].required;
}

// --- ADR-083 D1: no `environment:` entry may shadow a store-owned secret

test('ADR-083: no service re-declares a store-owned secret in environment:', () => {
  for (const service of STORE_CONSUMERS) {
    const keys = envKeys(service);
    for (const secret of STORE_OWNED_SECRETS) {
      assert.ok(
        !keys.includes(secret),
        `${service}.environment declares ${secret}, which OVERRIDES the ` +
        `credential store's value (Compose gives environment: precedence ` +
        `over env_file:). The store is the single source of truth for ` +
        `${secret}; it must not be declared in environment:.`
      );
    }
  }
});

test('ADR-083: the coordinator does not shadow the provider key or the token', () => {
  // Named explicitly because the coordinator is the service that crash-looped.
  assert.equal(envEntry('coordinator', 'LLM_API_KEY'), undefined);
  assert.equal(envEntry('coordinator', 'MINIMAX_API_KEY'), undefined);
  assert.equal(envEntry('coordinator', 'AWARE_COORDINATOR_TOKEN'), undefined);
});

test('ADR-083: the gateway does not shadow the bearer token', () => {
  assert.equal(envEntry('gateway', 'AWARE_COORDINATOR_TOKEN'), undefined);
});

test('ADR-083: the trainer does not shadow the bearer token', () => {
  assert.equal(envEntry('trainer', 'AWARE_COORDINATOR_TOKEN'), undefined);
});

// --- ADR-083 D3: the credential store is required, and the default is loud

test('ADR-083: every store consumer requires the credential file by default', () => {
  for (const service of STORE_CONSUMERS) {
    const required = envFileRequired(service);
    assert.ok(
      typeof required === 'string' && required.includes('true'),
      `${service}.env_file.required must interpolate to true by default ` +
      `(got ${JSON.stringify(required)}). With required:false a missing ` +
      `credential store produces a crash-loop naming the KEY instead of a ` +
      `compose error naming the missing FILE.`
    );
    assert.ok(
      String(required).includes('AWARE_CREDENTIALS_REQUIRED'),
      `${service}.env_file.required must expose the AWARE_CREDENTIALS_REQUIRED ` +
      `escape hatch so an operator can deliberately boot soft (got ${JSON.stringify(required)}).`
    );
  }
});

test('ADR-083: the credential path default resolves to a real location', () => {
  for (const service of STORE_CONSUMERS) {
    const p = envFilePath(service);
    assert.ok(
      p.includes('AWARE_CREDENTIALS_FILE'),
      `${service}.env_file.path must be operator-overridable via AWARE_CREDENTIALS_FILE ` +
      `(got ${p}).`
    );
    assert.ok(
      !p.includes('redacted-credential-dir'),
      `${service}.env_file.path still points at the placeholder ` +
      `"redacted-credential-dir" (got ${p}). That directory has never ` +
      `existed in this repo's history and never existed on any host; it is ` +
      `a redaction artifact, not a path.`
    );
    assert.ok(
      p.includes('.aware/credentials.env'),
      `${service}.env_file.path must default to the canonical store ` +
      `location (got ${p}).`
    );
  }
});

test('ADR-083: all three store consumers resolve the SAME credential file', () => {
  const paths = STORE_CONSUMERS.map(envFilePath);
  assert.equal(
    new Set(paths).size,
    1,
    `the store consumers must agree on one credential file, otherwise a ` +
    `missing store produces different messages per service. Got: ${paths.join(' | ')}`
  );
});

// --- ADR-083 D5: the profile sets are coherent

test('ADR-083: a service never depends on a service in a different profile', () => {
  // The defect: aware-2-ui (default set) depends_on gateway ("full" set),
  // so `docker compose up -d` failed with
  //   service "aware-2-ui" depends on undefined service "gateway"
  for (const [name, svc] of Object.entries(services)) {
    const depends = svc.depends_on;
    if (!depends) continue;
    const deps = Array.isArray(depends)
      ? depends
      : Object.entries(depends).map(([k]) => k);
    const own = new Set(svc.profiles || []);
    for (const dep of deps) {
      const depSvc = services[dep];
      if (!depSvc) continue;
      const depProfiles = new Set(depSvc.profiles || []);
      // The dependency is reachable from this service's profile set if the
      // service shares a profile with it, or if the dependency is in the
      // default set (no profiles).
      const depIsDefault = depProfiles.size === 0;
      const shares = [...own].some((p) => depProfiles.has(p));
      assert.ok(
        depIsDefault || shares || own.size === 0,
        `${name} (profiles: ${[...own].join(',') || 'default'}) depends on ` +
        `${dep} (profiles: ${[...depProfiles].join(',') || 'default'}), which ` +
        `it cannot reach. Compose fails with "depends on undefined service".`
      );
    }
  }
});

test('ADR-083: aware-2-ui and gateway are in the same profile set', () => {
  const ui = new Set(services['aware-2-ui'].profiles || []);
  const gw = new Set(services.gateway.profiles || []);
  const shares = [...ui].some((p) => gw.has(p));
  assert.ok(shares, 'aware-2-ui and gateway must share a profile');
});

// --- the postgres password pair

test('ADR-083: the coordinator and postgres agree on the database password', () => {
  const coord = envEntry('coordinator', 'AWARE_POSTGRES_PASSWORD');
  const pg = envEntry('postgres', 'POSTGRES_PASSWORD');
  assert.ok(coord, 'coordinator must declare AWARE_POSTGRES_PASSWORD');
  assert.ok(pg, 'postgres must declare POSTGRES_PASSWORD');
  assert.equal(
    String(coord).split('=').slice(1).join('='),
    String(pg).split('=').slice(1).join('='),
    'the coordinator and the postgres service must resolve the SAME ' +
    'password expression. The postgres volume is initialised with the ' +
    'postgres value and the coordinator authenticates with its own; if ' +
    'they drift, every coordinator query fails with an auth error.'
  );
});

// --- the file must not reintroduce the redaction artifact

test('ADR-083: no redacted-credential placeholder survives in the compose file', () => {
  const hits = raw.match(/redacted-credential[a-z-]*/g);
  assert.equal(
    hits,
    null,
    `the compose file still contains redaction placeholders: ${hits}. ` +
    `These are redaction ARTIFACTS (a sanitize pass rewrote a live path), ` +
    `not paths. See ADR-083 §1.2.`
  );
});
