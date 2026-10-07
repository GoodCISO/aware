/**
 * Domain colour aliases: governance invariants (t_6839c54a).
 *
 * `secondary.main` served three unrelated semantic domains. These tests pin
 * the properties that make the split safe, and the one that makes it mean
 * something:
 *
 *   - every alias is a perfect twin of the token it shadows (zero visual
 *     change -- the card's AC1/AC3);
 *   - each alias carries the fields MUI's own components require, because a
 *     missing `contrastText` is not a styling nit, it is a render-time throw;
 *   - the aliases are FLAT keys, since Chip and SvgIcon index the palette by
 *     literal name and cannot walk a dotted path;
 *   - the domains are distinct, i.e. the three names are not three labels for
 *     one token, so a future re-hue of one is a one-line change.
 *
 * The UI modules are ESM (react-scripts' webpack has no CJS named-export
 * interop) and the test runner is CommonJS `node --test`, so they arrive via
 * the test-only bridge. See helpers/ui-esm.js.
 *
 * Colour maths is implemented here rather than pulled from a dependency: the
 * project has no colour package, and a test that silently skips when a helper
 * is missing is worse than no test.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { domainAliases } = require('../helpers/ui-esm');

const UI_SRC = path.join(__dirname, '..', '..', '..', 'src', 'ui', 'src');

let ALIASES, SECONDARY, KINDS;
test.before(async () => {
  ({ DOMAIN_ALIASES: ALIASES, SECONDARY: SECONDARY, DOMAIN_KIND: KINDS } =
    await domainAliases());
});

const ALIAS_NAMES = ['constraintT3', 'metricValue', 'auditDecision'];

// The surfaces the alias text sits on -- must match theme.js background tokens.
const BG_DEFAULT = '#0a1929';
const BG_PAPER = '#132f4c';

const hexToRgb = (hex) => {
  const s = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`bad hex: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const relLuminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const l1 = relLuminance(a);
  const l2 = relLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

// ---- the three domains are named and distinct ----

test('all three domains have their own alias', () => {
  assert.deepEqual(Object.keys(ALIASES).sort(), [...ALIAS_NAMES].sort(),
    'the card requires an alias per domain; the audit-trail chip is the one ' +
    'the original audit missed and the one that must not share the tier token');
});

test('the three aliases are three names, not three references to one object', () => {
  // Shared identity would mean a mutation to one moves the others, i.e. the
  // aliases would be decorative and the blast radius would be unchanged.
  for (const a of ALIAS_NAMES) {
    for (const b of ALIAS_NAMES) {
      if (a === b) continue;
      assert.notEqual(ALIASES[a], ALIASES[b],
        `${a} and ${b} are the same object; each domain needs its own token`);
    }
  }
});

test('each alias declares whether its domain is ordinal or nominal', () => {
  // The whole point of the split is the ordinal/nominal distinction. A future
  // reader must be able to see which is which without opening this file, so
  // the classification is data, not prose.
  assert.equal(KINDS.constraintT3, 'ordinal',
    'the T3 step belongs to the T0-T4 ranking and is ordinal');
  assert.equal(KINDS.auditDecision, 'nominal',
    'the request/response/decision axis is categorical, not a rank');
  assert.ok(ALIAS_NAMES.every((n) => KINDS[n]),
    'every alias must be classified, or the distinction is not enforced');
});

// ---- zero visual change: every alias is a perfect twin of `secondary` ----

test('every alias resolves to the same hex as secondary (zero visual change)', () => {
  for (const name of ALIAS_NAMES) {
    assert.equal(ALIASES[name].main, SECONDARY.main,
      `${name}.main is ${ALIASES[name].main}, secondary.main is ${SECONDARY.main}; ` +
      'this card is token governance, NOT a colour change');
  }
});

test('the #a180ff value itself is unchanged by this refactor', () => {
  // Hard-coded on purpose: this is the value the card forbids changing, and a
  // self-derived assertion would follow any edit of the token.
  assert.equal(SECONDARY.main, '#a180ff');
});

test('every alias is a full twin -- main, light, dark and contrastText all match', () => {
  // A partial twin is a silent visual change: Chip reads .contrastText and
  // .dark, Typography and SvgIcon read .main. Copying only `main` is the
  // obvious way to get this wrong.
  for (const name of ALIAS_NAMES) {
    for (const field of ['main', 'light', 'dark', 'contrastText']) {
      assert.equal(ALIASES[name][field], SECONDARY[field],
        `${name}.${field} is ${JSON.stringify(ALIASES[name][field])}, ` +
        `secondary.${field} is ${JSON.stringify(SECONDARY[field])}; ` +
        'a partial copy is a partial visual change');
    }
  }
});

test('every alias carries the contrastText Chip calls alpha() on', () => {
  // MUI derives contrastText only for its six built-in colour names
  // (createPalette.js). A custom key gets undefined, and Chip.js:167 calls
  // alpha(undefined), which throws during render rather than degrading.
  for (const name of ALIAS_NAMES) {
    assert.ok(ALIASES[name].contrastText,
      `${name} has no contrastText; <Chip color="${name}"> would throw at render`);
  }
});

test('the aliases inherit AA body-text contrast on both surfaces', () => {
  // Figures quoted in the card and in domainAliases.js, recomputed here so a
  // future token edit cannot leave a stale claim in the comments.
  for (const name of ALIAS_NAMES) {
    const onDefault = contrast(ALIASES[name].main, BG_DEFAULT);
    const onPaper = contrast(ALIASES[name].main, BG_PAPER);
    assert.ok(onDefault >= 4.5,
      `${name} is ${onDefault.toFixed(2)}:1 on background.default, below AA body text`);
    assert.ok(onPaper >= 4.5,
      `${name} is ${onPaper.toFixed(2)}:1 on background.paper, below AA body text`);
  }
});

test('documented contrast figures match the committed hex', () => {
  // theme.js/domainAliases.js state 5.95:1 and 4.58:1. Pin them so the prose
  // cannot drift from the value. Tolerance is tight because these are
  // deterministic functions of the committed hex.
  const onDefault = contrast(SECONDARY.main, BG_DEFAULT);
  const onPaper = contrast(SECONDARY.main, BG_PAPER);
  assert.ok(Math.abs(onDefault - 5.95) <= 0.02,
    `contrast on default is ${onDefault.toFixed(2)}, documented as 5.95`);
  assert.ok(Math.abs(onPaper - 4.58) <= 0.02,
    `contrast on paper is ${onPaper.toFixed(2)}, documented as 4.58`);
});

// ---- the shape constraint that makes the aliases consumable ----

test('aliases are flat palette keys, never dotted paths', () => {
  // Chip.js:168 and SvgIcon.js:60 evaluate `theme.palette[color]`, which does
  // not traverse a path. A key containing a dot is looked up literally and
  // resolves to undefined, so a nested `constraint.t3` alias would throw.
  for (const name of ALIAS_NAMES) {
    assert.ok(!name.includes('.'),
      `"${name}" contains a dot; MUI indexes the palette by literal key name ` +
      'and cannot resolve a nested path');
  }
});

// ---- the render sites actually reference the aliases ----

test('no render site references the bare secondary token for a domain colour', () => {
  // Guards the refactor itself. `text.secondary` is a different thing
  // entirely (MUI's text ramp) and is legitimate everywhere, so it is
  // excluded rather than blanket-banned.
  const files = [
    'components/ConstraintEnforcementView.js',
    'components/AuditTrailViewer.js',
    'components/MetricsCard.js',
    'containers/DashboardContainer.js',
  ];
  const offenders = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(UI_SRC, rel), 'utf8');
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (/\bsecondary\b/.test(code) && !/text\.secondary/.test(code)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'these sites still bind a domain colour to the bare `secondary` token:\n' +
    offenders.join('\n'));
});

test('the constraint ladder routes T3 through its own alias', () => {
  const src = fs.readFileSync(path.join(UI_SRC, 'components/ConstraintEnforcementView.js'), 'utf8');
  const t3 = src.split('\n').find((l) => /id:\s*'T3'/.test(l));
  assert.ok(t3, 'T3 entry not found');
  assert.match(t3, /color:\s*'constraintT3'/,
    `the T3 tier must use the constraintT3 alias, found: ${t3.trim()}`);
});

test('the audit decision axis routes through its own alias', () => {
  // The correction that motivated this card: the original audit listed the T3
  // chip twice and never mentioned this axis, so splitting by its list would
  // have left the nominal chip coupled to the ordinal tier's token.
  //
  // Scoped to getDecisionColor's body: getDecisionIcon ALSO has a
  // `case 'decision'` branch, and matching either would let this pass on the
  // wrong function.
  const src = fs.readFileSync(path.join(UI_SRC, 'components/AuditTrailViewer.js'), 'utf8');
  const fn = src.match(/const getDecisionColor[\s\S]*?\n  };/);
  assert.ok(fn, 'getDecisionColor not found');
  const decision = fn[0].split('\n').find((l) => /case\s*'decision':/.test(l));
  assert.ok(decision, "getDecisionColor's decision case not found");
  assert.match(decision, /return\s*'auditDecision'/,
    `the decision chip must use the auditDecision alias, found: ${decision.trim()}`);
  assert.doesNotMatch(fn[0], /return\s*'secondary'/,
    'getDecisionColor must not still route any axis to the bare secondary token');
});

test('the dashboard KPI routes through the metricValue alias', () => {
  const src = fs.readFileSync(path.join(UI_SRC, 'containers/DashboardContainer.js'), 'utf8');
  assert.match(src, /<GavelIcon color="metricValue"/,
    'the KPI icon must use the metricValue alias');
  assert.match(src, /color="metricValue"/,
    'the KPI colour prop must use the metricValue alias');
});
