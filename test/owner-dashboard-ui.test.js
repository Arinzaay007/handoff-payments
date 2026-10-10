// Drives the real public/index.html and public/app.js in jsdom with a fake Dynamic client and a
// fake API. Covers the signed-in owner dashboard: the verified Monad USDC balance (never a fake
// zero), verified recipient receipt activity, and a recipient identity UI that never exposes
// a wallet address, seed phrase, private key, settings panel, or export workflow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const MORGAN_PROFILE = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'morgan',
  displayName: 'Morgan Ellis',
};

const SETTLED_ITEM = {
  paymentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'settled',
  label: 'Settled as USDC on Monad',
  final: true,
  sourceNetwork: { key: 'base', name: 'Base' },
  receive: { network: 'Monad', asset: 'USDC', requested: '24.50', amount: '24.50' },
  sourceTxHash: `0x${'ab'.repeat(32)}`,
  destinationTxHash: `0x${'cd'.repeat(32)}`,
  settlementVerified: true,
  failure: null,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:05:00.000Z'
};

function fakeDynamic() {
  const dyn = {
    calls: { openAuth: 0, retry: 0, signOut: 0 },
    onChange: null,
    token: 'test-access-token',
    initialize: async ({ onChange }) => { dyn.onChange = onChange; },
    openAuth: () => { dyn.calls.openAuth += 1; },
    getToken: () => dyn.token,
    retryWalletSetup: async () => { dyn.calls.retry += 1; },
    signOut: async () => { dyn.calls.signOut += 1; dyn.token = null; },
  };
  return dyn;
}

