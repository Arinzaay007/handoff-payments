// Drives the real public/index.html and public/app.js in jsdom with a fake Dynamic client and a
// fake API. Covers the signed-in owner dashboard: the verified Monad USDC balance (never a fake
// zero), verified recipient receipt activity, and Identity → Export wallet key, which only opens
// Dynamic's secure reveal and clears its frame when the modal closes.
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
  wallet: '0x7777777777777777777777777777777777777777'
};

const SETTLED_ITEM = {
  paymentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'settled',
  label: 'Settled as USDC on Monad',
  final: true,
  sourceNetwork: { key: 'base', name: 'Base' },
  send: { amount: '25.00', asset: 'USDC' },
  receive: { network: 'Monad', asset: 'USDC', minimum: '24.00', amount: '24.50' },
  sourceTxHash: `0x${'ab'.repeat(32)}`,
  destinationTxHash: `0x${'cd'.repeat(32)}`,
  settlementVerified: true,
  failure: null,
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:05:00.000Z'
};

function fakeDynamic() {
  const dyn = {
    calls: { openAuth: 0, retry: 0, signOut: 0, exportWalletKey: 0, clearExportFrame: 0 },
    onChange: null,
    token: 'test-access-token',
    exportError: null,
    initialize: async ({ onChange }) => { dyn.onChange = onChange; },
    openAuth: () => { dyn.calls.openAuth += 1; },
    getToken: () => dyn.token,
    retryWalletSetup: async () => { dyn.calls.retry += 1; },
    signOut: async () => { dyn.calls.signOut += 1; dyn.token = null; },
    // These stand in for Dynamic's embedded-wallet reveal flow. The real bundle delegates to
    // useEmbeddedReveal().initExportProcess, which renders the key only in Dynamic's iframe.
    exportWalletKey: async () => {
      dyn.calls.exportWalletKey += 1;
      if (dyn.exportError) throw dyn.exportError;
    },
    clearExportFrame: () => { dyn.calls.clearExportFrame += 1; }
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

test('Export wallet key opens only for the signed-in owner', async () => {
  const signedOut = await loadApp();
  signedOut.doc.querySelector('#exportWalletKey').click();
  await settle();
  assert.equal(signedOut.doc.querySelector('#authModal').classList.contains('visible'), true, 'signed-out visitors get sign-in');
  assert.equal(signedOut.doc.querySelector('#exportKeyModal').classList.contains('visible'), false);
  assert.equal(signedOut.dyn.calls.exportWalletKey, 0);

  const { doc, dyn } = await signInWithPortfolio({
    balance: { status: 'available', amount: '1234.56' }, activity: [], checkedAt: '2026-10-10T12:00:00.000Z'
  });
  await waitFor(() => doc.querySelector('#balanceAmount').textContent.includes('1234.56'), 'signed in');
  doc.querySelector('#exportWalletKey').click();
  await settle();
  assert.equal(doc.querySelector('#exportKeyModal').classList.contains('visible'), true);
});

test('the export dialog has no input, warns that Handoff never sees the key, and delegates to Dynamic', async () => {
  const { doc, dyn, requests } = await signInWithPortfolio({
    balance: { status: 'available', amount: '1234.56' }, activity: [], checkedAt: '2026-10-10T12:00:00.000Z'
  });
  await waitFor(() => doc.querySelector('#balanceAmount').textContent.includes('1234.56'), 'signed in');

  const modal = doc.querySelector('#exportKeyModal');
  assert.equal(modal.querySelectorAll('input, textarea, select').length, 0, 'nowhere to type or paste a key');
  assert.match(modal.textContent, /Handoff never sees/);
  assert.match(modal.textContent, /isolated frame/);

  doc.querySelector('#exportWalletKey').click();
  await settle();
  doc.querySelector('#continueExportKey').click();
  await waitFor(() => dyn.calls.exportWalletKey === 1, 'Dynamic reveal opened');
  await waitFor(() => !modal.classList.contains('visible'), 'modal closes after the flow');
  assert.equal(dyn.calls.exportWalletKey, 1);
  // Handoff never sends key material anywhere.
  for (const request of requests) {
    assert.equal(/private|mnemonic|seed/i.test(JSON.stringify(request.body || {})), false);
  }
});

test('closing the export dialog clears Dynamic\'s export frame', async () => {
  const { doc, dyn } = await signInWithPortfolio({
    balance: { status: 'available', amount: '1234.56' }, activity: [], checkedAt: '2026-10-10T12:00:00.000Z'
  });
  await waitFor(() => doc.querySelector('#balanceAmount').textContent.includes('1234.56'), 'signed in');

  doc.querySelector('#exportWalletKey').click();
  await settle();
  assert.equal(dyn.calls.clearExportFrame, 0);
  doc.querySelector('#exportKeyModal .modal-close').click();
  await settle();
  assert.equal(doc.querySelector('#exportKeyModal').classList.contains('visible'), false);
  assert.equal(dyn.calls.clearExportFrame, 1, 'the Dynamic export frame is cleared on close');

  // Closing through the backdrop clears the frame as well.
  doc.querySelector('#exportWalletKey').click();
  await settle();
  doc.querySelector('#modalBackdrop').click();
  await settle();
  assert.equal(dyn.calls.clearExportFrame, 2);
});

test('a failed Dynamic reveal shows friendly copy and never provider text', async () => {
  const { doc, dyn } = await signInWithPortfolio({
    balance: { status: 'available', amount: '1234.56' }, activity: [], checkedAt: '2026-10-10T12:00:00.000Z'
  });
  await waitFor(() => doc.querySelector('#balanceAmount').textContent.includes('1234.56'), 'signed in');
  dyn.exportError = new Error('Elevated access token required for TokenScope.KEY_EXPORT');

  doc.querySelector('#exportWalletKey').click();
  await settle();
  doc.querySelector('#continueExportKey').click();
  await waitFor(() => doc.querySelector('#toast').textContent.length > 0, 'friendly failure toast');

  const toast = doc.querySelector('#toast').textContent;
  assert.match(toast, /Key export could not be opened/);
  assert.equal(/Elevated|TokenScope|Dynamic/i.test(toast), false);
});
