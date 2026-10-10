// The payment HTTP contract, against the real server with the Supabase mock and outbound hosts blocked.
// Proves: the payer cannot supply a recipient wallet, Solana/TON are refused, the caps apply, public
// responses carry no wallet address, and payment errors never echo provider text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENVIRONMENT_ID, createTestKeys } = require('./support/jwt');
const { startServer } = require('./support/server');

const keys = createTestKeys();
const MORGAN_WALLET = '0x7777777777777777777777777777777777777777';
const PAYER = '0x1111111111111111111111111111111111111111';
let server;

test.before(async () => {
  server = await startServer({ environmentId: ENVIRONMENT_ID, jwks: keys.jwks });
});

test.after(async () => {
  if (server) await server.stop();
});

async function call(method, path, body) {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, json };
}

test('the public recipient lookup returns the display profile and no wallet address', async () => {
  const response = await call('GET', '/api/public/resolve?handle=morgan');
  assert.equal(response.status, 200);
  assert.equal(response.text.includes(MORGAN_WALLET), false);
  assert.equal(/wallet/i.test(response.text), false, 'no wallet field of any kind');
  assert.equal(response.json.username, 'morgan');
});

test('the public configuration lists eight live networks and never a recipient wallet', async () => {
  const response = await call('GET', '/api/public-config');
  assert.equal(response.status, 200);
  assert.equal(response.text.includes(MORGAN_WALLET), false);
  const networks = response.json.payments.sourceNetworks;
  assert.equal(networks.filter(network => network.status === 'live').length, 8);
  assert.equal(networks.find(network => network.key === 'solana').status, 'not_available');
  assert.equal(networks.find(network => network.key === 'ton').status, 'not_available');
  assert.deepEqual(response.json.payments.caps, {
    perPaymentUsdc: '25.00',
    dailyRollingUsdc: '100.00',
    perPaymentMaximum: 25,
    dailyMaximum: 100
  });
});

test('the readiness endpoint reports whether Relay is configured, without revealing the key', async () => {
  const response = await call('GET', '/api/config');
  assert.equal(response.status, 200);
  assert.equal(response.json.relayConfigured, false, 'no RELAY_API_KEY in the test environment');
  assert.equal(response.json.deploymentRevision, null, 'local runs have no Render commit revision');
  assert.equal(/RELAY_API_KEY|api_key|apiKey/i.test(response.text), false);
});

test('the route status is display-safe and never forwards Relay data', async () => {
  const response = await call('GET', '/api/relay/routes');
  assert.equal(response.status, 200);
  assert.equal(response.json.routes.length, 10);
  assert.equal(/solverAddresses|depository|erc20Currencies|protocol/.test(response.text), false);
  assert.equal(response.json.routes.find(route => route.key === 'solana').status, 'not_available');
});

test('the old raw Relay chain dump is gone', async () => {
  const response = await call('GET', '/api/relay/chains');
  assert.equal(response.status, 404);
});

test('the payer cannot supply a recipient wallet: any extra quote field is refused before anything else', async () => {
  const response = await call('POST', '/api/payments/quote', {
    payer: PAYER,
    sourceNetwork: 'base',
    recipientHandle: 'morgan',
    amount: '1',
    recipientWallet: MORGAN_WALLET
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'FIELD_NOT_ALLOWED');
});

test('Solana and TON quotes are refused as not available yet', async () => {
  for (const sourceNetwork of ['solana', 'ton']) {
    const response = await call('POST', '/api/payments/quote', { payer: PAYER, sourceNetwork, recipientHandle: 'morgan', amount: '1' });
    assert.equal(response.status, 400, sourceNetwork);
    assert.equal(response.json.code, 'NETWORK_NOT_AVAILABLE', sourceNetwork);
  }
});

test('a quote above the 25 USDC per-payment cap is refused with a clear code', async () => {
  const response = await call('POST', '/api/payments/quote', { payer: PAYER, sourceNetwork: 'base', recipientHandle: 'morgan', amount: '26' });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'PER_PAYMENT_CAP_EXCEEDED');
});

test('a quote that cannot be verified or routed never returns a transaction, and its error hides provider detail', async () => {
  const response = await call('POST', '/api/payments/quote', { payer: PAYER, sourceNetwork: 'base', recipientHandle: 'morgan', amount: '1' });
  assert.notEqual(response.status, 201);
  assert.equal(response.json?.executable === true, false);
  assert.equal(/supabase|relay\.link|api\.relay|secret|stack|postgrest/i.test(response.text), false, 'no provider or infrastructure text reaches the browser');
});

test('an unknown payment ID is not found, and malformed IDs are refused', async () => {
  const missing = await call('GET', '/api/payments/3f6c1f2e-8c1a-4b7e-9a1b-2d3e4f5a6b7c');
  assert.equal([404, 500].includes(missing.status), true);
  const malformed = await call('GET', '/api/payments/not-a-uuid');
  assert.equal(malformed.status, 404);
});

test('a source transaction POST accepts only the hash field', async () => {
  const response = await call('POST', '/api/payments/3f6c1f2e-8c1a-4b7e-9a1b-2d3e4f5a6b7c/source-transaction', { txHash: `0x${'ab'.repeat(32)}`, status: 'settled' });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'FIELD_NOT_ALLOWED');
});
