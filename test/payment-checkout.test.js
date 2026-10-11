// Browser checkout, driven through the real public/app.js in JSDOM with a stubbed EVM wallet and stubbed
// server responses. Proves: quote-only routes never offer a transaction, nothing is signed before the
// payer approves, Solana and TON are unavailable, and "Settled" appears only when the server says so.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { publicSourceNetworks } = require('../src/paymentNetworks');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const PAYER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const PAYMENT_ID = '3f6c1f2e-8c1a-4b7e-9a1b-2d3e4f5a6b7c';
const APPROVE_HASH = `0x${'ab'.repeat(32)}`;
const DEPOSIT_HASH = `0x${'cd'.repeat(32)}`;
const SETTLE_MS = 40;
const settle = (ms = SETTLE_MS) => new Promise(resolve => setTimeout(resolve, ms));
// Waits for the page to reach a state, polling at the page's own cadence. Fails with a clear message.
async function waitUntil(predicate, label, ms = 9000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    if (predicate()) return;
    await settle(50);
  }
  assert.fail(`timed out waiting for: ${label}`);
}
// Every window is closed when its test ends, so the page's polling timers cannot outlive the test.
const windows = [];
test.after(() => { for (const w of windows) w.close(); });

function executableQuote(overrides = {}) {
  return {
    executable: true,
    status: 'quote_created',
    label: 'Quote received',
    reason: null,
    message: null,
    paymentId: PAYMENT_ID,
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    quote: {
      exactOutput: true,
      pay: { amount: '25.50', asset: 'USDC', routeCost: '0.50' },
      sourceNetwork: { key: 'base', name: 'Base' },
      networkGas: { asset: 'ETH', paidBy: 'payer' },
      receive: { network: 'Monad', asset: 'USDC', requested: '25.00', guaranteed: true },
      timeEstimateSeconds: 45
    },
    steps: [
      { index: 0, role: 'approve', chainId: 8453, from: PAYER, to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', data: '0x095ea7b3', value: '0x0' },
      { index: 1, role: 'source', chainId: 8453, from: PAYER, to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: '0x1234', value: '0x0' }
    ],
    ...overrides
  };
}

function previewQuote() {
  return {
    executable: false,
    status: 'quote_preview',
    label: 'Quote preview only',
    reason: 'PROTOCOL_V2_MISSING',
    message: 'Quote preview only. Relay did not return an executable transaction for this route, so Handoff cannot submit a payment for it.',
    paymentId: null,
    expiresAt: null,
    quote: { exactOutput: true, pay: { amount: null, asset: 'USDC', routeCost: null }, sourceNetwork: { key: 'base', name: 'Base' }, networkGas: { asset: 'ETH', paidBy: 'payer' }, receive: { network: 'Monad', asset: 'USDC', requested: '25.00', guaranteed: false }, timeEstimateSeconds: null },
    steps: []
  };
}

async function openCheckout({ quote, receipts = [], sendError = null, routes = null }) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://pay.example.test/', pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  const doc = w.document;
  const requests = [];
  const receiptQueue = [...receipts];
  const calls = [];
  let sent = 0;
  const hashes = [APPROVE_HASH, DEPOSIT_HASH];

  w.ethereum = {
    request: async ({ method, params }) => {
      calls.push({ method, params });
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': return [PAYER];
        case 'wallet_switchEthereumChain': return null;
        case 'eth_chainId': return '0x2105';
        case 'eth_getTransactionReceipt': return { status: '0x1' };
        case 'eth_sendTransaction':
          if (sendError) throw sendError;
          return hashes[sent++];
        default: throw new Error(`unexpected ${method}`);
      }
    }
  };

  w.fetch = async (input, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method, url: input, body });
    let response;
    if (method === 'GET' && input === '/api/public-config') {
      response = { dynamic: { enabled: false }, payments: { sourceNetworks: publicSourceNetworks(), destination: { chainId: 143, name: 'Monad', asset: 'USDC' } } };
    } else if (method === 'GET' && input.startsWith('/api/public/resolve')) {
      response = { username: 'morgan', displayName: 'Morgan Ellis', avatarUrl: null, settlement: { chainId: 143, asset: 'USDC' } };
    } else if (method === 'GET' && input === '/api/relay/routes') {
      response = routes || { checkedAt: new Date().toISOString(), routes: publicSourceNetworks().map(network => ({ key: network.key, status: network.status === 'live' ? 'open' : 'not_available' })) };
    } else if (method === 'POST' && input === '/api/payments/quote') {
      response = quote;
    } else if (method === 'POST' && input === `/api/payments/${PAYMENT_ID}/awaiting-signature`) {
      response = { paymentId: PAYMENT_ID, status: 'awaiting_sender', label: 'Awaiting payer signature', final: false };
    } else if (method === 'POST' && input === `/api/payments/${PAYMENT_ID}/source-transaction`) {
      response = { paymentId: PAYMENT_ID, status: 'transaction_submitted', label: 'Transaction submitted', final: false, sourceTxHash: body.txHash };
    } else if (method === 'GET' && input === `/api/payments/${PAYMENT_ID}`) {
      response = receiptQueue.length ? receiptQueue.shift() : { paymentId: PAYMENT_ID, status: 'routing', label: 'Routing', final: false };
    } else {
      response = { message: 'Not found.' };
    }
    return new Response(JSON.stringify(response), { status: response.message === 'Not found.' ? 404 : 200, headers: { 'content-type': 'application/json' } });
  };
  w.scrollTo = () => {};
  w.eval(appSource);
  await settle();
  return { doc, requests, calls, w };
}

