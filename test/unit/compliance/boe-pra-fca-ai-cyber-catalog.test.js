// SPDX-License-Identifier: Apache-2.0
// test/unit/compliance/boe-pra-fca-ai-cyber-catalog.test.js
//
// Per ADR-084 §"Acceptance criteria":
//   - The 12 paragraph IDs from the brief are present, in paper order
//   - Each entry has { name, description, awareness, awareComponents,
//     crosswalkConfidence, paragraph, paragraphTheme, regulatorText,
//     sourceStatus, sourceUrl, sourceVerifiedAt }
//   - Awareness class breakdown matches the computed breakdown
//   - Description length ≤200 chars; no entry is empty
//   - Catalog is frozen (no runtime mutation)
//   - Framework block registered in framework-mapper.js with the ADR-084
//     shape (pinDate, license, attribution, catalogRef, controls,
//     controlIds, awarenessBreakdown, sourceVerified, sourceCaveat,
//     scopeNote)
//   - getFrameworkControls('BOE_PRA_FCA_AI_CYBER') returns 12 entries with
//     the full per-entry shape
//   - Every AWARE component's BOE_PRA_FCA_AI_CYBER mapping resolves via
//     componentCoversControl
//   - Every paragraph referenced by an AWARE component exists in the catalog
//   - THE SOURCE CAVEAT IS ENFORCED: because the upstream paper could not
//     be retrieved, every entry must carry regulatorText: null and
//     sourceStatus: 'UNVERIFIED'. A future verified catalogue (v2) must
//     REPLACE this file rather than edit it in place, per ADR-084 §D1 —
//     this test therefore also asserts the v1 file is still marked
//     unverified, so a partial in-place upgrade cannot pass.
//
// pattern: node:test + node:assert (matches sibling test files under
// test/unit/compliance/*.test.js).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  BOE_PRA_FCA_AI_CYBER_CONTROLS,
  BOE_PRA_FCA_AI_CYBER_CONTROL_IDS,
  BOE_PRA_FCA_AI_CYBER_AWARENESS_BREAKDOWN,
  BOE_PRA_FCA_AI_CYBER_SOURCE_VERIFIED
} = require('../../../src/compliance/boe-pra-fca-ai-cyber-catalog');
const {
  FRAMEWORKS,
  AWARE_COMPONENT_MAPPINGS,
  getFrameworkMapper
} = require('../../../src/compliance/framework-mapper');

// ---------------------------------------------------------------------------
// Expected universe — the 12 paragraph numbers from the brief, in paper order
// ---------------------------------------------------------------------------

const EXPECTED_PARAGRAPH_IDS = [
  '2.3',
  '4.2', '4.4',
  '6.6',
  '7.5',
  '8.2', '8.5',
  '9.1',
  '10.2', '10.4', '10.5',
  '11.1'
];

// Awareness class breakdown, pinned per ADR-084 §D3. These describe AWARE's
// OWN control surface (what the code does), which is measurable in this
// repository. They do NOT depend on the unretrieved paper.
const EXPECTED_MAPPED = [
  '4.2', '4.4', '6.6', '7.5', '8.2', '10.2'
];
const EXPECTED_PARTIAL = [
  '2.3', '8.5', '9.1', '10.4', '10.5', '11.1'
];
const EXPECTED_GAP = [];

// Per-component mappings per ADR-084 §D5. This is the contract this test
// file pins; if the implementation drifts, these tests fail and an operator
// must reconcile against the ADR.
const EXPECTED_COMPONENT_MAPPINGS = {
  'agent-registry': ['2.3', '4.2', '9.1'],
  'anomaly-detection': ['8.2', '10.2', '10.4'],
  'kill-switch': ['8.5', '9.1', '10.2'],
  'identity-provider': ['9.1'],
  'tool-access-control': ['6.6'],
  'tool-observation-proxy': ['4.4', '7.5'],
  'compliance-mapping': ['2.3', '4.2', '8.2', '8.5', '10.4', '10.5', '11.1'],
  'credential-classifier': ['4.4', '7.5'],
  'permission-model': ['6.6'],
  'behavioral-baseline': ['11.1']
};

// ---------------------------------------------------------------------------
// Catalog file — shape + completeness
// ---------------------------------------------------------------------------

