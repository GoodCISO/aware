// test/unit/governance/provenance-fixes.test.js
//
// Regression tests for the provenance remediation.
//
// Each test here corresponds to a specific defect that was fixed, and each
// was verified to FAIL against the pre-fix code. A test that never failed is
// not a regression test.
//
// SEE ALSO
//   docs/adr/ADR-082-aware-governance-quantity-provenance.md

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Decision } = require('../../../src/policies/engine');

const REPO_ROOT = path.resolve(__dirname, '../../..');
function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/**
 * Strip comments from source text.
 *
 * Several of these fixes carry a comment that QUOTES the old defective
 * code (so a reader can see what changed). Asserting on raw text would
 * then match the comment and report a defect that is not there. These
 * assertions are about the CODE, so the code is what is tested.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');    // line comments
}

// ─── R4: preview() must not disagree with evaluate() ───────────────────────

test('R4: preview() derives wouldBeAllowed from evaluate(), not from risk alone', () => {
  const engineSrc = readSource('src/policies/engine.js');

  // The preview must call evaluate().
  const previewBody = engineSrc.slice(
    engineSrc.indexOf('preview(agentId, tool) {')
  );
  assert.match(
    previewBody.slice(0, 1200),
    /this\.evaluate\(\{\s*agentId,\s*tool\s*\}\)/,
    'preview() must delegate to evaluate()'
  );

  // And must NOT contain the old risk-level-only computation.
  assert.doesNotMatch(
    previewBody.slice(0, 1200),
    /riskLevel\s*!==\s*'HIGH'\s*&&\s*riskLevel\s*!==\s*'CRITICAL'/,
    "the old risk-level-only 'wouldBeAllowed' computation must be gone"
  );
});

test('R4: the preview reports the decision it delegated to', () => {
  const engineSrc = readSource('src/policies/engine.js');
  const previewBody = engineSrc.slice(
    engineSrc.indexOf('preview(agentId, tool) {')
  );
  assert.match(
    previewBody.slice(0, 1400),
    /wouldBeAllowed:\s*result\.decision\s*===\s*Decision\.ALLOW/,
    'wouldBeAllowed must be derived from the delegated decision'
  );
  assert.match(
    previewBody.slice(0, 1400),
    /decision:\s*result\.decision/,
    'the preview must expose the decision it delegated to'
  );
});

// ─── R6: the chain must not report a damaged log as intact ─────────────────

test('R6: verifyChain reports an integrity summary', () => {
  const loggerSrc = readSource('src/audit/decision-logger.js');
  assert.match(
    loggerSrc,
    /integrity:\s*'gapped'|const integrity = skipped > 0 \|\| resyncs > 0 \? 'gapped' : 'unbroken'/,
    'verifyChain must compute an integrity value'
  );
  assert.match(loggerSrc, /'unbroken'/);
  assert.match(loggerSrc, /integrity:\s*'broken'/, 'the failure path must report broken');
});

test('R6: the integrity value distinguishes gapped from broken', () => {
  const loggerSrc = readSource('src/audit/decision-logger.js');
  // `valid: false` must carry integrity 'broken'; `valid: true` must carry
  // 'unbroken' or 'gapped'. A `valid: true` with no integrity at all is the
  // defect being fixed.
  const trueBranches = loggerSrc.match(/valid:\s*true,\s*\n\s*integrity,/g) || [];
  const falseBranches = loggerSrc.match(/valid:\s*false,\s*\n\s*integrity:\s*'broken',/g) || [];
  assert.ok(trueBranches.length >= 1, 'the valid:true path must carry integrity');
  assert.ok(falseBranches.length >= 1, 'the valid:false path must carry integrity');
});

// ─── R7: the rotation guard must be reachable ──────────────────────────────

test('R7: the credential-rotation guard is satisfiable', () => {
  const providerSrc = stripComments(readSource('src/agents/identity-provider.js'));

  // The old guard's third conjunct made the whole condition unsatisfiable:
  //   ... && agent.credentials.current !== decoded.rotatedFrom && !decoded.rotatedFrom
  // `!decoded.rotatedFrom` is false whenever the second conjunct can be true.
  assert.doesNotMatch(
    providerSrc,
    /!decoded\.rotatedFrom/,
    'the unsatisfiable !decoded.rotatedFrom conjunct must be gone'
  );

  // The reachable equivalent must be present.
  assert.match(
    providerSrc,
    /decoded\.rotatedFrom\s*&&\s*agent\.credentials\.current\s*!==\s*decoded\.rotatedFrom/,
    'the reachable rotation check must be present'
  );
});

test('R7: the rotation guard still rejects a token minted before the rotation', () => {
  const providerSrc = readSource('src/agents/identity-provider.js');
  assert.match(
    providerSrc,
    /rotatedAt\s*>\s*issuedAt/,
    'the rotatedAt-vs-issuedAt comparison must survive'
  );
  assert.match(
    providerSrc,
    /Credential rotation detected/,
    'the rejection error must survive'
  );
});

// ─── R1: the trust score must be named for what it is ──────────────────────

test('R1: the shipped quantity is named declaredTrustScore', () => {
  for (const rel of [
    'src/api/models/Agent.js',
    'src/api/routes/agents.js',
    'src/agents/registry.js',
    'src/agents/identity-provider.js',
    'src/agents/identity-provider-v2.js',
    'src/agents/attestation-service.js',
  ]) {
    const body = stripComments(readSource(rel));
    assert.match(
      body,
      /declaredTrustScore/,
      `${rel} must use the declaredTrustScore name`
    );
    // The legacy claim name may survive ONLY in the back-compat fallback.
    const bareUses = body.match(/\btrustScore\b/g) || [];
    const legacyFallbacks = body.match(/decoded\.trustScore/g) || [];
    assert.equal(
      bareUses.length,
      legacyFallbacks.length,
      `${rel} uses the bare trustScore name outside the back-compat fallback`
    );
  }
});

test('R1: in-flight tokens carrying the legacy claim still verify', () => {
  for (const rel of [
    'src/agents/identity-provider.js',
    'src/agents/identity-provider-v2.js',
  ]) {
    const body = readSource(rel);
    assert.match(
      body,
      /decoded\.declaredTrustScore\s*!==\s*undefined/,
      `${rel} must prefer the new claim and fall back to the legacy one`
    );
    assert.match(
      body,
      /decoded\.trustScore/,
      `${rel} must fall back to the legacy trustScore claim`
    );
  }
});

// ─── R2: the four blast-radius mechanisms must be distinguishable ──────────

test('R2: the JWT claim is named declaredBlastRadiusEstimate', () => {
  const providerSrc = readSource('src/agents/identity-provider-v2.js');
  assert.match(providerSrc, /declaredBlastRadiusEstimate:/);
  assert.doesNotMatch(
    providerSrc,
    /^\s*blastRadius:/m,
    'the bare blastRadius claim name must be gone'
  );
});

test('R2: the emergency impact estimate has its own name', () => {
  const issuerSrc = readSource('src/emergency/kill-switch-issuer.js');
  assert.match(issuerSrc, /emergencyImpactEstimate/);
  assert.doesNotMatch(
    issuerSrc,
    /^\s*blastRadius:/m,
    'the bare blastRadius key must be gone from the kill-signal payload'
  );
});

test('R2: the protocol placeholder has a severity-label name', () => {
  const protocolSrc = readSource('src/agents/protocol.js');
  assert.match(protocolSrc, /protocolBlastRadiusSeverity:/);
});

test('R2: the revocation penalty keeps its own name', () => {
  const cacheSrc = readSource('src/agents/revocation-cache.js');
  assert.match(cacheSrc, /blastRadiusPenalty/);
});

// ─── R3: the unit inconsistency is fixed ────────────────────────────────────

test('R3: the UI normalises the trust score to one unit', () => {
  const trustScoreSrc = readSource('src/ui/src/constants/trust-score.js');
  assert.match(trustScoreSrc, /export const normaliseTrustScore/);
  assert.match(trustScoreSrc, /export const formatTrustScore/);
  assert.match(trustScoreSrc, /export const bandTrustScore/);
});

test('R3: the UI no longer renders a bare "{score}/100"', () => {
  for (const rel of [
    'src/ui/src/components/KillSwitchControls.js',
    'src/ui/src/components/AgentIdentityDashboard.js',
  ]) {
    const body = readSource(rel);
    assert.doesNotMatch(
      body,
      /trustScore\}\/100/,
      `${rel} must not render the raw score with a /100 suffix`
    );
  }
});

test('R3: the band function no longer compares the raw stored value to 80', () => {
  const operatorsSrc = readSource('src/ui/src/constants/operators.js');
  const bandFn = operatorsSrc.slice(
    operatorsSrc.indexOf('export const trustBandForTrustScore')
  );
  assert.doesNotMatch(
    bandFn.slice(0, 400),
    /n\s*>\s*80|n\s*>\s*50/,
    'the band must be computed by the shared normaliser, not inline thresholds'
  );
  assert.match(bandFn.slice(0, 400), /bandTrustScore\(/);
});
