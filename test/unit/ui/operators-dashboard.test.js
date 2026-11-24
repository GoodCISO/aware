/**
 * Operators dashboard (OHI) — behaviour and discipline guards.
 *
 * Card: t_1980c9b1. Four things are guarded here, and each one is a
 * failure mode this screen actually has:
 *
 *   1. THE SCORE DIRECTION. The scorer's score is an ANOMALY score: 0.0
 *      is "matches the operator's baseline", 1.0 is "every axis fired".
 *      The gateway HOLDS at 0.7 and BLOCKS at 0.9. So a HIGH recorded score
 *      is a BAD operator, and the trust ramp must INVERT. A screen that
 *      paints a blocked operator green is worse than no screen, so the
 *      inversion is pinned here.
 *
 *   2. THE OHI/NHI VOCABULARY BOUNDARY. This screen is about OPERATORS
 *      (humans). "NHI" belongs to the agent screens. A wrong noun in the
 *      wrong screen is the exact confusion the OHI term exists to prevent.
 *
 *   3. THE v0 DIARY SHAPE. The v1 diary table has no operator column and
 *      no score column -- the producer stringifies its payload into
 *      `content`. The parser therefore has to read the operator identity
 *      and the score back out of a JSON string, and it has to EXCLUDE rows
 *      that belong to a different entity kind (that is what keeps agent
 *      traffic out of an operator screen).
 *
 *   4. THE TOKEN DISCIPLINE. The screen must consume theme tokens, never
 *      hex literals, and the shared gauge must be the ONLY gauge.
 *
 * The card's AC5 names `--color-trust-high/medium/low`. Those CSS custom
 * properties exist only in the archived S1 DESIGN.md and were never
 * implemented as MUI theme tokens in this repo, so the guard here asserts
 * what the repo actually ships: the semantic palette, used by NAME.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { operators } = require('../helpers/ui-esm');

const UI_SRC = path.join(__dirname, '..', '..', '..', 'src', 'ui', 'src');
const OPERATORS_DIR = path.join(UI_SRC, 'containers', 'Operators');

let O;
test.before(async () => {
  O = await operators();
});

const read = (rel) => fs.readFileSync(path.join(UI_SRC, rel), 'utf8');

/** The four files the card's AC1 requires. */
const REQUIRED_FILES = [
  'containers/Operators/index.js',
  'containers/Operators/OperatorList.js',
  'containers/Operators/OperatorDetail.js',
  'containers/Operators/OperatorSparkline.js',
];

// ─── AC1: the directory and its four files exist ────────────────────────────

test('AC1: the Operators screen directory has all four required files', () => {
  for (const rel of REQUIRED_FILES) {
    assert.ok(fs.existsSync(path.join(UI_SRC, rel)), `missing ${rel}`);
  }
});

// ─── The score direction ───────────────────────────────────────────────────

test('a high recorded score is a LOW trust band (the ramp inverts)', () => {
  // 0.95 -> the gateway BLOCKS this operator. It must not read as "high".
  assert.equal(O.bandForAnomalyScore(0.95), O.TRUST_BAND_LOW);
  assert.equal(O.bandForAnomalyScore(0.7), O.TRUST_BAND_LOW);
  // 0.5 -> logged to the operator profile.
  assert.equal(O.bandForAnomalyScore(0.5), O.TRUST_BAND_MEDIUM);
  assert.equal(O.bandForAnomalyScore(0.4), O.TRUST_BAND_MEDIUM);
  // 0.1 -> matches the baseline.
  assert.equal(O.bandForAnomalyScore(0.1), O.TRUST_BAND_HIGH);
  assert.equal(O.bandForAnomalyScore(0), O.TRUST_BAND_HIGH);
});

test('the band cut points are the ones the card names', () => {
  // AC3 names 0.4 and 0.7. If these move, the screen and the card have
  // drifted apart silently.
  assert.equal(O.TRUST_SCORE_MEDIUM_FLOOR, 0.4);
  assert.equal(O.TRUST_SCORE_LOW_FLOOR, 0.7);
});

test('an unreadable score resolves to LOW trust, never to high', () => {
  // A score this screen cannot read is not evidence the operator is
  // behaving. Defaulting to "high trust" would be the dangerous default.
  assert.equal(O.bandForAnomalyScore(NaN), O.TRUST_BAND_LOW);
  assert.equal(O.bandForAnomalyScore(undefined), O.TRUST_BAND_LOW);
  assert.equal(O.bandForAnomalyScore(null), O.TRUST_BAND_LOW);
  assert.equal(O.bandForAnomalyScore('not-a-number'), O.TRUST_BAND_LOW);
});