test('boe-pra-fca-ai-cyber-catalog: paragraph IDs are exactly the 12 from the brief, in paper order', () => {
  assert.deepStrictEqual([...BOE_PRA_FCA_AI_CYBER_CONTROL_IDS], EXPECTED_PARAGRAPH_IDS);
});

test('boe-pra-fca-ai-cyber-catalog: exactly 12 entries', () => {
  assert.strictEqual(BOE_PRA_FCA_AI_CYBER_CONTROL_IDS.length, 12);
  assert.strictEqual(Object.keys(BOE_PRA_FCA_AI_CYBER_CONTROLS).length, 12);
});

test('boe-pra-fca-ai-cyber-catalog: no duplicate paragraph IDs', () => {
  const unique = new Set(BOE_PRA_FCA_AI_CYBER_CONTROL_IDS);
  assert.strictEqual(unique.size, BOE_PRA_FCA_AI_CYBER_CONTROL_IDS.length);
});

test('boe-pra-fca-ai-cyber-catalog: each entry has the full ADR-084 §D3 shape', () => {
  for (const pid of EXPECTED_PARAGRAPH_IDS) {
    const entry = BOE_PRA_FCA_AI_CYBER_CONTROLS[pid];
    assert.ok(entry, `missing entry for paragraph ${pid}`);
    assert.strictEqual(typeof entry.name, 'string');
    assert.ok(entry.name.length > 0, `${pid} name is empty`);
    assert.strictEqual(typeof entry.description, 'string');
    assert.ok(entry.description.length > 0, `${pid} description is empty`);
    assert.ok(entry.description.length <= 200, `${pid} description ${entry.description.length} chars > 200 cap`);
    assert.ok(
      ['mapped', 'partial', 'gap'].includes(entry.awareness),
      `${pid} awareness "${entry.awareness}" not in canonical enum`
    );
    assert.ok(Array.isArray(entry.awareComponents), `${pid} awareComponents not an array`);
    assert.ok(
      ['H', 'M', 'L'].includes(entry.crosswalkConfidence),
      `${pid} crosswalkConfidence "${entry.crosswalkConfidence}" not in {H, M, L}`
    );
    assert.strictEqual(entry.paragraph, pid, `${pid} paragraph field must equal its own ID`);
    assert.strictEqual(typeof entry.paragraphTheme, 'string');
    assert.ok(entry.paragraphTheme.length > 0, `${pid} paragraphTheme is empty`);
    assert.ok(
      'regulatorText' in entry,
      `${pid} must carry the regulatorText key (null when unverified)`
    );
    assert.ok(
      ['UNVERIFIED', 'VERIFIED'].includes(entry.sourceStatus),
      `${pid} sourceStatus "${entry.sourceStatus}" not in enum`
    );
    assert.strictEqual(typeof entry.sourceUrl, 'string');
    assert.ok(entry.sourceUrl.length > 0, `${pid} sourceUrl is empty`);
    assert.ok(
      'sourceVerifiedAt' in entry,
      `${pid} must carry the sourceVerifiedAt key (null when unverified)`
    );
  }
});

test('boe-pra-fca-ai-cyber-catalog: every awareComponents reference exists in framework-mapper rows', () => {
  const componentIds = new Set(Object.keys(AWARE_COMPONENT_MAPPINGS));
  for (const pid of EXPECTED_PARAGRAPH_IDS) {
    for (const comp of BOE_PRA_FCA_AI_CYBER_CONTROLS[pid].awareComponents) {
      assert.ok(
        componentIds.has(comp),
        `${pid} awareComponents references unknown component "${comp}"`
      );
    }
  }
});

test('boe-pra-fca-ai-cyber-catalog: awareness-class breakdown is exactly 6 mapped / 6 partial / 0 gap', () => {
  const actual = { mapped: [], partial: [], gap: [] };
  for (const [pid, entry] of Object.entries(BOE_PRA_FCA_AI_CYBER_CONTROLS)) {
    actual[entry.awareness].push(pid);
  }
  actual.mapped.sort();
  actual.partial.sort();
  actual.gap.sort();
  assert.deepStrictEqual(actual.mapped, [...EXPECTED_MAPPED].sort());
  assert.deepStrictEqual(actual.partial, [...EXPECTED_PARTIAL].sort());
  assert.deepStrictEqual(actual.gap, [...EXPECTED_GAP].sort());
});

