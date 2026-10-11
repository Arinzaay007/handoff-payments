// Drives the real public/index.html and public/app.js in jsdom with a fake Dynamic client and a
// fake API. Covers the recipient onboarding states: email handoff, provisioning, retry, claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const FRIENDLY_SETUP = 'We could not finish setting up your account';
const WALLET_ADDRESS = '0xAbCdEf0123456789aBCdef0123456789AbCdEf01';

function fakeDynamic() {
  const dyn = {
    calls: { openAuth: 0, retry: 0, registerPasskey: 0, signOut: 0 },
    onChange: null,
    token: 'test-access-token',
    retryError: null,
    registerPasskeyError: null,
    passkeyEnrolled: true,
    onRetry: null,
    initialize: async ({ onChange }) => { dyn.onChange = onChange; },
    openAuth: () => { dyn.calls.openAuth += 1; },
    getToken: () => dyn.token,
    retryWalletSetup: async () => {
      dyn.calls.retry += 1;
      if (dyn.retryError) throw dyn.retryError;
      if (dyn.onRetry) dyn.onRetry();
    },
    hasPasskey: async () => dyn.passkeyEnrolled,
    registerPasskey: async () => {
      dyn.calls.registerPasskey += 1;
      if (dyn.registerPasskeyError) throw dyn.registerPasskeyError;
      dyn.passkeyEnrolled = true;
    },
    signOut: async () => { dyn.calls.signOut += 1; dyn.token = null; }
  };
  return dyn;
}