test('the agent trust band keeps the agent screen\'s own cut points', () => {
  // Zero-visual-change for the agent screen: the original gauge used
  // >80 high, >50 medium, else low.
  assert.equal(O.trustBandForTrustScore(92), O.TRUST_BAND_HIGH);
  assert.equal(O.trustBandForTrustScore(81), O.TRUST_BAND_HIGH);
  assert.equal(O.trustBandForTrustScore(80), O.TRUST_BAND_MEDIUM);
  assert.equal(O.trustBandForTrustScore(51), O.TRUST_BAND_MEDIUM);
  assert.equal(O.trustBandForTrustScore(50), O.TRUST_BAND_LOW);
  assert.equal(O.trustBandForTrustScore(0), O.TRUST_BAND_LOW);
});

// ─── The v0 diary shape ────────────────────────────────────────────────────

const entry = (content, createdAt, id = 'e1') => ({
  id,
  agent_id: 'unknown',
  content: typeof content === 'string' ? content : JSON.stringify(content),
  created_at: createdAt,
});

test('an operator row is parsed out of the stringified v0 content', () => {
  const parsed = O.parseDiaryEntry(
    entry({ entity_kind: 'operator', operator_id: 'op-7', score: 0.82, action: 'hold' }, 1700000000),
  );
  assert.ok(parsed);
  assert.equal(parsed.operatorId, 'op-7');
  assert.equal(parsed.score, 0.82);
  assert.equal(parsed.band, O.TRUST_BAND_LOW);
  assert.equal(parsed.action, 'hold');
});

test('the v0 producer shape (operator_id + score, no entity_kind) is accepted', () => {
  // The v0 wrapper carries no discriminator; that is the shape the
  // producer actually emits today.
  const parsed = O.parseDiaryEntry(
    entry({ operator_id: 'op-9', score: 0.1 }, 1700000000),
  );
  assert.ok(parsed);
  assert.equal(parsed.operatorId, 'op-9');
});

test('a row for a DIFFERENT entity kind is not an operator row', () => {
  // This is what keeps agent (NHI) traffic out of the operator screen.
  assert.equal(
    O.parseDiaryEntry(entry({ entity_kind: 'agent', agent_id: 'a-1', score: 0.5 }, 1700000000)),
    null,
  );
  assert.equal(
    O.parseDiaryEntry(entry({ entity_kind: 'cluster', score: 0.5 }, 1700000000)),
    null,
  );
});

test('unparseable content is not an operator row', () => {
  assert.equal(O.parseDiaryEntry(entry('not json at all', 1700000000)), null);
  assert.equal(O.parseDiaryEntry(entry({}, 1700000000)), null);
  assert.equal(O.parseDiaryEntry(null), null);
});

test('operator records carry their score history in ascending time order', () => {
  const records = O.collectOperators([
    entry({ entity_kind: 'operator', operator_id: 'op-1', score: 0.2 }, 300, 'c'),
    entry({ entity_kind: 'operator', operator_id: 'op-1', score: 0.9 }, 100, 'a'),
    entry({ entity_kind: 'operator', operator_id: 'op-1', score: 0.5 }, 200, 'b'),
  ]);
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.samples.length, 3);
  assert.deepEqual(rec.samples.map((s) => s.createdAt), [100, 200, 300]);
  // The LATEST sample decides the band -- an operator who was fine an hour
  // ago and is being blocked now is low trust now.
  assert.equal(rec.latestCreatedAt, 300);
  assert.equal(rec.latestScore, 0.2);
  assert.equal(rec.latestBand, O.TRUST_BAND_HIGH);
});

test('records are ordered most-recently-scored first', () => {
  const records = O.collectOperators([
    entry({ entity_kind: 'operator', operator_id: 'old', score: 0.1 }, 100),
    entry({ entity_kind: 'operator', operator_id: 'new', score: 0.1 }, 900),
  ]);
  assert.deepEqual(records.map((r) => r.operatorId), ['new', 'old']);
});

test('findOperator locates one operator and returns null for an unknown one', () => {
  const records = O.collectOperators([
    entry({ entity_kind: 'operator', operator_id: 'op-1', score: 0.1 }, 100),
  ]);
  assert.equal(O.findOperator(records, 'op-1').operatorId, 'op-1');
  assert.equal(O.findOperator(records, 'nope'), null);
});

// ─── Pagination ────────────────────────────────────────────────────────────