async function startQuote(doc) {
  doc.querySelector('#sendFromBalance').click();
  await settle();
  doc.querySelector('#payRecipient').value = 'morgan';
  doc.querySelector('#toNetworks').click();
  await settle();
  doc.querySelector('.network-option[data-network="base"]').click();
  await settle();
  doc.querySelector('#getQuote').click();
  await settle(80);
}

test('a quote-only route says "Quote preview only", offers no transaction, and signs nothing', async () => {
  const { doc, calls } = await openCheckout({ quote: previewQuote() });
  await startQuote(doc);

  assert.equal(doc.querySelector('#quoteBadge').textContent, 'Quote preview only');
  assert.equal(doc.querySelector('#quoteReceiveMeta').textContent, 'on Monad · not guaranteed');
  assert.equal(doc.querySelector('#getQuote').disabled, true);
  assert.equal(doc.querySelector('#signPay').hidden, true, 'no submit control when no executable payload exists');
  assert.equal(calls.some(call => call.method === 'eth_sendTransaction'), false);
  assert.doesNotMatch(doc.querySelector('#quoteState').textContent, /paid|payment sent|settled/i);
});

test('an executable quote is shown as received, and nothing is signed until the payer presses sign', async () => {
  const { doc, calls } = await openCheckout({ quote: executableQuote() });
  await startQuote(doc);

  assert.equal(doc.querySelector('#quoteBadge').textContent, 'Quote received');
  assert.equal(doc.querySelector('#signPay').hidden, false);
  assert.equal(doc.querySelector('#getQuote').hidden, true);
  assert.equal(calls.some(call => call.method === 'eth_sendTransaction'), false, 'a quote alone never asks for a signature');
  assert.equal(doc.querySelector('#quoteReceive').textContent, '25.00 USDC — guaranteed');
  assert.equal(doc.querySelector('#quoteReceiveMeta').textContent, 'on Monad · guaranteed');
  assert.equal(doc.querySelector('#quoteSend').textContent, '25.50 USDC');
  assert.equal(doc.querySelector('#quoteRouteCost').textContent, '0.50 USDC included in your quote');
  assert.equal(doc.querySelector('#quoteGas').textContent, 'ETH — paid by you');
  assert.match(doc.querySelector('#quoteState').textContent, /Recipient receives 25\.00 USDC on Monad — guaranteed/);
});

