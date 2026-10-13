// Origin-derived canonical links, a usable recipient share action instead of unfinished request links,
// the public payment-page UI, and the migration's table-alias fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const html = read('public/index.html');
const appSource = read('public/app.js');
const migration = read('supabase/migrations/0002_claim_handoff_profile.sql');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test('no file in the repository mentions the retired hardcoded payment domain', () => {
  const offenders = walk(ROOT)
    .filter(file => !file.endsWith(path.join('public', 'dynamic-client.js')))
    .filter(file => /handoff\.xyz/i.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(ROOT, file));
  assert.deepEqual(offenders, []);
});

test('canonical payment links are derived from the page origin, not a constant domain', () => {
  assert.match(appSource, /new URL\(`\/@\$\{username\}`, window\.location\.origin\)\.toString\(\)/);
  const copyCalls = appSource.match(/canonicalPaymentUrl\(/g) || [];
  // The identity card and all three recipient share actions derive the same current-origin URL.
  assert.ok(copyCalls.length >= 6);
});

test('the recipient app replaces retired request UI with a persisted fixed-request composer and canonical sharing', () => {
  for (const removed of ['generateRequest', 'sharePreview', 'requestAmount', 'requestNote', 'requestExpiry', 'payment links coming soon', 'share link coming soon']) {
    assert.equal(html.includes(removed) || appSource.includes(removed), false, `${removed} is not presented as a recipient feature`);
  }
  assert.match(html, /id="sharePaidPage"/);
  assert.match(appSource, /Payment page copied/);
  assert.equal(html.includes('id="requestModal"'), false, 'the fake link modal is removed');
});

test('the migration qualifies every RETURNS TABLE-colliding column reference inside the function', () => {
  const body = migration.slice(migration.indexOf('as $$'), migration.lastIndexOf('$$;'));
  const code = body
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n');
  // Unqualified predicates on the OUT-parameter names (profile_id, chain_id, wallet_address,
  // is_active, username, display_name) are the exact pattern that raised "ambiguous".
  const unqualified = /\b(where|and|or|exists\s*\(\s*select[^)]*?where)\s+(?!\w+\.)(profile_id|chain_id|wallet_address|is_active)\b/gi;
  assert.deepEqual(code.match(unqualified) || [], []);
  assert.equal(/lower\((?!\w+\.)wallet_address\)/.test(code), false, 'lower(wallet_address) must be qualified');
  assert.match(code, /rw\.profile_id = v_profile\.id and rw\.chain_id = 143 and rw\.is_active/);
  assert.match(code, /other_rw\.profile_id <> v_profile\.id/);
});

test('the migration still revokes direct access and keeps the username-only contract', () => {
  assert.match(migration, /revoke all on function public\.claim_handoff_profile\(text, text, text, text\) from public, anon, authenticated;/);
  assert.match(migration, /create or replace function public\.claim_handoff_profile\(/);
});

// --- browser behaviour -------------------------------------------------------------------------

function fakeDynamic(token = null) {
  const dyn = { calls: { openAuth: 0 }, token, onChange: null };
  return {
    dyn,
    api: {
      initialize: async ({ onChange }) => { dyn.onChange = onChange; },
      openAuth: () => { dyn.calls.openAuth += 1; },
      getToken: () => dyn.token,
      retryWalletSetup: async () => {},
      signOut: async () => { dyn.token = null; }
    }
  };
}

function settle(ms = 25) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function load({ url, bodyAttrs = '', routes = {}, token = null }) {
  const page = html.replace('<body>', `<body${bodyAttrs}>`);
  const dom = new JSDOM(page, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  const requests = [];
  const handlers = {
    'GET /api/public-config': () => ({ dynamic: { enabled: true, environmentId: 'env-test' } }),
    'GET /api/relay/chains': () => ({ message: 'offline' }),
    ...routes
  };
  w.fetch = async (input, init = {}) => {
    const method = init.method || 'GET';
    requests.push({ url: input, method });
    const handler = handlers[`${method} ${input}`];
    const body = handler ? handler({ method }) : { message: 'Not found.' };
    return new Response(JSON.stringify(body), {
      status: handler ? 200 : 404,
      headers: { 'content-type': 'application/json' }
    });
  };
  w.scrollTo = () => {};
  const { dyn, api } = fakeDynamic(token);
  w.HandoffDynamic = api;
  w.HandoffOnboardingTiming = { pollMs: 5, timeoutMs: 60 };
  w.eval(appSource);
  await settle();
  return { dom, w, doc: w.document, dyn, requests };
}

test('a payment page at /@morgan shows the public card, not the owner dashboard', async () => {
  const { doc, requests } = await load({
    url: 'https://handoff-payments.onrender.com/@morgan',
    bodyAttrs: ' class="public-mode" data-public-handle="morgan"',
    routes: {
      'GET /api/public/profile?handle=morgan': () => ({ username: 'morgan', displayName: 'Morgan Ellis' })
    }
  });

  assert.equal(doc.querySelector('#publicName').textContent, 'Morgan Ellis');
  assert.equal(doc.querySelector('#publicHandle').textContent, '@morgan');
  assert.ok(requests.some(entry => entry.url === '/api/public/profile?handle=morgan'));
  // Public mode never starts Dynamic or the owner dashboard.
  assert.equal(requests.some(entry => entry.url === '/api/public-config'), false);
});

test('Make a payment opens the payer-only flow with the handle prefilled, not a wallet', async () => {
  const { doc } = await load({
    url: 'https://handoff-payments.onrender.com/@morgan',
    bodyAttrs: ' class="public-mode" data-public-handle="morgan"',
    routes: {
      'GET /api/public/profile?handle=morgan': () => ({ username: 'morgan', displayName: 'Morgan Ellis' })
    }
  });

  doc.querySelector('#publicPayButton').click();
  await settle();

  assert.equal(doc.querySelector('#payModal').classList.contains('visible'), true);
  assert.equal(doc.querySelector('#payRecipient').value, '@morgan');
  assert.equal(doc.querySelector('#payModal [data-step="choose"]').classList.contains('active'), true);
});

test('a shared fixed request waits for verified terms and locks the payer amount', async () => {
  const { doc, requests } = await load({
    url: 'https://handoff-payments.onrender.com/@morgan?request=rq_1234567890abcdef',
    bodyAttrs: ' class="public-mode" data-public-handle="morgan"',
    routes: {
      'GET /api/public/profile?handle=morgan': () => ({ username: 'morgan', displayName: 'Morgan Ellis' }),
      'GET /api/public/payment-requests?id=rq_1234567890abcdef': () => ({
        id: 'rq_1234567890abcdef', amount: '2.50', note: 'September design work', status: 'active',
        expiresAt: '2099-10-31T12:00:00.000Z', recipient: { username: 'morgan', displayName: 'Morgan Ellis' }
      })
    }
  });
  const button = doc.querySelector('#publicPayButton');
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /Pay \$2\.50/);
  assert.ok(requests.some(entry => entry.url === '/api/public/payment-requests?id=rq_1234567890abcdef'));

  button.click();
  await settle();
  assert.equal(doc.querySelector('#payRecipient').value, '@morgan');
  assert.equal(doc.querySelector('#payAmount').value, '2.50');
  assert.equal(doc.querySelector('#payAmount').readOnly, true);
  assert.equal(appSource.includes('paymentRequestId: state.publicRequest.id'), true);
});

test('Share my payment page copies the real /@username URL on the current origin', async () => {
  const { doc, dyn } = await load({
    url: 'https://pay.example.test/',
    token: 'test-access-token',
    routes: {
      'GET /api/me': () => ({ profile: { id: 'p1', username: 'ada', displayName: 'Ada' } })
    }
  });
  // Dynamic reports a restored session. The app loads the profile through /api/me.
  await dyn.onChange({ signedIn: true });
  await settle();

  assert.equal(doc.querySelector('#identityHandle').textContent, '@ada');
  assert.equal(doc.querySelector('#identityLink').textContent, 'pay.example.test/@ada');

  doc.querySelector('#shareProfile').click();
  await settle();
  // jsdom has no clipboard API, so the app shows the exact URL it would have copied.
  assert.equal(doc.querySelector('#toast').textContent, 'https://pay.example.test/@ada');

  doc.querySelector('#copyPublicLink').click();
  await settle();
  assert.equal(doc.querySelector('#toast').textContent, 'https://pay.example.test/@ada');
});

test('the rendered recipient page keeps payment-page sharing simple and enables it after sign-in', async () => {
  const { doc, dyn } = await load({
    url: 'https://pay.example.test/',
    token: 'test-access-token',
    routes: { 'GET /api/me': () => ({ profile: { id: 'p1', username: 'ada', displayName: 'Ada' } }) }
  });
  assert.equal(doc.querySelector('#sharePaidPage').disabled, true, 'there is nothing to share before a name is claimed');
  await dyn.onChange({ signedIn: true });
  await settle();
  assert.equal(doc.querySelector('#sharePaidPage').disabled, false);
  assert.equal(doc.querySelector('#sharePageLink').textContent, 'pay.example.test/@ada');
  doc.querySelector('#sharePaidPage').click();
  await settle();
  assert.equal(doc.querySelector('#toast').textContent, 'https://pay.example.test/@ada');
  assert.equal(doc.querySelector('#requestModal'), null);
});
