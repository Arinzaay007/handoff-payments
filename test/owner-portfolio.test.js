// The authenticated owner portfolio contract, against the real server with Supabase and the Monad
// RPC mocked and every other outbound host blocked.
// Proves: the balance is the on-chain Monad USDC read (chain 143 verified, balanceOf on Monad USDC),
// never a database total; activity is strictly the signed-in recipient's and only after the source
// transaction was submitted; quote_created and awaiting_sender never appear; no payer address, key
// material, or recipient wallet is exposed; and no endpoint exports or accepts a key.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENVIRONMENT_ID, createTestKeys, signToken, credentials, basePayload } = require('./support/jwt');
const { startServer } = require('./support/server');
const { balanceOfData } = require('../src/monadBalance');
const { MONAD } = require('../src/paymentNetworks');

const keys = createTestKeys();
const MORGAN_SUBJECT = 'dynamic-subject-secret-morgan';
const MORGAN_ID = '22222222-2222-4222-8222-222222222222';
const MORGAN_WALLET = '0x7777777777777777777777777777777777777777';
const MORGAN_PAYER = '0x1111111111111111111111111111111111111111';
const FOREIGN_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

let live;
let down;
let wrong;

test.before(async () => {
  live = await startServer({ environmentId: ENVIRONMENT_ID, jwks: keys.jwks, monadRpc: { mode: 'ok' } });
  down = await startServer({ environmentId: ENVIRONMENT_ID, jwks: keys.jwks, monadRpc: { mode: 'unavailable' } });
  wrong = await startServer({ environmentId: ENVIRONMENT_ID, jwks: keys.jwks, monadRpc: { mode: 'wrong-chain' } });
});

test.after(async () => {
  for (const server of [live, down, wrong]) if (server) await server.stop();
});

function morganToken(overrides = {}) {
  return signToken({
    privateKey: keys.privateKey,
    payload: basePayload({
      sub: MORGAN_SUBJECT,
      email: 'morgan@example.com',
      given_name: 'Morgan',
      family_name: 'Ellis',
      verified_credentials: [
        credentials.email('morgan@example.com'),
        credentials.embeddedEvm(MORGAN_WALLET)
      ],
      ...overrides
    })
  });
}