test('boe-pra-fca-ai-cyber-catalog: the exported breakdown matches the catalog it describes', () => {
  const computed = { mapped: 0, partial: 0, gap: 0, total: 0 };
  for (const entry of Object.values(BOE_PRA_FCA_AI_CYBER_CONTROLS)) {
    computed[entry.awareness] += 1;
    computed.total += 1;
  }
  assert.deepStrictEqual({ ...BOE_PRA_FCA_AI_CYBER_AWARENESS_BREAKDOWN }, computed);
  assert.strictEqual(BOE_PRA_FCA_AI_CYBER_AWARENESS_BREAKDOWN.total, 12);
});

test('boe-pra-fca-ai-cyber-catalog: catalog is frozen (no runtime mutation)', () => {
  assert.ok(Object.isFrozen(BOE_PRA_FCA_AI_CYBER_CONTROLS), 'BOE_PRA_FCA_AI_CYBER_CONTROLS not frozen');
  assert.ok(Object.isFrozen(BOE_PRA_FCA_AI_CYBER_CONTROL_IDS), 'BOE_PRA_FCA_AI_CYBER_CONTROL_IDS not frozen');
  assert.throws(() => {
    'use strict';
    BOE_PRA_FCA_AI_CYBER_CONTROLS['2.3'] = {};
  }, TypeError);
});

// ---------------------------------------------------------------------------
// THE SOURCE CAVEAT — the load-bearing assertion of this catalogue
// ---------------------------------------------------------------------------

test('boe-pra-fca-ai-cyber-catalog: the upstream paper was NOT retrieved — every entry says so', () => {
  assert.strictEqual(
    BOE_PRA_FCA_AI_CYBER_SOURCE_VERIFIED,
    false,
    'the v1 catalogue must remain marked UNVERIFIED; a verified paper is a NEW catalogue file per ADR-084 §D1'
  );
  for (const pid of EXPECTED_PARAGRAPH_IDS) {
    const entry = BOE_PRA_FCA_AI_CYBER_CONTROLS[pid];
    assert.strictEqual(
      entry.regulatorText,
      null,
      `${pid} carries regulatorText — the paper was not retrieved, so no verbatim text may be present`
    );
    assert.strictEqual(
      entry.sourceStatus,
      'UNVERIFIED',
      `${pid} sourceStatus must be UNVERIFIED`
    );
    assert.strictEqual(
      entry.sourceVerifiedAt,
      null,
      `${pid} sourceVerifiedAt must be null when the paper was not retrieved`
    );
  }
});

test('boe-pra-fca-ai-cyber-catalog: the file header records that the paper could not be retrieved', () => {
  const headerPath = path.join(__dirname, '..', '..', '..', 'src', 'compliance', 'boe-pra-fca-ai-cyber-catalog.js');
  const text = fs.readFileSync(headerPath, 'utf8');
  const headerFlat = text.split('\n').slice(0, 120).map(l => l.replace(/^\/\/\s*/, '')).join(' ');

  assert.match(text, /^\/\/ SPDX-License-Identifier: Apache-2\.0$/m,
    'SPDX header must be exactly Apache-2.0');
  assert.match(headerFlat, /could NOT be retrieved|NOT be retrieved/i,
    'the header must state that the upstream paper was not retrievable');
  assert.match(headerFlat, /PRA|FCA|Bank of England/i,
    'the header must attribute the paragraph numbers to the three regulators');
  assert.match(headerFlat, /non-binding|NON-BINDING/i,
    'the header must state that the source is non-binding guidance');
  assert.match(headerFlat, /does NOT|NOT assert/i,
    'the header must disclaim any compliance or certification claim');
});

// ---------------------------------------------------------------------------
// Framework block — registration + control enumeration
// ---------------------------------------------------------------------------