test('the payer approves in the wallet, the source hash is recorded, and Settled appears only from the server', async () => {
  const receipts = [
    { paymentId: PAYMENT_ID, status: 'transaction_submitted', label: 'Transaction submitted', final: false, sourceTxHash: DEPOSIT_HASH },
    { paymentId: PAYMENT_ID, status: 'settled', label: 'Settled as USDC on Monad', final: true, settlementVerified: true, destinationTxHash: `0x${'ee'.repeat(32)}` }
  ];
  const { doc, calls, requests } = await openCheckout({ quote: executableQuote(), receipts });
  await startQuote(doc);

  // Before the click, the badge says "Quote received", never "Settled".
  assert.doesNotMatch(doc.querySelector('#quoteBadge').textContent, /settled/i);

  doc.querySelector('#signPay').click();
  await waitUntil(() => doc.querySelector('#quoteBadge').textContent === 'Settled as USDC on Monad', 'the server-verified settled receipt');

  const sends = calls.filter(call => call.method === 'eth_sendTransaction');
  assert.equal(sends.length, 2, 'one approval and one deposit, both through the payer wallet');
  for (const send of sends) assert.equal(send.params[0].from, PAYER);
  assert.equal(sends[1].params[0].to, '0x4cd00e387622c35bddb9b4c962c136462338bc31');

  const submitted = requests.find(request => request.url === `/api/payments/${PAYMENT_ID}/source-transaction`);
  assert.deepEqual(submitted.body, { txHash: DEPOSIT_HASH });
  assert.ok(requests.findIndex(request => request.url === `/api/payments/${PAYMENT_ID}/awaiting-signature`) < requests.findIndex(request => request.url === `/api/payments/${PAYMENT_ID}/source-transaction`));

  const steps = [...doc.querySelectorAll('#receiptSteps li')].map(item => item.textContent.trim());
  assert.equal(steps.length, 6, 'the six receipt steps are shown');
  assert.equal(steps.at(-1), 'Settled as USDC on Monad', 'the final step is the server-verified settlement');
  assert.equal(doc.querySelector('#getQuote').hidden, true);
  assert.equal(doc.querySelector('#signPay').hidden, true);
});

test('declining the wallet prompt sends nothing to the server and says nothing was sent', async () => {
  const declined = Object.assign(new Error('User rejected the request.'), { code: 4001 });
  const { doc, requests } = await openCheckout({ quote: executableQuote(), sendError: declined });
  await startQuote(doc);
  doc.querySelector('#signPay').click();
  await waitUntil(() => /declined/i.test(doc.querySelector('#quoteState').textContent), 'the declined message');

  assert.equal(requests.some(request => request.url === `/api/payments/${PAYMENT_ID}/source-transaction`), false);
  assert.match(doc.querySelector('#quoteState').textContent, /declined/i);
  assert.doesNotMatch(doc.querySelector('#quoteBadge').textContent, /settled|paid|sent/i);
});

test('the receipt never shows Settled while the server still reports routing', async () => {
  const { doc } = await openCheckout({ quote: executableQuote() });
  await startQuote(doc);
  doc.querySelector('#signPay').click();
  await waitUntil(() => doc.querySelector('#quoteBadge').textContent === 'Routing', 'the routing receipt');
  assert.doesNotMatch(doc.querySelector('#quoteBadge').textContent, /settled/i);
});

test('the network list keeps Solana and TON visibly unavailable and offers exactly eight live EVM networks', async () => {
  const { doc } = await openCheckout({ quote: previewQuote() });
  doc.querySelector('#sendFromBalance').click();
  await settle();
  const options = [...doc.querySelectorAll('.network-option')];
  assert.equal(options.length, 10);
  const enabled = options.filter(option => !option.disabled);
  assert.equal(enabled.length, 8);
  for (const key of ['solana', 'ton']) {
    const option = doc.querySelector(`.network-option[data-network="${key}"]`);
    assert.equal(option.disabled, true);
    assert.match(option.textContent, /Not available yet/);
  }
  assert.doesNotMatch(doc.body.textContent, /\b10 (live )?networks\b/i);
  assert.doesNotMatch(doc.querySelector('.signal-strip').textContent, /EVM|network|Monad|USDC/i, 'recipient dashboard chrome keeps route implementation details out of view');
});

test('the payer cannot edit the recipient wallet: the pay modal has no wallet field', async () => {
  const { doc } = await openCheckout({ quote: previewQuote() });
  const inputs = [...doc.querySelectorAll('#payModal input')].map(input => input.id);
  assert.deepEqual(inputs, ['payRecipient', 'payAmount']);
  assert.equal(doc.querySelector('#quoteRecipientWallet'), null, 'the quote no longer renders a recipient wallet');
  assert.match(doc.querySelector('#payModal [data-step="choose"] .recipient-proof').textContent, /recipient securely on the server/i, 'copy says the server resolves the recipient');
});

test('the browser never performs a transaction for a non-EVM route, even if the server offered one', async () => {
  const { doc, calls } = await openCheckout({ quote: executableQuote() });
  doc.querySelector('#sendFromBalance').click();
  await settle();
  doc.querySelector('#payRecipient').value = 'morgan';
  doc.querySelector('#toNetworks').click();
  await settle();
  doc.querySelector('.network-option[data-network="solana"]').click();
  await settle();
  assert.equal(doc.querySelector('#getQuote').hidden, false, 'still on the network step');
  assert.equal(calls.some(call => call.method === 'eth_sendTransaction'), false);
});
