const test = require('node:test');
const assert = require('node:assert/strict');
const { ENVIRONMENT_ID, createTestKeys, signToken, credentials, basePayload } = require('./support/jwt');
const { startServer } = require('./support/server');

const keys = createTestKeys();
const otherKeys = createTestKeys();
const EMBEDDED = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';
const OTHER_EMBEDDED = '0x1111111111111111111111111111111111111111';
const EXTERNAL = '0x2222222222222222222222222222222222222222';

let server;

test.before(async () => {
  server = await startServer({ environmentId: ENVIRONMENT_ID, jwks: keys.jwks });
});

test.after(async () => {
  if (server) await server.stop();
});

function tokenFor(overrides = {}, signer = keys.privateKey) {
  return signToken({ privateKey: signer, payload: basePayload(overrides) });
}

function rpcCalls(log) {
  return log.filter(entry => entry.kind === 'supabase' && entry.path === 'rpc/claim_handoff_profile');
}

async function claim(body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${server.baseUrl}/api/me/claim`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, text, json: safeJson(text) };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

test('username-only claim derives the recipient from the embedded wallet credential', async () => {
  const before = rpcCalls(server.outboundLog()).length;
  const result = await claim({ username: 'Ada_01' }, tokenFor());

  assert.equal(result.status, 201);
  assert.equal(result.json.profile.username, 'ada_01');
  assert.equal(result.json.profile.wallet, EMBEDDED.toLowerCase());

  const calls = rpcCalls(server.outboundLog());
  assert.equal(calls.length, before + 1);
  const sent = calls[calls.length - 1].body;
  assert.equal(sent.p_wallet_address, EMBEDDED.toLowerCase());
  assert.equal(sent.p_username, 'ada_01');
  assert.equal(sent.p_auth_subject, 'dynamic-user-test-1');
});

test('server rejects a client-supplied walletAddress and never calls the database', async () => {
  const before = rpcCalls(server.outboundLog()).length;
  const result = await claim({ username: 'ada_02', walletAddress: OTHER_EMBEDDED }, tokenFor());

  assert.equal(result.status, 400);
  assert.match(result.json.message, /Only a Handoff username/);
  assert.equal(rpcCalls(server.outboundLog()).length, before);
});

test('server rejects walletAddress even when it matches the verified embedded wallet', async () => {
  const before = rpcCalls(server.outboundLog()).length;
  const result = await claim({ username: 'ada_03', walletAddress: EMBEDDED }, tokenFor());

  assert.equal(result.status, 400);
  assert.equal(rpcCalls(server.outboundLog()).length, before);
});

test('server rejects any extra field, including a display name the client might try to set', async () => {
  const before = rpcCalls(server.outboundLog()).length;
  const result = await claim({ username: 'ada_04', displayName: 'Mallory' }, tokenFor());

  assert.equal(result.status, 400);
  assert.equal(rpcCalls(server.outboundLog()).length, before);
});

test('server rejects non-object bodies and non-string usernames', async () => {
  const token = tokenFor();
  assert.equal((await claim('null', token)).status, 400);
  assert.equal((await claim('[]', token)).status, 400);
  assert.equal((await claim({ username: 42 }, token)).status, 400);
  assert.equal((await claim({}, token)).status, 400);
  assert.equal((await claim('{not json', token)).status, 400);
});

test('an external wallet credential alone is not accepted as a recipient', async () => {
  const before = rpcCalls(server.outboundLog()).length;
  const token = tokenFor({
    verified_credentials: [credentials.email('ada@example.com'), credentials.externalEvm(EXTERNAL)]
  });
  const result = await claim({ username: 'ada_05' }, token);

  assert.equal(result.status, 409);
  assert.equal(result.json.code, 'EMBEDDED_WALLET_PENDING');
  assert.equal(rpcCalls(server.outboundLog()).length, before);
});

test('an embedded wallet on a non-EVM chain is not accepted', async () => {
  const token = tokenFor({
    verified_credentials: [credentials.embeddedEvm(EMBEDDED, 'SOL')]
  });
  const result = await claim({ username: 'ada_06' }, token);

  assert.equal(result.status, 409);
  assert.equal(result.json.code, 'EMBEDDED_WALLET_PENDING');
});

test('two distinct embedded EVM wallets fail closed', async () => {
  const token = tokenFor({
    verified_credentials: [
      credentials.embeddedEvm(EMBEDDED),
      credentials.embeddedEvm(OTHER_EMBEDDED)
    ]
  });
  const result = await claim({ username: 'ada_07' }, token);

  assert.equal(result.status, 409);
  assert.equal(result.json.code, 'EMBEDDED_WALLET_AMBIGUOUS');
});

test('a token signed by another key is rejected before any wallet is read', async () => {
  const before = rpcCalls(server.outboundLog()).length;
  const result = await claim({ username: 'ada_08' }, tokenFor({}, otherKeys.privateKey));

  assert.equal(result.status, 401);
  assert.equal(rpcCalls(server.outboundLog()).length, before);
});

test('a token from another Dynamic environment is rejected', async () => {
  const result = await claim({ username: 'ada_09' }, tokenFor({ environment_id: 'env-other' }));
  assert.equal(result.status, 401);
});

test('a missing bearer token is rejected', async () => {
  const result = await claim({ username: 'ada_10' });
  assert.equal(result.status, 401);
});

test('/api/me never returns recipient wallet addresses during onboarding', async () => {
  const response = await fetch(`${server.baseUrl}/api/me`, {
    headers: { Authorization: `Bearer ${tokenFor()}` }
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(text).verifiedWallets, undefined);
  assert.equal(text.toLowerCase().includes(EMBEDDED.toLowerCase()), false);
  assert.equal(text.includes('0x'), false);
});

test('wallet-status reports readiness as a boolean and never includes an address', async () => {
  const ready = await fetch(`${server.baseUrl}/api/me/wallet-status`, {
    headers: { Authorization: `Bearer ${tokenFor()}` }
  });
  const readyText = await ready.text();
  assert.equal(ready.status, 200);
  assert.deepEqual(JSON.parse(readyText), { ready: true });
  assert.equal(readyText.includes('0x'), false);

  const pending = await fetch(`${server.baseUrl}/api/me/wallet-status`, {
    headers: {
      Authorization: `Bearer ${tokenFor({ verified_credentials: [credentials.email('ada@example.com')] })}`
    }
  });
  assert.deepEqual(await pending.json(), { ready: false });
});

test('wallet-status requires a verified session', async () => {
  const response = await fetch(`${server.baseUrl}/api/me/wallet-status`, {
    headers: { Authorization: `Bearer ${tokenFor({}, otherKeys.privateKey)}` }
  });
  assert.equal(response.status, 401);
});

test('the claim route only answers POST; a GET never creates a profile', async () => {
  const response = await fetch(`${server.baseUrl}/api/me/claim`, {
    headers: { Authorization: `Bearer ${tokenFor()}` }
  });
  assert.equal(response.status, 404);
});