test('framework-mapper: BOE_PRA_FCA_AI_CYBER is registered in FRAMEWORKS with the ADR-084 shape', () => {
  const fw = FRAMEWORKS.BOE_PRA_FCA_AI_CYBER;
  assert.ok(fw, 'BOE_PRA_FCA_AI_CYBER missing from FRAMEWORKS');
  assert.strictEqual(fw.id, 'BOE_PRA_FCA_AI_CYBER');
  assert.match(fw.name, /PRA \/ FCA \/ Bank of England/);
  assert.match(fw.name, /Effective practices: cyber risk and resilience management relating to AI/);
  assert.ok(fw.source.startsWith('https://www.bankofengland.co.uk/'), 'source must be the regulator URL');
  assert.strictEqual(fw.pinDate, null, 'pinDate must be null — the paper was never fetched');
  assert.ok(fw.license && fw.license.length > 0, 'license missing');
  assert.match(fw.attribution, /NO regulator text is reproduced/i);
  assert.strictEqual(fw.catalogRef, './boe-pra-fca-ai-cyber-catalog');
  assert.deepStrictEqual(fw.awarenessBreakdown, { mapped: 6, partial: 6, gap: 0, total: 12 });
  assert.strictEqual(fw.sourceVerified, false, 'sourceVerified must be false');
  assert.match(fw.sourceCaveat, /not retrieved/i);
  assert.match(fw.scopeNote, /Does NOT assert regulatory compliance/);
  assert.match(fw.scopeNote, /NON-BINDING/);
  assert.match(fw.scopeNote, /does NOT claim certification/);
});

test('framework-mapper: BOE_PRA_FCA_AI_CYBER is the NINTH framework', () => {
  const ids = Object.keys(FRAMEWORKS);
  assert.strictEqual(ids.length, 9, `expected 9 frameworks, got ${ids.length}: ${ids.join(', ')}`);
  assert.strictEqual(ids[ids.length - 1], 'BOE_PRA_FCA_AI_CYBER');
  // The eight pre-existing frameworks must be untouched.
  for (const id of [
    'CSA_AI_CM', 'NIST_AI_RMF', 'ISO_27001', 'DORA',
    'OWASP_LLM_TOP_10', 'OWASP_AST10', 'OWASP_MCP_TOP_10', 'ISO_42001'
  ]) {
    assert.ok(FRAMEWORKS[id], `pre-existing framework ${id} was removed`);
  }
});

test('framework-mapper: getFrameworkControls returns 12 entries for BOE_PRA_FCA_AI_CYBER', () => {
  const fm = getFrameworkMapper();
  const controls = fm.getFrameworkControls('BOE_PRA_FCA_AI_CYBER');
  assert.strictEqual(controls.length, 12, `expected 12 controls, got ${controls.length}`);
});

test('framework-mapper: getFrameworkControls returns all 12 IDs in expected order', () => {
  const fm = getFrameworkMapper();
  const controls = fm.getFrameworkControls('BOE_PRA_FCA_AI_CYBER');
  const ids = controls.map(c => c.id);
  assert.deepStrictEqual(ids, EXPECTED_PARAGRAPH_IDS);
});

test('framework-mapper: each BOE_PRA_FCA_AI_CYBER control carries the full per-entry shape', () => {
  const fm = getFrameworkMapper();
  const controls = fm.getFrameworkControls('BOE_PRA_FCA_AI_CYBER');
  for (const c of controls) {
    assert.strictEqual(typeof c.id, 'string');
    assert.strictEqual(typeof c.categoryName, 'string');
    assert.ok(c.categoryName.length > 0);
    assert.strictEqual(typeof c.description, 'string');
    assert.ok(c.description.length > 0);
    assert.ok(c.description.length <= 200, `${c.id} description ${c.description.length} chars > 200`);
    assert.ok(
      ['mapped', 'partial', 'gap'].includes(c.awareness),
      `${c.id} awareness "${c.awareness}" not in enum`
    );
    assert.ok(Array.isArray(c.awareComponents));
    assert.ok(['H', 'M', 'L'].includes(c.crosswalkConfidence));
    assert.strictEqual(c.paragraph, c.id);
    assert.strictEqual(typeof c.paragraphTheme, 'string');
    assert.strictEqual(c.regulatorText, null, `${c.id} must expose regulatorText: null`);
    assert.strictEqual(c.sourceStatus, 'UNVERIFIED');
    assert.strictEqual(typeof c.sourceUrl, 'string');
    assert.strictEqual(c.sourceVerifiedAt, null);
  }
});

// ---------------------------------------------------------------------------
// Component → paragraph mappings
// ---------------------------------------------------------------------------

