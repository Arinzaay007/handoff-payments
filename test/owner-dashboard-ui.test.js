// Drives the real public/index.html and public/app.js in jsdom with a fake Dynamic client and a
// fake API. Covers the signed-in owner dashboard: the verified payment balance (never a fake
// zero), simple recipient payment activity, and a recipient identity UI that never exposes
// a wallet address, seed phrase, private key, settings panel, or export workflow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

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

async function loadApp({ routes = {}, dyn = fakeDynamic(), publicHandle = null, qr = null } = {}) {
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
  if (qr) w.HandoffQr = qr;
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

async function signInWithPortfolio(portfolioBody, extraRoutes = {}, options = {}) {
  const loaded = await loadApp({ routes: { ...signedInRoutes(portfolioBody), ...extraRoutes }, ...options });
  loaded.dyn.onChange({ signedIn: true });
  return loaded;
}

test('the signed-in dashboard shows a confirmed dollar balance from /api/me/portfolio without chain jargon', async () => {
  const { doc } = await signInWithPortfolio({
    balance: { asset: 'USDC', network: 'Monad', chainId: 143, status: 'available', amount: '1234.56', checkedAt: '2026-10-10T12:00:00.000Z' },
    activity: [SETTLED_ITEM],
    checkedAt: '2026-10-10T12:00:00.000Z'
  });

  await waitFor(() => doc.querySelector('#balanceAmount').textContent.includes('1234.56'), 'the real balance amount');
  assert.match(doc.querySelector('#balanceSub').textContent, /Confirmed balance/);
  assert.equal(/Monad|USDC|on-chain/i.test(doc.querySelector('#overviewPage').textContent), false, 'recipient dashboard hides payment-rail implementation details');
  assert.equal(doc.querySelector('#balanceAmount').textContent.includes('0.00'), false);
});

test('mobile navigation mirrors the desktop destinations and keeps the selected destination in sync', async () => {
  const { doc } = await loadApp();
  const tabs = [...doc.querySelectorAll('.mobile-nav-item')];
  assert.deepEqual(tabs.map(tab => tab.dataset.page), ['overview', 'get-paid', 'activity', 'identity']);
  tabs.find(tab => tab.dataset.page === 'get-paid').click();
  assert.equal(doc.querySelector('#get-paidPage').classList.contains('active'), true);
  assert.equal(doc.querySelector('.mobile-nav-item[data-page="get-paid"]').classList.contains('active'), true);
  assert.equal(doc.querySelector('.nav-item[data-page="get-paid"]').classList.contains('active'), true);
});

test('mobile CSS is fluid on narrow screens and keeps bottom sheets reachable', () => {
  assert.match(styles, /body \{ min-width: 0; \}/, 'the desktop minimum width is explicitly cancelled');
  assert.match(styles, /@media \(max-width: 360px\)[\s\S]*?\.main-content \{ padding-right: 12px; padding-left: 12px; \}/);
  assert.match(styles, /@media \(max-width: 320px\)[\s\S]*?\.balance-actions \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /max-height: calc\(100dvh - env\(safe-area-inset-top\)\)/, 'sheets stay inside the visible device height');
});

test('the mobile menu has close, outside-tap, and destination-selection return paths', async () => {
  const { doc } = await loadApp();
  const sidebar = doc.querySelector('.sidebar');
  const backdrop = doc.querySelector('#mobileDrawerBackdrop');
  doc.querySelector('#mobileMenu').click();
  assert.equal(sidebar.classList.contains('open'), true);
  assert.equal(backdrop.classList.contains('visible'), true);
  doc.querySelector('#closeMobileMenu').click();
  assert.equal(sidebar.classList.contains('open'), false);
  doc.querySelector('#mobileMenu').click();
  backdrop.click();
  assert.equal(sidebar.classList.contains('open'), false);
  doc.querySelector('#mobileMenu').click();
  doc.querySelector('.mobile-nav-item[data-page="activity"]').click();
  assert.equal(sidebar.classList.contains('open'), false);
});

test('the dashboard shows verified recipient receipt activity, and nothing before submission', async () => {
  const { doc } = await signInWithPortfolio({
    balance: { asset: 'USDC', network: 'Monad', chainId: 143, status: 'available', amount: '1234.56', checkedAt: '2026-10-10T12:00:00.000Z' },
    activity: [SETTLED_ITEM],
    checkedAt: '2026-10-10T12:00:00.000Z'
  });

  await waitFor(() => doc.querySelector('#activityList').textContent.includes('Payment received'), 'completed payment');
  const list = doc.querySelector('#activityList');
  assert.match(list.textContent, /\+\$24\.50/);
  assert.match(list.textContent, /Payment confirmed/);
  assert.match(list.textContent, /Complete/);
  assert.equal(/Base|Monad|USDC|Relay|Settled/i.test(list.textContent), false, 'recipient activity is expressed only as a payment');
  assert.equal(/awaiting|quote received/i.test(list.textContent), false);
  // The public privacy model holds on the dashboard too: no payer address anywhere.
  assert.equal(/0x1111/i.test(doc.querySelector('#overviewPage').textContent), false);
});

test('when the balance cannot be read the dashboard explains the state without a fake zero or chain jargon', async () => {
  const { doc } = await signInWithPortfolio({
    balance: { asset: 'USDC', network: 'Monad', chainId: 143, status: 'unavailable', amount: null, checkedAt: '2026-10-10T12:00:00.000Z' },
    activity: [SETTLED_ITEM],
    checkedAt: '2026-10-10T12:00:00.000Z'
  });

  await waitFor(() => /could not refresh your balance/i.test(doc.querySelector('#balanceSub').textContent), 'the unavailable state');
  const amount = doc.querySelector('#balanceAmount').textContent.trim();
  assert.equal(amount, '—', 'no number is shown when the chain cannot be read');
  assert.equal(/0\.00|^0$|^0 /.test(amount), false, 'never a fake zero balance');
  assert.match(doc.querySelector('#balanceSub').textContent, /not a zero balance/);
  // Activity is independent of the RPC read.
  assert.match(doc.querySelector('#activityList').textContent, /Payment received/);
});

test('before the portfolio answers, the dashboard says syncing rather than zero', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { doc } = await signInWithPortfolio(async () => {
    await gate;
    return { body: { balance: { status: 'available', amount: '5.00' }, activity: [], checkedAt: '2026-10-10T12:00:00.000Z' } };
  });

  await waitFor(() => /Checking your confirmed balance/i.test(doc.querySelector('#balanceSub').textContent), 'the syncing state');
  assert.equal(doc.querySelector('#balanceAmount').textContent.trim(), '—');
  assert.match(doc.querySelector('#activityList').textContent, /Checking for payments/);
  release();
  await waitFor(() => doc.querySelector('#balanceAmount').textContent.includes('5.00'), 'the real balance');
});