// Routes: { 'GET /api/me/wallet-status': (req) => ({ status, body }) }
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
    const result = handler ? handler(request) : { status: 404, body: { message: 'Not found.' } };
    return new Response(JSON.stringify(result.body || {}), {
      status: result.status || 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return { fetchImpl, requests };
}

async function loadApp({ routes = {}, dyn = fakeDynamic(), timing = { pollMs: 5, timeoutMs: 60 } } = {}) {
  const api = fakeApi({
    'GET /api/public-config': () => ({ body: { dynamic: { enabled: true, environmentId: 'env-test' } } }),
    'GET /api/relay/chains': () => ({ status: 503, body: { message: 'offline in tests' } }),
    ...routes
  });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  w.fetch = api.fetchImpl;
  w.HandoffOnboardingTiming = timing;
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

const activeStep = doc => doc.querySelector('#authModal .modal-step.active')?.dataset.authStep;
const authVisible = doc => doc.querySelector('#authModal').classList.contains('visible');

test('the onboarding modal has no recipient wallet field, selector, or wallet-missing copy', async () => {
  const { doc } = await loadApp();
  const modal = doc.querySelector('#authModal');
  assert.equal(modal.querySelectorAll('select').length, 0);
  assert.deepEqual([...modal.querySelectorAll('input')].map(input => input.id), ['claimUsername']);
  const text = modal.textContent;
  assert.equal(/No verified EVM wallet found|Verified recipient wallet|wallet address/i.test(text), false);
  assert.equal(text.includes(WALLET_ADDRESS), false);
  assert.equal(doc.querySelector('#claimWallet'), null);
});

test('Continue with email hands off to Dynamic\'s hosted widget', async () => {
  const { doc, dyn } = await loadApp();
  doc.querySelector('#authButton').click();
  await settle();
  assert.equal(activeStep(doc), 'start');
  doc.querySelector('#continueWithEmail').click();
  await settle();
  assert.equal(dyn.calls.openAuth, 1);
  assert.equal(authVisible(doc), false, 'our modal steps aside while Dynamic verifies the email code');
});

test('a new email recipient enrolls a device passkey before choosing a payment name', async () => {
  const routes = {
    'GET /api/me': () => ({ body: { profile: null, email: 'ada@example.com' } }),
    'GET /api/me/wallet-status': () => ({ body: { ready: true } })
  };
  const dyn = fakeDynamic();
  dyn.passkeyEnrolled = false;
  const { doc } = await loadApp({ routes, dyn });
  doc.querySelector('#continueWithEmail').click();
  dyn.onChange({ signedIn: true });

  await waitFor(() => activeStep(doc) === 'passkey', 'passkey enrollment step');
  assert.match(doc.querySelector('#authModal').textContent, /face, fingerprint, or screen lock/i);
  assert.equal(doc.querySelector('#authModal').textContent.includes(WALLET_ADDRESS), false);

  doc.querySelector('#registerPasskey').click();
  await waitFor(() => activeStep(doc) === 'claim', 'claim step after passkey enrollment');
  assert.equal(dyn.calls.registerPasskey, 1);
});

test('after email verification the user sees the provisioning state, then the @username step', async () => {
  let ready = false;
  const routes = {
    'GET /api/me': () => ({ body: { profile: null, email: 'ada@example.com' } }),
    'GET /api/me/wallet-status': () => ({ body: { ready } })
  };
  const { doc, dyn, w } = await loadApp({ routes });
  doc.querySelector('#continueWithEmail').click();
  await settle();

  dyn.onChange({ signedIn: true });
  await waitFor(() => authVisible(doc), 'onboarding modal opens after sign-in');
  assert.equal(activeStep(doc), 'provisioning');
  assert.equal(doc.querySelector('#provisioningTitle').textContent, 'Setting up your secure payment account…');
  assert.equal(doc.querySelector('#retryWalletSetup').hidden, true, 'no retry while setup is on track');
  assert.equal(doc.querySelector('#authModal').textContent.includes(WALLET_ADDRESS), false);

  ready = true;
  await waitFor(() => activeStep(doc) === 'claim', 'claim step after the wallet is ready');
  assert.equal(doc.querySelector('#claimUsername').value, '');
  assert.equal(w.document.querySelector('#authModal').textContent.includes('0x'), false, 'no address shown during onboarding');
});

test('claiming sends only { username }, and the profile activates without displaying an address', async () => {
  let claimBody = null;
  const routes = {
    'GET /api/me': () => ({ body: { profile: null } }),
    'GET /api/me/wallet-status': () => ({ body: { ready: true } }),
    'POST /api/me/claim': (request) => {
      claimBody = request.body;
      return {
        status: 201,
        body: { profile: { id: 'p1', username: 'ada_lovelace', displayName: 'Ada Lovelace' } }
      };
    }
  };
  const { doc, dyn, requests } = await loadApp({ routes });
  doc.querySelector('#continueWithEmail').click();
  dyn.onChange({ signedIn: true });
  await waitFor(() => activeStep(doc) === 'claim', 'claim step');

  doc.querySelector('#claimUsername').value = ' @Ada_Lovelace ';
  doc.querySelector('#claimUsernameButton').click();
  await waitFor(() => !authVisible(doc), 'modal closes after claim');

  assert.deepEqual(claimBody, { username: 'ada_lovelace' });
  const claimRequest = requests.find(request => request.url === '/api/me/claim');
  assert.equal(claimRequest.headers.Authorization, 'Bearer test-access-token');
  assert.equal(doc.querySelector('#identityHandle').textContent, '@ada_lovelace');
  assert.equal(doc.querySelector('#walletAddress'), null, 'recipient addresses are never rendered after activation');
});

test('provisioning that runs long shows Retry wallet setup, and a retry resumes to the claim step', async () => {
  let ready = false;
  const routes = {
    'GET /api/me': () => ({ body: { profile: null } }),
    'GET /api/me/wallet-status': () => ({ body: { ready } })
  };
  const { doc, dyn } = await loadApp({ routes, timing: { pollMs: 5, timeoutMs: 40 } });
  dyn.onRetry = () => { ready = true; };
  doc.querySelector('#continueWithEmail').click();
  dyn.onChange({ signedIn: true });

  await waitFor(() => !doc.querySelector('#retryWalletSetup').hidden, 'retry button after the timeout');
  assert.equal(doc.querySelector('#provisioningText').textContent.includes('taking longer than usual'), true);
  assert.equal(activeStep(doc), 'provisioning');

  doc.querySelector('#retryWalletSetup').click();
  await waitFor(() => activeStep(doc) === 'claim', 'claim step after retry');
  assert.equal(dyn.calls.retry, 1);
});

test('a failed retry shows friendly copy and never raw provider or elevated-token text', async () => {
  const routes = {
    'GET /api/me': () => ({ body: { profile: null } }),
    'GET /api/me/wallet-status': () => ({ body: { ready: false } })
  };
  const { doc, dyn } = await loadApp({ routes, timing: { pollMs: 5, timeoutMs: 30 } });
  dyn.retryError = new Error('Elevated access token required for TokenScope.WALLET_CREATE');
  doc.querySelector('#continueWithEmail').click();
  dyn.onChange({ signedIn: true });
  await waitFor(() => !doc.querySelector('#retryWalletSetup').hidden, 'retry button');

  doc.querySelector('#retryWalletSetup').click();
  await waitFor(() => doc.querySelector('#provisioningStatus').textContent.length > 0, 'friendly failure');

  const status = doc.querySelector('#provisioningStatus').textContent;
  assert.equal(status.includes(FRIENDLY_SETUP), true);
  assert.equal(/elevated|token|TokenScope|Dynamic/i.test(status), false, 'no raw provider text');
  assert.equal(doc.querySelector('#retryWalletSetup').hidden, false, 'the user can try again');
});

test('a claim that finds no embedded wallet returns to provisioning with a retry action', async () => {
  const routes = {
    'GET /api/me': () => ({ body: { profile: null } }),
    'GET /api/me/wallet-status': () => ({ body: { ready: true } }),
    'POST /api/me/claim': () => ({ status: 409, body: { code: 'EMBEDDED_WALLET_PENDING', message: 'Your secure payment account is still being set up.' } })
  };
  const { doc, dyn } = await loadApp({ routes });
  doc.querySelector('#continueWithEmail').click();
  dyn.onChange({ signedIn: true });
  await waitFor(() => activeStep(doc) === 'claim', 'claim step');

  doc.querySelector('#claimUsername').value = 'ada_99';
  doc.querySelector('#claimUsernameButton').click();
  await waitFor(() => activeStep(doc) === 'provisioning', 'back to provisioning');
  assert.equal(doc.querySelector('#provisioningStatus').textContent, 'Your secure payment account is still being set up.');
  assert.equal(doc.querySelector('#retryWalletSetup').hidden, false);
});

test('a username conflict (409 without a wallet code) stays on the claim step with the server message', async () => {
  const routes = {
    'GET /api/me': () => ({ body: { profile: null } }),
    'GET /api/me/wallet-status': () => ({ body: { ready: true } }),
    'POST /api/me/claim': () => ({ status: 409, body: { message: 'That Handoff username is unavailable.' } })
  };
  const { doc, dyn } = await loadApp({ routes });
  doc.querySelector('#continueWithEmail').click();
  dyn.onChange({ signedIn: true });
  await waitFor(() => activeStep(doc) === 'claim', 'claim step');

  doc.querySelector('#claimUsername').value = 'taken_name';
  doc.querySelector('#claimUsernameButton').click();
  await waitFor(() => doc.querySelector('#claimStatus').textContent.length > 0, 'claim error');
  assert.equal(doc.querySelector('#claimStatus').textContent, 'That Handoff username is unavailable.');
  assert.equal(activeStep(doc), 'claim');
});

test('a page reload with an existing session restores the identity without opening onboarding', async () => {
  const routes = {
    'GET /api/me': () => ({ body: { profile: { id: 'p1', username: 'returning_user', displayName: 'Returning' } } })
  };
  const { doc, dyn } = await loadApp({ routes });
  dyn.onChange({ signedIn: true });
  await waitFor(() => doc.querySelector('#identityHandle').textContent === '@returning_user', 'restored identity');
  assert.equal(authVisible(doc), false, 'onboarding does not reopen on reload');
});

test('an expired session returns the user to the email step', async () => {
  const routes = {
    'GET /api/me': () => ({ body: { profile: null } }),
    'GET /api/me/wallet-status': () => ({ status: 401, body: { message: 'Your Handoff session has expired. Sign in again.' } })
  };
  const { doc, dyn } = await loadApp({ routes, timing: { pollMs: 5, timeoutMs: 500 } });
  doc.querySelector('#continueWithEmail').click();
  dyn.onChange({ signedIn: true });
  await waitFor(() => activeStep(doc) === 'start', 'email step after expiry');
  assert.equal(dyn.calls.signOut, 1);
  assert.match(doc.querySelector('#authStatus').textContent, /session ended/);
});

test('when Dynamic cannot load, the user sees a friendly message, not a raw error', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.scrollTo = () => {};
  w.HandoffOnboardingTiming = { pollMs: 5, timeoutMs: 30 };
  w.fetch = fakeApi({
    'GET /api/public-config': () => ({ body: { dynamic: { enabled: true, environmentId: 'env-test' } } }),
    'GET /api/relay/chains': () => ({ status: 503, body: {} })
  }).fetchImpl;
  w.HandoffDynamic = { initialize: async () => { throw new Error('ERR_FAKE_DYNAMIC_INTERNAL'); } };
  w.eval(appSource);
  await settle(40);
  const status = w.document.querySelector('#authStatus').textContent;
  assert.equal(status.includes('temporarily unavailable'), true);
  assert.equal(status.includes('ERR_FAKE'), false);
});

test('payer checkout is untouched: the Get paid and quote flows still exist on the page', async () => {
  const { doc, w } = await loadApp();
  assert.ok(doc.querySelector('#getQuote'));
  assert.equal(typeof w.ethereumAccount, 'function', 'payer wallet-signing helper is still present');
  assert.equal(typeof w.requestQuote, 'function', 'payer quote flow is still present');
});
