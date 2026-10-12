// Handoff-to-Handoff route contract while no relayer key is configured. The feature must fail
// closed: it cannot request an authorization or move money before the server-only funded relayer
// exists. This is deliberately separate from the pure EIP-3009 tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENVIRONMENT_ID, createTestKeys, signToken, basePayload } = require('./support/jwt');
const { startServer } = require('./support/server');

const keys = createTestKeys();
let server;

test.before(async () => {
  server = await startServer({ environmentId: ENVIRONMENT_ID, jwks: keys.jwks });
});
test.after(async () => { if (server) await server.stop(); });

function token() {
  return signToken({ privateKey: keys.privateKey, payload: basePayload() });
}

async function call(method, path, body, withToken = true) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(withToken ? { Authorization: `Bearer ${token()}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, json };
}

test('the public and deployment config report only an availability bit, never relayer material', async () => {
  const publicConfig = await call('GET', '/api/public-config', undefined, false);
  assert.equal(publicConfig.status, 200);
  assert.equal(publicConfig.json.handoffTransfers.available, false);
  assert.equal(/HANDOFF_RELAYER_PRIVATE_KEY|privateKey|relayerPrivate|0x[0-9a-f]{40}/i.test(publicConfig.text), false);

  const config = await call('GET', '/api/config', undefined, false);
  assert.equal(config.status, 200);
  assert.equal(config.json.handoffTransfersConfigured, false);
  assert.equal(/HANDOFF_RELAYER_PRIVATE_KEY|privateKey|relayerPrivate/i.test(config.text), false);
});

test('send money is authenticated, rejects account-address injection, and fails closed without a relayer', async () => {
  const anonymous = await call('POST', '/api/handoff-transfers/intent', { recipientHandle: 'morgan', amount: '1' }, false);
  assert.equal(anonymous.status, 401);

  const injection = await call('POST', '/api/handoff-transfers/intent', {
    recipientHandle: 'morgan', amount: '1', recipientWallet: '0x7777777777777777777777777777777777777777'
  });
  assert.equal(injection.status, 400);
  assert.equal(injection.json.code, 'FIELD_NOT_ALLOWED');

  const unavailable = await call('POST', '/api/handoff-transfers/intent', { recipientHandle: 'morgan', amount: '1' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.code, 'SEND_MONEY_UNAVAILABLE');
  assert.equal(/wallet|private|relayer|0x[0-9a-f]{40}/i.test(unavailable.text), false);
});

test('only a signature field is accepted for a transfer confirmation route', async () => {
  const id = '3f6c1f2e-8c1a-4b7e-9a1b-2d3e4f5a6b7c';
  const response = await call('POST', `/api/handoff-transfers/${id}/authorization`, {
    signature: `0x${'11'.repeat(65)}`, amount: '1'
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'FIELD_NOT_ALLOWED');
});