test('a claimed recipient can show a local QR code for exactly their canonical payment page', async () => {
  const generated = [];
  const qr = {
    paymentPageDataUrl: async url => {
      generated.push(url);
      return 'data:image/png;base64,cXI=';
    }
  };
  const { doc } = await signInWithPortfolio({
    balance: { status: 'available', amount: '12.00' }, activity: [], checkedAt: '2026-10-11T13:50:00.000Z'
  }, {}, { qr });

  await waitFor(() => doc.querySelector('#identityHandle').textContent === '@morgan', 'recipient profile');
  assert.equal(doc.querySelector('#showPaymentQr').disabled, false);
  doc.querySelector('#showPaymentQr').click();
  await waitFor(() => !doc.querySelector('#paymentQrImage').hidden, 'local QR image');

  assert.deepEqual(generated, ['https://handoff.test/@morgan']);
  assert.equal(doc.querySelector('#qrModal').classList.contains('visible'), true);
  assert.equal(doc.querySelector('#paymentQrImage').src, 'data:image/png;base64,cXI=');
  assert.match(doc.querySelector('#qrPaymentUrl').textContent, /handoff\.test\/@morgan/);
  assert.equal(/amount|note|request/i.test(doc.querySelector('#qrModal').textContent), false, 'QR shares only the payment page');
});