test('framework-mapper: each component with BOE_PRA_FCA_AI_CYBER mapping resolves via componentCoversControl', () => {
  const fm = getFrameworkMapper();
  for (const [component, ids] of Object.entries(EXPECTED_COMPONENT_MAPPINGS)) {
    assert.ok(
      AWARE_COMPONENT_MAPPINGS[component],
      `component ${component} missing from AWARE_COMPONENT_MAPPINGS`
    );
    const actual = AWARE_COMPONENT_MAPPINGS[component]['BOE_PRA_FCA_AI_CYBER'] || [];
    assert.strictEqual(
      actual.length,
      ids.length,
      `${component} length mismatch: expected ${ids.length}, got ${actual.length} (${JSON.stringify(actual)})`
    );
    for (const pid of ids) {
      assert.ok(
        actual.includes(pid),
        `${component} missing ${pid} (actual: ${JSON.stringify(actual)})`
      );
      assert.strictEqual(
        fm.componentCoversControl(component, 'BOE_PRA_FCA_AI_CYBER', pid),
        true,
        `${component} does not cover ${pid} via componentCoversControl`
      );
    }
  }
});

test('framework-mapper: every BOE_PRA_FCA_AI_CYBER ID referenced by an AWARE component exists in the catalog', () => {
  const referenced = new Set();
  for (const mapping of Object.values(AWARE_COMPONENT_MAPPINGS)) {
    for (const pid of (mapping['BOE_PRA_FCA_AI_CYBER'] || [])) referenced.add(pid);
  }
  for (const pid of referenced) {
    assert.ok(
      BOE_PRA_FCA_AI_CYBER_CONTROLS[pid],
      `component mapping references ${pid} but catalog has no entry for it`
    );
  }
});

test('framework-mapper: the catalog and the mapper agree in BOTH directions', () => {
  // A component listed in a catalog entry must map to that paragraph, and a
  // component mapped to a paragraph must be listed in that entry. Without
  // this, the crosswalk can silently disagree with the catalogue.
  for (const [pid, entry] of Object.entries(BOE_PRA_FCA_AI_CYBER_CONTROLS)) {
    for (const comp of entry.awareComponents) {
      const mapped = (AWARE_COMPONENT_MAPPINGS[comp] || {})['BOE_PRA_FCA_AI_CYBER'] || [];
      assert.ok(
        mapped.includes(pid),
        `catalog lists ${comp} for ${pid} but the mapper does not map ${comp} -> ${pid}`
      );
    }
  }
  for (const [comp, mapping] of Object.entries(AWARE_COMPONENT_MAPPINGS)) {
    for (const pid of (mapping['BOE_PRA_FCA_AI_CYBER'] || [])) {
      const entry = BOE_PRA_FCA_AI_CYBER_CONTROLS[pid];
      assert.ok(entry, `mapper maps ${comp} -> ${pid}, which is not in the catalog`);
      assert.ok(
        entry.awareComponents.includes(comp),
        `mapper maps ${comp} -> ${pid} but the catalog's awareComponents omits ${comp}`
      );
    }
  }
});

test('framework-mapper: every paragraph is reachable from at least one AWARE component', () => {
  const covered = new Set();
  for (const mapping of Object.values(AWARE_COMPONENT_MAPPINGS)) {
    for (const pid of (mapping['BOE_PRA_FCA_AI_CYBER'] || [])) covered.add(pid);
  }
  const missing = EXPECTED_PARAGRAPH_IDS.filter(pid => !covered.has(pid));
  assert.deepStrictEqual(missing, [], `these paragraphs have no AWARE component: ${missing.join(', ')}`);
});

test('framework-mapper: no paragraph is claimed without a real evidence component', () => {
  // A 'gap' entry is permitted to have no components. A 'mapped' entry is
  // NOT: 'mapped' means AWARE directly emits the evidence, so it must name
  // at least one component.
  for (const [pid, entry] of Object.entries(BOE_PRA_FCA_AI_CYBER_CONTROLS)) {
    if (entry.awareness === 'mapped') {
      assert.ok(
        entry.awareComponents.length > 0,
        `${pid} is 'mapped' but names no AWARE component — that would be an unbacked claim`
      );
    }
    if (entry.awareness === 'gap') {
      assert.deepStrictEqual(
        entry.awareComponents.filter(c => c !== ''),
        [],
        `${pid} is a 'gap' and should name no AWARE components`
      );
    }
  }
});
