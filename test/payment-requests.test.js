// Fixed payment-request HTTP boundary. The real server runs with the isolated Supabase mock so
// these tests prove the browser sees only request terms, never recipient account internals.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENVIRONMENT_ID, createTestKeys, signToken, basePayload } = require('./support/jwt');
const { startServer } = require('./support/server');

const keys = createTestKeys();
let server;

test.before(async () => { server = await startServer({ environmentId: ENVIRONMENT_ID, jwks: keys.jwks }); });
test.after(async () => { if (server) await server.stop(); });

function token() { return signToken({ privateKey: keys.privateKey, payload: basePayload() }); }
async function call(method, path, body, signedIn = true) {
  const headers = { 'content-type': 'application/json' };
  if (signedIn) headers.authorization = `Bearer ${token()}`;
  const response = await fetch(`${server.baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON response */ }
  return { status: response.status, json, text };
}

test('an authenticated owner can create and list a fixed request without an address in the response', async () => {
  const created = await call('POST', '/api/me/payment-requests', {
    amount: '2.50', note: 'September design work', expiresInDays: 7
  });
  assert.equal(created.status, 201);
  assert.match(created.json.id, /^rq_[a-z0-9]{16}$/);
  assert.equal(created.json.amount, '2.50');
  assert.equal(created.json.note, 'September design work');
  assert.equal(/0x|wallet|recipient_profile_id|recipient_wallet_id/i.test(created.text), false);

  const listed = await call('GET', '/api/me/payment-requests');
  assert.equal(listed.status, 200);
  assert.equal(Array.isArray(listed.json.requests), true);
  assert.equal(listed.json.requests[0].id, 'rq_1234567890abcdef');
  assert.equal(/0x|wallet|recipient_profile_id|recipient_wallet_id/i.test(listed.text), false);
});

test('request creation is authenticated and accepts only fixed amount, note, and expiry fields', async () => {
  const anonymous = await call('POST', '/api/me/payment-requests', { amount: '2.50' }, false);
  assert.equal(anonymous.status, 401);

  const injected = await call('POST', '/api/me/payment-requests', {
    amount: '2.50', recipientWallet: '0x1111111111111111111111111111111111111111'
  });
  assert.equal(injected.status, 400);
  assert.equal(injected.json.code, 'FIELD_NOT_ALLOWED');
});

test('an owner can cancel only through the canonical request ID route', async () => {
  const cancelled = await call('POST', '/api/me/payment-requests/rq_1234567890abcdef/cancel', {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal(/0x|wallet|recipient_profile_id|recipient_wallet_id/i.test(cancelled.text), false);

  const malformed = await call('POST', '/api/me/payment-requests/not-a-request/cancel', {});
  assert.equal(malformed.status, 405);
});