test('the list paginates at 50 rows per page', () => {
  assert.equal(O.OPERATOR_PAGE_SIZE, 50);
  const many = Array.from({ length: 120 }, (_, i) =>
    entry({ entity_kind: 'operator', operator_id: `op-${i}`, score: 0.1 }, 1000 + i),
  );
  const records = O.collectOperators(many);
  assert.equal(records.length, 120);
  const first = O.paginate(records, 0, O.OPERATOR_PAGE_SIZE);
  assert.equal(first.rows.length, 50);
  assert.equal(first.totalPages, 3);
  const last = O.paginate(records, 2, O.OPERATOR_PAGE_SIZE);
  assert.equal(last.rows.length, 20);
});

test('an out-of-range page is clamped, not an empty screen', () => {
  const records = O.collectOperators([
    entry({ entity_kind: 'operator', operator_id: 'op-1', score: 0.1 }, 100),
  ]);
  const view = O.paginate(records, 99, O.OPERATOR_PAGE_SIZE);
  assert.equal(view.page, 0);
  assert.equal(view.rows.length, 1);
  assert.equal(view.totalPages, 1);
});

// ─── Vocabulary (OHI, never NHI) ───────────────────────────────────────────

test('the Operators screen speaks OHI, never NHI', () => {
  // The screen is about humans. "NHI" belongs to the agent screens.
  const offenders = [];
  for (const rel of REQUIRED_FILES) {
    const src = read(rel);
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (/\bNHI\b/.test(code) || /\bnon-human\b/i.test(code)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'the Operators screen must use OHI (Operator / Human Identity) vocabulary; '
    + 'NHI belongs to the agent screens:\n' + offenders.join('\n'));
});

test('the Operators screen uses no RAMM / RiskMandate vocabulary', () => {
  // The user rule (2026-07-07) forbids RAMM vocabulary re-entering AWARE.
  const offenders = [];
  for (const rel of REQUIRED_FILES) {
    const src = read(rel);
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (/ramm|riskmandate|underwriters|control_ids/i.test(code)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'RAMM / RiskMandate vocabulary is forbidden in AWARE:\n' + offenders.join('\n'));
});

test('the screen says OHI explicitly, so the vocabulary is not merely absent', () => {
  const src = read('containers/Operators/index.js') + read('constants/operators.js');
  assert.match(src, /OHI/,
    'the screen must name its vocabulary (OHI), not merely avoid the wrong one');
});

// ─── AC4: ONE gauge, parameterized on entity kind ──────────────────────────

test('AC4: there is exactly ONE gauge component and it is parameterized on entity kind', () => {
  const gaugePath = path.join(UI_SRC, 'components', 'TrustGauge.js');
  assert.ok(fs.existsSync(gaugePath), 'the shared TrustGauge component is missing');

  const gauge = fs.readFileSync(gaugePath, 'utf8');
  assert.match(gauge, /entityKind/,
    'the gauge must be parameterized on the entity kind');
  // The gauge defaults to the agent unit and BRANCHES on 'operator' -- it
  // is one component with two vocabularies, not two components.
  assert.match(gauge, /entityKind\s*=\s*'agent'/);
  assert.match(gauge, /entityKind\s*===\s*'operator'/);

  // No second gauge: nothing else may declare a trust gauge.
  const containers = fs.readdirSync(OPERATORS_DIR);
  for (const name of containers) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(OPERATORS_DIR, name), 'utf8');
    assert.doesNotMatch(src, /<LinearProgress/,
      `${name} declares its own gauge; reuse components/TrustGauge.js (AC4)`);
  }
});

test('AC4: the agent screen uses the SAME shared gauge', () => {
  const src = read('components/AgentIdentityDashboard.js');
  assert.match(src, /from '\.\/TrustGauge'/,
    'the agent screen must use the shared TrustGauge, not a private copy');
  assert.doesNotMatch(src, /<LinearProgress/,
    'the agent screen still declares its own gauge');
});

test('the gauge colour comes from the theme, by token name', () => {
  const gauge = read('components/TrustGauge.js');
  assert.match(gauge, /success/);
  assert.match(gauge, /warning/);
  assert.match(gauge, /error/);
  // And it must not hard-code a colour.
  assert.doesNotMatch(gauge.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' '),
    /#[0-9a-fA-F]{6}\b/,
    'the gauge must consume theme tokens by name, never a hex literal');
});

// ─── AC5: token discipline ─────────────────────────────────────────────────