test('bank withdrawal is an explicit guided demo that never sends funds, bank details, or a withdrawal request', async () => {
  const { doc, requests } = await signInWithPortfolio({
    balance: { status: 'available', amount: '82.00' }, activity: [], checkedAt: '2026-10-11T13:50:00.000Z'
  });
  await waitFor(() => doc.querySelector('#identityHandle').textContent === '@morgan', 'signed-in recipient');
  const requestsBeforeDemo = requests.length;

  doc.querySelector('#withdrawFromBalance').click();
  assert.equal(doc.querySelector('#withdrawDemoModal').classList.contains('visible'), true);
  assert.match(doc.querySelector('[data-withdraw-step="amount"]').textContent, /DEMO ONLY.*NO MONEY MOVES/i);
  assert.equal(doc.querySelector('#withdrawDemoAmount').value, '25.00');

  doc.querySelector('#withdrawDemoAmount').value = '25.00';
  doc.querySelector('#withdrawDemoToBank').click();
  assert.match(doc.querySelector('[data-withdraw-step="bank"]').textContent, /Do not enter real account information/i);
  assert.equal(doc.querySelector('#withdrawDemoModal input[type="text"]'), null, 'the demo cannot collect bank details');

  doc.querySelector('#withdrawDemoReview').click();
  assert.match(doc.querySelector('#withdrawDemoNgn').textContent, /37,125/);
  assert.match(doc.querySelector('[data-withdraw-step="review"]').textContent, /not a live quote/i);
  doc.querySelector('#completeWithdrawDemo').click();
  assert.match(doc.querySelector('[data-withdraw-step="done"]').textContent, /Nothing was sent/i);
  assert.equal(requests.length, requestsBeforeDemo, 'the complete demo flow makes no network request');
  assert.equal(/Monad|USDC|wallet|blockchain/i.test(doc.querySelector('#withdrawDemoModal').textContent), false);
});

test('a recipient can personalise their display name without changing their Handoff username or QR destination', async () => {
  const { doc, requests } = await signInWithPortfolio({
    balance: { status: 'available', amount: '12.00' }, activity: [], checkedAt: '2026-10-11T13:50:00.000Z'
  }, {
    'PATCH /api/me/profile': request => {
      assert.deepEqual(request.body, { displayName: 'Morgan’s Market' });
      return { body: { profile: { ...MORGAN_PROFILE, displayName: 'Morgan’s Market' } } };
    }
  });

  await waitFor(() => doc.querySelector('#editProfile').disabled === false, 'profile edit control');
  doc.querySelector('#editProfile').click();
  assert.equal(doc.querySelector('#profileModal').classList.contains('visible'), true);
  assert.equal(doc.querySelector('#displayNameInput').value, 'Morgan Ellis');

  doc.querySelector('#displayNameInput').value = 'Morgan’s Market';
  doc.querySelector('#saveProfileName').click();
  await waitFor(() => doc.querySelector('#profileName').textContent === 'Morgan’s Market', 'updated display name');

  const update = requests.find(request => request.method === 'PATCH' && request.url === '/api/me/profile');
  assert.deepEqual(update.body, { displayName: 'Morgan’s Market' });
  assert.match(doc.querySelector('#profileHandle').textContent, /@morgan/);
  assert.equal(doc.querySelector('#sharePageLink').textContent, 'handoff.test/@morgan');
  assert.match(doc.querySelector('#qrModal').textContent, /Download poster/);
  assert.equal(/wallet|seed|private key|blockchain/i.test(doc.querySelector('#profileModal').textContent), false);
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
  assert.match(doc.querySelector('#profileHandle').textContent, /Ready to get paid/);
  assert.match(doc.querySelector('#identityPage').textContent, /passkey or email/i);
  assert.equal(/Monad|USDC|wallet|EVM|Relay/i.test(doc.querySelector('#identityPage').textContent), false);
  assert.equal(doc.querySelector('#sharePaidPage').disabled, false, 'the only recipient share action is ready to use');
});

test('signed-out recipients are offered hosted secure sign-in without a wallet or key prompt', async () => {
  const { doc, dyn } = await loadApp();
  doc.querySelector('#openIdentity').click();
  await settle();
  assert.equal(doc.querySelector('#authModal').classList.contains('visible'), true);
  assert.match(doc.querySelector('#authModal').textContent, /New here\? Start with your email/i);
  assert.equal(doc.querySelector('[data-auth-step="start"] input'), null, 'the sign-in step asks for no crypto credential');
  doc.querySelector('#continueWithEmail').click();
  assert.equal(dyn.calls.openAuth, 1, 'Dynamic owns passkey/email authentication');
});
