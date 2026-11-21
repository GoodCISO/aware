#!/usr/bin/env node
// scripts/generate-compliance-matrix.js
// AWARE compliance matrix generator.
//
// WHAT THIS DOES
// ---------------
// Generates `docs/compliance-matrix.md` from the live framework mapper.
//
// WHY THIS FILE EXISTS
// --------------------
// The README has pointed at `docs/compliance-matrix.md` since the v1 era
// ("The companion compliance matrix at `docs/compliance-matrix.md`
// documents the full mapping in human-readable form"). That file was never
// tracked in git — `git log --all --diff-filter=D -- docs/compliance-matrix.md`
// returns nothing — so the link in the published README pointed at a file
// that did not exist. A README that links to a document the code does not
// ship is a false claim, and `docs/` is inside the npm `files` whitelist.
//
// The data was always available: `FrameworkMapper.generateComplianceMatrix()`
// returns the component -> framework -> control crosswalk. This script
// renders it as Markdown so the README's claim becomes true.
//
// USAGE
// -----
//   node scripts/generate-compliance-matrix.js           # write the file
//   node scripts/generate-compliance-matrix.js --check   # CI mode: exit 1
//                                                          if the file on disk
//                                                          differs from what
//                                                          the mapper produces
//
// EXIT CODES
// ----------
//   0  file written (or already up to date)
//   1  --check found drift
//   2  mapper could not be loaded

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'docs', 'compliance-matrix.md');

const CHECK_ONLY = process.argv.includes('--check');

let mapper;
let getFrameworkMapper;
try {
  ({ getFrameworkMapper } = require(path.join(REPO_ROOT, 'src', 'compliance', 'framework-mapper.js')));
} catch (err) {
  console.error(`cannot load the framework mapper: ${err.message}`);
  process.exit(2);
}

const fw = getFrameworkMapper();
const matrix = fw.generateComplianceMatrix();
const frameworks = fw.getFrameworks();

const components = Object.keys(matrix).sort();

const lines = [];
lines.push('# AWARE compliance matrix');
lines.push('');
lines.push('<!-- GENERATED FILE — do not edit by hand. -->');
lines.push('<!-- Regenerate with: node scripts/generate-compliance-matrix.js -->');
lines.push('');
lines.push(
  'This document is the human-readable expansion of the crosswalk held in ' +
  '`src/compliance/framework-mapper.js`. That module is the source of truth: ' +
  'the tables below are generated from it, so they cannot drift from the code.'
);
lines.push('');
lines.push(
  `AWARE maps **${Object.keys(frameworks).length}** compliance frameworks across ` +
  `**${components.length}** AWARE components.`
);
lines.push('');
lines.push('## Frameworks');
lines.push('');
lines.push('| ID | Name | Version | Controls |');
lines.push('|---|---|---|---|');
for (const id of Object.keys(frameworks).sort()) {
  const f = frameworks[id];
  const count = f.controls ? Object.keys(f.controls).length : (f.categories ? Object.keys(f.categories).length : 0);
  lines.push(`| \`${id}\` | ${f.name} | ${f.version || '—'} | ${count} |`);
}
lines.push('');
lines.push('## Per-component crosswalk');
lines.push('');
lines.push(
  'Each table lists the control IDs a component maps to, per framework. ' +
  'A component with no mapping for a framework has no entry in that framework\'s column.'
);

for (const component of components) {
  const byFramework = matrix[component];
  const fwIds = Object.keys(byFramework).sort();
  lines.push('');
  lines.push(`### \`${component}\``);
  lines.push('');
  lines.push('| Framework | Control IDs |');
  lines.push('|---|---|');
  for (const fwId of fwIds) {
    const entry = byFramework[fwId];
    const ids = entry.controls.map((c) => `\`${c.id}\``).join(', ');
    lines.push(`| ${entry.frameworkName} | ${ids} |`);
  }
}

lines.push('');
lines.push('## See also');
lines.push('');
lines.push('- `src/compliance/framework-mapper.js` — the source of truth for this table.');
for (const doc of fs.readdirSync(path.join(REPO_ROOT, 'docs', 'compliance')).sort()) {
  if (doc.endsWith('.md')) {
    lines.push(`- [\`docs/compliance/${doc}\`](compliance/${doc}) — per-framework coverage detail.`);
  }
}
lines.push('');

const output = lines.join('\n');

if (CHECK_ONLY) {
  const existing = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : '';
  if (existing !== output) {
    console.error('docs/compliance-matrix.md is out of date.');
    console.error('Regenerate with: node scripts/generate-compliance-matrix.js');
    process.exit(1);
  }
  console.log('docs/compliance-matrix.md is up to date.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, output);
console.log(`wrote ${path.relative(REPO_ROOT, OUT_PATH)} (${components.length} components)`);