async function getPortfolio(server, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${server.baseUrl}/api/me/portfolio`, { headers });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, json };
}

function rpcCalls(server) {
  return server.outboundLog().filter(entry => entry.kind === 'monad-rpc');
}

function attemptsQueries(server) {
  return server.outboundLog()
    .filter(entry => entry.kind === 'supabase' && entry.path.startsWith('payment_attempts?'))
    .map(entry => entry.path);
}

test('portfolio requires a verified Dynamic session', async () => {
  const anonymous = await getPortfolio(live, null);
  assert.equal(anonymous.status, 401);
  const forged = await getPortfolio(live, 'not.a.valid.token');
  assert.equal(forged.status, 401);
  assert.equal(attemptsQueries(live).length, 0);
});

test('the balance is the on-chain Monad USDC read, never a database total', async () => {
  const before = rpcCalls(live).length;
  const result = await getPortfolio(live, morganToken());
  assert.equal(result.status, 200);

  const balance = result.json.balance;
  assert.equal(balance.status, 'available');
  assert.equal(balance.asset, 'USDC');
  assert.equal(balance.network, 'Monad');
  assert.equal(balance.chainId, 143);
  // The preload answers balanceOf with 1234567890 minor units = 1234.56 USDC.
  assert.equal(balance.amount, '1234.56');

  // The chain read, not the requested merchant-output activity sum (24 + 9.9 + 4.9 = 38.80).
  const activityTotal = result.json.activity.reduce((sum, item) => sum + Number(item.receive.requested), 0);
  assert.equal(activityTotal, 38.8);
  assert.notEqual(balance.amount, activityTotal.toFixed(2));

  // The reader verified chain ID 143 first, then called balanceOf on the Monad USDC contract.
  const calls = rpcCalls(live).slice(before);
  assert.ok(calls.length >= 2, 'a chain check and a balance read');
  assert.equal(calls[0].method, 'eth_chainId');
  const balanceCall = calls.find(call => call.method === 'eth_call');
  assert.ok(balanceCall, 'an eth_call balanceOf read');
  assert.equal(String(balanceCall.params[0].to).toLowerCase(), MONAD.usdcAddress.toLowerCase());
  assert.equal(String(balanceCall.params[0].data).toLowerCase(), balanceOfData(MORGAN_WALLET));
});

test('activity is strictly the signed-in recipient profile and only after the source transaction', async () => {
  const result = await getPortfolio(live, morganToken());
  assert.equal(result.status, 200);

  const items = result.json.activity;
  // Fixture rows: settled, routing, transaction_submitted are visible; quote_created,
  // awaiting_sender, and the foreign profile's row are not.
  assert.deepEqual(items.map(item => item.status), ['settled', 'routing', 'transaction_submitted']);
  assert.deepEqual(items.map(item => item.paymentId), [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ]);
  assert.equal(result.text.includes(FOREIGN_ID), false);
  assert.equal(/quote_created|awaiting_sender/.test(result.text), false, 'pre-submission states never appear');

  const settled = items[0];
  assert.equal(settled.settlementVerified, true);
  assert.equal(settled.receive.amount, '24.50');
  assert.equal(settled.destinationTxHash, `0x${'cd'.repeat(32)}`);
  assert.equal(settled.label, 'Settled as USDC on Monad');

  // No payer address, no private key material, no recipient wallet in any form.
  assert.equal(result.text.includes(MORGAN_PAYER), false);
  assert.equal(result.text.includes(MORGAN_WALLET), false);
  assert.equal(/payer|privateKey|mnemonic|seedPhrase|wallet/i.test(result.text), false);
});

test('the activity query is scoped server-side to the recipient profile and post-submission states', async () => {
  const before = attemptsQueries(live).length;
  const result = await getPortfolio(live, morganToken());
  assert.equal(result.status, 200);

  const queries = attemptsQueries(live).slice(before);
  assert.equal(queries.length, 1);
  const query = queries[0];
  assert.match(query, new RegExp(`recipient_profile_id=eq\\.${MORGAN_ID}`));
  assert.match(query, /source_tx_hash=not\.is\.null/);
  assert.match(query, /status=not\.in\.\(quote_created,awaiting_sender\)/);
  assert.equal(/payer_address/.test(query), false, 'the payer column is never even selected');
});

test('a signed-in user without a claimed profile gets 404 and no activity query', async () => {
  const before = attemptsQueries(live).length;
  const token = morganToken({ sub: 'dynamic-subject-secret-nobody' });
  const result = await getPortfolio(live, token);
  assert.equal(result.status, 404);
  assert.equal(result.json.code, 'PROFILE_NOT_FOUND');
  assert.equal(attemptsQueries(live).length, before);
});

test('when the Monad RPC cannot be read the balance is unavailable, never a fake zero', async () => {
  const result = await getPortfolio(down, morganToken());
  assert.equal(result.status, 200);
  assert.equal(result.json.balance.status, 'unavailable');
  assert.equal(result.json.balance.amount, null);
  assert.equal(JSON.stringify(result.json.balance).includes('0.00'), false, 'no fabricated zero balance');
  // Activity is still served from the database.
  assert.equal(result.json.activity.length, 3);
});

test('a non-Monad RPC is refused before any balance is read', async () => {
  const before = rpcCalls(wrong).length;
  const result = await getPortfolio(wrong, morganToken());
  assert.equal(result.status, 200);
  assert.equal(result.json.balance.status, 'unavailable');
  assert.equal(result.json.balance.amount, null);
  const calls = rpcCalls(wrong).slice(before);
  assert.equal(calls.length, 1, 'only the chain check');
  assert.equal(calls[0].method, 'eth_chainId');
});

test('no endpoint exports or accepts a key', async () => {
  const keyPaths = [
    '/api/me/export-key', '/api/me/private-key', '/api/me/wallet-key', '/api/me/key',
    '/api/me/export', '/api/export-key', '/api/me/export-wallet'
  ];
  for (const path of keyPaths) {
    for (const [method, token] of [['GET', null], ['GET', morganToken()], ['POST', morganToken()]]) {
      const response = await fetch(`${live.baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
        },
        body: method === 'POST' ? JSON.stringify({ privateKey: '0xdeadbeef' }) : undefined
      });
      assert.ok([404, 405].includes(response.status), `${method} ${path} -> ${response.status}`);
      const text = await response.text();
      assert.equal(/private|mnemonic|seed/i.test(text), false, `${method} ${path} leaked key text`);
    }
  }
});

test('key material sent to any API is rejected, never stored', async () => {
  const claim = await fetch(`${live.baseUrl}/api/me/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${morganToken()}` },
    body: JSON.stringify({ username: 'morgan_2', privateKey: '0xdeadbeef' })
  });
  assert.equal(claim.status, 400);
  const body = await claim.json();
  assert.match(body.message, /Only a Handoff username/);
  assert.equal(/private/i.test(JSON.stringify(body)), false);

  const portfolio = await fetch(`${live.baseUrl}/api/me/portfolio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${morganToken()}` },
    body: JSON.stringify({ privateKey: '0xdeadbeef' })
  });
  assert.equal(portfolio.status, 405);
});
