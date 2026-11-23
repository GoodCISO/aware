// test/unit/acs/http-manifest.test.js
// The ACS manifest HTTP routes.
//
// These exercise the routes through a real Express app and a real HTTP
// request, so the routing, the body handling and the status codes are all
// covered rather than just the handler functions.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const express = require('express');
const acsRouter = require('../../../src/api/routes/acs');

/**
 * Start an Express app with the ACS router mounted.
 *
 * @returns {Promise<{server: Object, base: string, close: Function}>}
 *   The running server.
 */
function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/acs', acsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * POST a JSON body and read the response.
 *
 * @param {string} base - The server base URL.
 * @param {string} path - The path.
 * @param {Object} body - The body.
 * @returns {Promise<{status: number, json: Object}>} The response.
 */
function post(base, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(path, base);
    const req = http.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (err) {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode, json: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('acs http manifest: POST /manifest/validate accepts a valid manifest', async () => {
  const { base, close } = await startServer();
  try {
    const exported = await post(base, '/api/acs/manifest/export', { name: 'test-policy' });
    assert.equal(exported.status, 200);

    const validated = await post(base, '/api/acs/manifest/validate', {
      manifest: exported.json.manifest,
    });
    assert.equal(validated.status, 200);
    assert.equal(validated.json.valid, true);
    assert.deepEqual(validated.json.errors, []);
  } finally {
    await close();
  }
});

test('acs http manifest: POST /manifest/validate REJECTS an invalid manifest with 400', async () => {
  const { base, close } = await startServer();
  try {
    const exported = await post(base, '/api/acs/manifest/export', {});
    const broken = exported.json.manifest;
    // Bind a policy that does not exist.
    broken.intervention_points.pre_tool_call.policy.id = 'not_defined';

    const validated = await post(base, '/api/acs/manifest/validate', { manifest: broken });
    assert.equal(validated.status, 400);
    assert.equal(validated.json.valid, false);
    assert.ok(validated.json.errors.length > 0);
  } finally {
    await close();
  }
});

test('acs http manifest: POST /manifest/validate REJECTS an unknown adapter', async () => {
  const { base, close } = await startServer();
  try {
    const exported = await post(base, '/api/acs/manifest/export', {});
    const manifest = exported.json.manifest;
    manifest.policies.aware_policy.adapter = 'a_different_engine';

    const validated = await post(base, '/api/acs/manifest/validate', { manifest });
    assert.equal(validated.status, 400);
    assert.equal(validated.json.valid, false);
  } finally {
    await close();
  }
});

test('acs http manifest: POST /manifest/export returns a manifest and its YAML', async () => {
  const { base, close } = await startServer();
  try {
    const response = await post(base, '/api/acs/manifest/export', {
      name: 'aware-policy',
      version: '3.1.0',
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.manifest.metadata.name, 'aware-policy');
    assert.equal(response.json.manifest.metadata.version, '3.1.0');
    assert.ok(typeof response.json.yaml === 'string');
    assert.match(response.json.yaml, /agent_control_specification_version/);
    assert.equal(response.json.spec_version, require('../../../src/acs').ACS_SPEC_VERSION);
  } finally {
    await close();
  }
});

test('acs http manifest: the exported manifest round trips through the validate route', async () => {
  const { base, close } = await startServer();
  try {
    const exported = await post(base, '/api/acs/manifest/export', { name: 'rt' });
    const reparsed = await post(base, '/api/acs/manifest/validate', {
      manifest: require('../../../src/acs').parseManifest(exported.json.yaml).manifest,
    });
    assert.equal(reparsed.status, 200);
    assert.equal(reparsed.json.valid, true);
  } finally {
    await close();
  }
});