test('AC5: the Operators screen contains no hex colour literals', () => {
  const offenders = [];
  for (const rel of REQUIRED_FILES) {
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    src.split('\n').forEach((line, i) => {
      const hexes = line.match(/#[0-9a-fA-F]{6}\b/g) || [];
      for (const hex of hexes) {
        offenders.push(`${rel}:${i + 1}  ${hex}  |  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'hand-copied colour literals in the Operators screen; consume a theme token:\n'
    + offenders.join('\n'));
});

test('AC5: the Operators screen contains no hand-decoded rgba() literals', () => {
  const offenders = [];
  for (const rel of REQUIRED_FILES) {
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    src.split('\n').forEach((line, i) => {
      if (/rgba?\s*\(/.test(line)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'hand-decoded alpha literals in the Operators screen:\n' + offenders.join('\n'));
});

test('AC5: no new colour tokens are introduced', () => {
  // The screen must reuse the existing palette, not mint a new token. The
  // theme's palette is the only place a colour is allowed to be named.
  const theme = read('styles/theme.js');
  assert.doesNotMatch(
    read('constants/operators.js'),
    /#[0-9a-fA-F]{3,8}\b/,
    'the operators constants module must not declare a colour literal',
  );
  assert.ok(theme.length > 0);
});

// ─── AC6: the screen is wired into the app ────────────────────────────────

test('AC6: the Operators screen is routed and reachable from the nav', () => {
  const app = read('App.js');
  assert.match(app, /from '\.\/containers\/Operators'/);
  assert.match(app, /path="operators"/);

  const sidebar = read('components/AppSidebar.js');
  assert.match(sidebar, /path: '\/operators'/);
  assert.match(sidebar, /text: 'Operators'/);
});

test('the nav does not label the operator screen as an agent screen', () => {
  // "Agent Identity" is the NHI row. An operator screen wearing that label
  // is how a human gets mistaken for an agent.
  const sidebar = read('components/AppSidebar.js');
  const operatorRow = sidebar.split('\n').find((l) => l.includes("path: '/operators'"));
  assert.ok(operatorRow, 'the operators nav row is missing');
  assert.doesNotMatch(operatorRow, /Agent/i);
});

// ─── The screen reads the v1 diary table ───────────────────────────────────

test('the screen reads the v1 diary entries endpoint', () => {
  const api = read('services/api.js');
  assert.match(api, /diaryAPI/);
  assert.match(api, /\/diary\/entries/);
});

// ─── The import graph resolves ────────────────────────────────────────────
//
// THIS GUARD EXISTS BECAUSE THE SCREEN WAS BROKEN AND NOTHING CAUGHT IT.
//
// OperatorSparkline.js imported `../components/TrustGauge` and
// `../constants/operators` from src/ui/src/containers/Operators/ -- one
// level short. Every other test in this file passed anyway, because they
// either read the file as TEXT or import the constants module directly by
// path. Nothing ever RESOLVED the screen's import graph, so a screen that
// could not compile was "green".
//
// The production build caught it:
//   Module not found: Error: Can't resolve '../components/TrustGauge'
//        in '.../src/ui/src/containers/Operators'
//
// so this guard resolves every RELATIVE import in the four screen files
// against the filesystem. It is cheap, it needs no bundler, and it fails on
// exactly the defect the build failed on.

const RELATIVE_IMPORT = /from\s+['"](\.[^'"]+)['"]/g;

/** Resolve a relative import specifier the way webpack would. */
const resolveImport = (fromFile, specifier) => {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.jsx`, `${base}.ts`, `${base}.tsx`,
    path.join(base, 'index.js'), path.join(base, 'index.jsx')];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
};

test('every relative import in the Operators screen resolves to a real file', () => {
  const unresolved = [];
  for (const rel of REQUIRED_FILES) {
    const file = path.join(UI_SRC, rel);
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1];
      if (!resolveImport(file, specifier)) {
        unresolved.push(`${rel}  ->  ${specifier}`);
      }
    }
  }
  assert.deepEqual(unresolved, [],
    'the Operators screen has unresolvable imports (the production build '
    + 'fails on these):\n' + unresolved.join('\n'));
});

test('the import-resolution guard can actually FAIL -- it is not a no-op', () => {
  // A guard that cannot fail reads as clean while the file is broken.
  const good = path.join(UI_SRC, 'containers', 'Operators', 'OperatorSparkline.js');
  assert.ok(resolveImport(good, '../../components/TrustGauge'),
    'the guard cannot resolve a KNOWN-GOOD import');
  assert.equal(resolveImport(good, '../components/TrustGauge'), null,
    'the guard cannot detect the known-BAD import');
});

// ─── The guard is not vacuous ──────────────────────────────────────────────

test('the scans above walk real files, not an empty path', () => {
  for (const rel of REQUIRED_FILES) {
    assert.ok(fs.existsSync(path.join(UI_SRC, rel)), `scan is missing ${rel}`);
  }
  // And the vocabulary guard can actually FAIL -- a scan that cannot see
  // the word reads as clean while the word is there.
  const offender = 'const x = "NHI";';
  const caught = /\bNHI\b/.test(offender);
  assert.ok(caught, 'the NHI scan is a no-op');
});