// Routes: { 'GET /api/me/portfolio': (req) => ({ status, body }) }
function fakeApi(routes) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const request = {
      url,
      method,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined
    };
    requests.push(request);
    const handler = routes[`${method} ${url}`];
    const result = handler ? await handler(request) : { status: 404, body: { message: 'Not found.' } };
    return new Response(JSON.stringify(result.body || {}), {
      status: result.status || 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return { fetchImpl, requests };
}

async function loadApp({ routes = {}, dyn = fakeDynamic(), publicHandle = null } = {}) {
  const api = fakeApi({
    'GET /api/public-config': () => ({ body: { dynamic: { enabled: true, environmentId: 'env-test' } } }),
    ...routes
  });
  const pageHtml = publicHandle
    ? html.replace('<body>', `<body class="public-mode" data-public-handle="${publicHandle}">`)
    : html;
  const dom = new JSDOM(pageHtml, { runScripts: 'outside-only', url: 'https://handoff.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  w.fetch = api.fetchImpl;
  w.HandoffDynamic = dyn;
  w.eval(appSource);
  await settle();
  return { dom, w, doc: w.document, dyn, requests: api.requests };
}

function settle(ms = 20) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out: ${message}`);
    await settle(5);
  }
}

function signedInRoutes(portfolioBody) {
  return {
    'GET /api/me': () => ({ body: { profile: MORGAN_PROFILE, email: 'morgan@example.com' } }),
    'GET /api/me/portfolio': (typeof portfolioBody === 'function' ? portfolioBody : () => ({ body: portfolioBody }))
  };
}

async function signInWithPortfolio(portfolioBody, extraRoutes = {}) {
  const loaded = await loadApp({ routes: { ...signedInRoutes(portfolioBody), ...extraRoutes } });
  loaded.dyn.onChange({ signedIn: true });
  return loaded;
}

test('the signed-in dashboard shows the verified Monad USDC balance from /api/me/portfolio', async () => {
  const { doc } = await signInWithPortfolio({
    balance: { asset: 'USDC', network: 'Monad', chainId: 143, status: 'available', amount: '1234.56', checkedAt: '2026-10-10T12:00:00.000Z' },
    activity: [SETTLED_ITEM],
    checkedAt: '2026-10-10T12:00:00.000Z'
  });

  await waitFor(() => doc.querySelector('#balanceAmount').textContent.includes('1234.56'), 'the real balance amount');
  assert.match(doc.querySelector('#balanceSub').textContent, /Verified on-chain balance/);
  assert.equal(doc.querySelector('#balanceAmount').textContent.includes('0.00'), false);
});

test('the dashboard shows verified recipient receipt activity, and nothing before submission', async () => {
  const { doc } = await signInWithPortfolio({
    balance: { asset: 'USDC', network: 'Monad', chainId: 143, status: 'available', amount: '1234.56', checkedAt: '2026-10-10T12:00:00.000Z' },
    activity: [SETTLED_ITEM],
    checkedAt: '2026-10-10T12:00:00.000Z'
  });

  await waitFor(() => doc.querySelector('#activityList').textContent.includes('Settled as USDC on Monad'), 'settled receipt');
  const list = doc.querySelector('#activityList');
  assert.match(list.textContent, /\+24\.50 USDC/);
  assert.match(list.textContent, /Base → Monad/);
  assert.match(list.textContent, /Verified/);
  assert.equal(/awaiting|quote received/i.test(list.textContent), false);
  // The public privacy model holds on the dashboard too: no payer address anywhere.
  assert.equal(/0x1111/i.test(doc.querySelector('#overviewPage').textContent), false);
});

test('when the Monad RPC cannot be read the dashboard says syncing/unavailable, never a fake zero', async () => {
  const { doc } = await signInWithPortfolio({
    balance: { asset: 'USDC', network: 'Monad', chainId: 143, status: 'unavailable', amount: null, checkedAt: '2026-10-10T12:00:00.000Z' },
    activity: [SETTLED_ITEM],
    checkedAt: '2026-10-10T12:00:00.000Z'
  });

  await waitFor(() => /syncing\/unavailable/i.test(doc.querySelector('#balanceSub').textContent), 'the unavailable state');
  const amount = doc.querySelector('#balanceAmount').textContent.trim();
  assert.equal(amount, '—', 'no number is shown when the chain cannot be read');
  assert.equal(/0\.00|^0$|^0 /.test(amount), false, 'never a fake zero balance');
  assert.match(doc.querySelector('#balanceSub').textContent, /not a zero balance/);
  // Activity is independent of the RPC read.
  assert.match(doc.querySelector('#activityList').textContent, /Settled as USDC on Monad/);
});

test('before the portfolio answers, the dashboard says syncing rather than zero', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { doc } = await signInWithPortfolio(async () => {
    await gate;
    return { body: { balance: { status: 'available', amount: '5.00' }, activity: [], checkedAt: '2026-10-10T12:00:00.000Z' } };
  });

  await waitFor(() => /Syncing verified balance/i.test(doc.querySelector('#balanceSub').textContent), 'the syncing state');
  assert.equal(doc.querySelector('#balanceAmount').textContent.trim(), '—');
  assert.match(doc.querySelector('#activityList').textContent, /Syncing activity/);
  release();
  await waitFor(() => doc.querySelector('#balanceAmount').textContent.includes('5.00'), 'the real balance');
});

test('the public /@username page never loads the owner portfolio', async () => {
  const { requests, doc } = await loadApp({
    publicHandle: 'morgan',
    routes: {
      'GET /api/public/profile?handle=morgan': () => ({ body: { username: 'morgan', displayName: 'Morgan Ellis', settlement: { chainId: 143, asset: 'USDC' } } })
    }
  });
  await waitFor(() => doc.querySelector('#publicName').textContent === 'Morgan Ellis', 'public profile');
  assert.equal(requests.some(request => request.url.includes('/api/me')), false, 'no owner endpoints on the public page');
  assert.equal(doc.querySelector('#balanceAmount').textContent.trim(), '—');
});

test('recipient identity uses a simple sign-in surface without an address, settings, or key-export control', async () => {
  const { doc } = await signInWithPortfolio({
    balance: { status: 'available', amount: '1234.56' }, activity: [], checkedAt: '2026-10-10T12:00:00.000Z'
  });
  await waitFor(() => doc.querySelector('#balanceAmount').textContent.includes('1234.56'), 'signed in');

  assert.equal(doc.querySelector('#walletAddress'), null);
  assert.equal(doc.querySelector('#copyWallet'), null);
  assert.equal(doc.querySelector('#openWalletSettings'), null);
  assert.equal(doc.querySelector('#exportWalletKey'), null);
  assert.equal(doc.querySelector('#exportKeyModal'), null);
  assert.match(doc.querySelector('#profileHandle').textContent, /Ready to receive on Monad/);
  assert.match(doc.querySelector('#identityPage').textContent, /passkey or email/i);
});

test('signed-out recipients are offered hosted secure sign-in without a wallet or key prompt', async () => {
  const { doc, dyn } = await loadApp();
  doc.querySelector('#openIdentity').click();
  await settle();
  assert.equal(doc.querySelector('#authModal').classList.contains('visible'), true);
  assert.match(doc.querySelector('#authModal').textContent, /passkey or your email/i);
  assert.equal(doc.querySelector('[data-auth-step="start"] input'), null, 'the sign-in step asks for no crypto credential');
  doc.querySelector('#continueWithEmail').click();
  assert.equal(dyn.calls.openAuth, 1, 'Dynamic owns passkey/email authentication');
});
