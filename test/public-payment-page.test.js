// Canonical public payment pages: GET /@username and GET /api/public/profile.
// Runs the real server with the Supabase mock from test/support/preload.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ENVIRONMENT_ID, createTestKeys } = require('./support/jwt');
const { startServer } = require('./support/server');

const keys = createTestKeys();
const MORGAN_WALLET = '0x7777777777777777777777777777777777777777';
// Concrete values from the mock rows. Generic words like "email" appear in ordinary page copy.
const SENSITIVE = [MORGAN_WALLET, 'dynamic-subject-secret-morgan', 'morgan@example.com', 'auth_subject'];

let server;

test.before(async () => {
  server = await startServer({ environmentId: ENVIRONMENT_ID, jwks: keys.jwks });
});

test.after(async () => {
  if (server) await server.stop();
});

async function get(path, method = 'GET') {
  const response = await fetch(`${server.baseUrl}${path}`, { method, redirect: 'manual' });
  const text = method === 'HEAD' ? '' : await response.text();
  return { status: response.status, type: response.headers.get('content-type') || '', text, headers: response.headers };
}

function assertNoSensitiveData(text) {
  for (const value of SENSITIVE) {
    assert.equal(text.toLowerCase().includes(value.toLowerCase()), false, `response must not contain ${value}`);
  }
}

test('GET /@morgan serves the payment page for a registered handle and does not 404', async () => {
  const response = await get('/@morgan');

  assert.equal(response.status, 200);
  assert.match(response.type, /text\/html/);
  assert.match(response.text, /<body class="public-mode" data-public-handle="morgan">/);
  assert.match(response.text, /<title>Pay @morgan on Handoff<\/title>/);
  assert.match(response.text, /id="publicPayButton"/);
  assert.match(response.text, /src="\/app\.js"/);
});

test('the payment page never contains the recipient wallet, subject, email, or any secret', async () => {
  const response = await get('/@morgan');

  assertNoSensitiveData(response.text);
});

test('handles are case-insensitive and accept a trailing slash', async () => {
  const response = await get('/@Morgan/');

  assert.equal(response.status, 200);
  assert.match(response.text, /data-public-handle="morgan"/);
});

test('HEAD /@morgan answers 200 with no body', async () => {
  const response = await get('/@morgan', 'HEAD');

  assert.equal(response.status, 200);
  assert.equal(response.text, '');
});

test('an unknown username gets the clean not-found page, not the payment page', async () => {
  const response = await get('/@nobody_here');

  assert.equal(response.status, 200);
  assert.match(response.text, /id="publicNotFound"/);
  assert.match(response.text, /No payment page here/);
  assert.match(response.text, /<meta name="robots" content="noindex" \/>/);
  assert.equal(response.text.includes('data-public-handle'), false);
  assert.equal(response.text.includes('publicPayButton'), false);
});

test('a claimed handle with no active Monad wallet is not a payment page', async () => {
  const response = await get('/@dormant');

  assert.match(response.text, /id="publicNotFound"/);
  assert.equal(response.text.includes('data-public-handle'), false);
  assertNoSensitiveData(response.text);
});

test('malformed handles are not found, and their input is never echoed into the page', async () => {
  const malformed = await get('/@%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  assert.equal(malformed.status, 200);
  assert.match(malformed.text, /id="publicNotFound"/);
  assert.equal(malformed.text.includes('<script>alert'), false);

  const badEncoding = await get('/@%ZZ');
  assert.equal(badEncoding.status, 200);
  assert.match(badEncoding.text, /id="publicNotFound"/);

  const tooShort = await get('/@ab');
  assert.match(tooShort.text, /id="publicNotFound"/);
});

test('GET /api/public/profile returns only display-safe fields for an active handle', async () => {
  const response = await get('/api/public/profile?handle=morgan');
  const body = JSON.parse(response.text);

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['displayName', 'settlement', 'username']);
  assert.equal(body.username, 'morgan');
  assert.equal(body.displayName, 'Morgan Ellis');
  assert.deepEqual(body.settlement, { chainId: 143, asset: 'USDC' });
  assertNoSensitiveData(response.text);
  assert.equal(response.text.includes('0x'), false, 'no addresses of any kind');
  assert.equal(response.text.includes('"email"'), false, 'no email field');
});

test('GET /api/public/profile accepts an @-prefixed handle and is case-insensitive', async () => {
  const response = await get('/api/public/profile?handle=%40MORGAN');

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).username, 'morgan');
});

test('GET /api/public/profile answers 404 for unknown, dormant, and invalid handles', async () => {
  for (const handle of ['nobody_here', 'dormant', 'Bad!!', 'x']) {
    const response = await get(`/api/public/profile?handle=${encodeURIComponent(handle)}`);
    assert.equal(response.status, 404, `handle ${handle}`);
    assertNoSensitiveData(response.text);
  }
});

test('GET /api/public/profile requires a handle', async () => {
  const response = await get('/api/public/profile');

  assert.equal(response.status, 400);
});

test('the page route is GET-only and never shadows the API or static assets', async () => {
  const api = await get('/api/config');
  assert.equal(api.status, 200);

  const asset = await get('/styles.css');
  assert.equal(asset.status, 200);
  assert.match(asset.type, /text\/css/);

  const post = await fetch(`${server.baseUrl}/@morgan`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 405);
});

test('the page shell is served with no-store caching', async () => {
  const response = await get('/@morgan');

  assert.match(response.headers.get('cache-control') || '', /no-store/);
});
