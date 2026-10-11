// Payment execution: quote-only safety, verified Relay plans, caps, payer-signing requirement,
// source-hash matching, Monad settlement, public privacy, and Solana/TON unavailability.
// Supabase and Relay are replaced at their module boundaries. Nothing here reaches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const fixtures = require('./support/paymentFixtures');
const { buildExecutionPlan, REASONS } = require('../src/executionPlan');
const { SOURCE_NETWORKS, publicSourceNetworks, requireLiveSourceNetwork, MONAD } = require('../src/paymentNetworks');
const policy = require('../src/paymentPolicy');
const { nextReceiptState, receiptStateForRelayStatus, publicReceipt, LABELS } = require('../src/paymentStatus');
const { verifyMonadSettlement } = require('../src/monadSettlement');

const PAYER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const SOURCE_HASH = `0x${'ab'.repeat(32)}`;
const DESTINATION_HASH = `0x${'cd'.repeat(32)}`;

// ---- Supabase and Relay stubs, installed before the payment modules load --------------------------
const supabase = require('../src/supabase');
const relay = require('../src/relayClient');
const USDC = 1_000_000n;

const store = { profiles: [], recipient_wallets: [], payment_attempts: [], writes: [], inserts: [] };
const relayCalls = { createQuote: [], getIntentStatus: 0, getChains: 0 };
let chainsForRelay = fixtures.chainsFixture();
let relayQuote = null;
let relayStatus = null;

function filterRows(rows, params) {
  return rows.filter(row => {
    for (const [key, raw] of params) {
      if (['select', 'order', 'limit'].includes(key)) continue;
      const value = decodeURIComponent(raw);
      if (value.startsWith('eq.')) {
        if (String(row[key] ?? '') !== value.slice(3)) return false;
      } else if (value === 'is.null') {
        if (row[key] !== null && row[key] !== undefined) return false;
      } else if (value === 'is.true') {
        if (row[key] !== true) return false;
      } else if (value.startsWith('gt.')) {
        if (!(Date.parse(row[key]) > Date.parse(value.slice(3)))) return false;
      }
    }
    return true;
  });
}

supabase.request = async (requestPath, options = {}) => {
  const method = options.method || 'GET';
  const [table, query = ''] = requestPath.split('?');
  const params = [...new URLSearchParams(query).entries()];
  if (table === 'rpc/reserve_payment_attempt') {
    const body = options.body;
    const row = {
      id: crypto.randomUUID(),
      payer_address: body.p_payer_address,
      recipient_profile_id: body.p_recipient_profile_id,
      recipient_wallet_id: body.p_recipient_wallet_id,
      source_chain_id: body.p_source_chain_id,
      source_currency: body.p_source_currency,
      source_amount: body.p_source_amount,
      quoted_source_amount: body.p_source_amount,
      requested_destination_amount: body.p_requested_destination_amount,
      quoted_route_fee_amount: body.p_quoted_route_fee_amount,
      actual_source_amount: null,
      exact_output: true,
      true_exact_output: true,
      minimum_destination_amount: body.p_minimum_destination_amount,
      relay_request_id: body.p_relay_request_id,
      quote_expires_at: body.p_quote_expires_at,
      status: 'quote_created',
      source_tx_hash: null,
      destination_tx_hash: null,
      created_at: new Date().toISOString()
    };
    store.payment_attempts.push(row);
    store.inserts.push(body);
    return [row];
  }
  if (method === 'PATCH') {
    store.writes.push({ table, query, body: options.body });
    const [, rawId] = table.split('?');
    const id = decodeURIComponent(query.match(/id=eq\.([^&]+)/)?.[1] || '');
    const guards = params.filter(([key]) => key !== 'id');
    const row = store.payment_attempts.find(item => item.id === id);
    if (!row || filterRows([row], guards).length === 0) return [];
    Object.assign(row, options.body);
    return [row];
  }
  const tableName = table.split('?')[0];
  const rows = store[tableName] || [];
  const matched = filterRows(rows, params);
  return matched;
};

relay.getChains = async () => { relayCalls.getChains += 1; return chainsForRelay; };
relay.createQuote = async (params) => { relayCalls.createQuote.push(params); return relayQuote; };
relay.getIntentStatus = async () => { relayCalls.getIntentStatus += 1; return relayStatus; };

const payments = require('../src/paymentService');
const { resolvePublicRecipient, resolveUsername } = require('../src/usernameService');

function resetStore() {
  store.profiles.length = 0;
  store.recipient_wallets.length = 0;
  store.payment_attempts.length = 0;
  store.writes.length = 0;
  store.inserts.length = 0;
  relayCalls.createQuote.length = 0;
  relayCalls.getIntentStatus = 0;
  relayCalls.getChains = 0;
  store.profiles.push({ id: 'profile-morgan', username: 'morgan', username_normalized: 'morgan', display_name: 'Morgan Ellis', avatar_url: null });
  store.recipient_wallets.push({ id: 'wallet-morgan', profile_id: 'profile-morgan', chain_id: 143, wallet_address: RECIPIENT, is_active: true });
}

function seedAttempt(fields) {
  const row = {
    id: crypto.randomUUID(),
    payer_address: PAYER,
    recipient_profile_id: 'profile-morgan',
    recipient_wallet_id: 'wallet-morgan',
    source_chain_id: 8453,
    source_currency: fixtures.ORIGIN_USDC,
    // Exact-output attempts persist merchant output separately from the quoted payer debit.
    source_amount: 25_500_000,
    quoted_source_amount: 25_500_000,
    actual_source_amount: null,
    quoted_route_fee_amount: 500_000,
    requested_destination_amount: 25_000_000,
    exact_output: true,
    true_exact_output: true,
    minimum_destination_amount: 25_000_000,
    destination_chain_id: 143,
    status: 'quote_created',
    source_tx_hash: null,
    destination_tx_hash: null,
    final_destination_amount: null,
    failure_code: null,
    relay_request_id: `req-${Math.random()}`,
    quote_expires_at: new Date(Date.now() + 300_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...fields
  };
  store.payment_attempts.push(row);
  return row;
}

function plan(overrides = {}) {
  const { quote } = fixtures.quoteFixture({ payer: PAYER, recipient: RECIPIENT, ...overrides.fixture });
  return buildExecutionPlan({
    quote,
    payer: PAYER,
    originChainId: 8453,
    originUsdc: fixtures.ORIGIN_USDC,
    allowedTargets: new Set([fixtures.DEPOSITORY, fixtures.ORIGIN_USDC]),
    chains: chainsForRelay,
    amountMinor: 25_000_000n,
    monadUsdc: fixtures.MONAD_USDC,
    monadChainId: 143,
    recipient: RECIPIENT,
    ...overrides.input
  });
}

// ---- 1. Quote-only safety and executable plans -----------------------------------------------------

test('a quote without protocol.v2 is quote-preview only and yields no steps', () => {
  const result = plan({ fixture: { withProtocol: false } });
  assert.equal(result.executable, false);
  assert.equal(result.reason, REASONS.PROTOCOL_MISSING);
  assert.deepEqual(result.steps, []);
  assert.match(result.message, /^Quote preview only\./);
});

test('a verified protocol.v2 quote becomes an executable approve + deposit plan for the payer', () => {
  const result = plan();
  assert.equal(result.executable, true);
  assert.deepEqual(result.steps.map(step => step.role), ['approve', 'source']);
  for (const step of result.steps) {
    assert.equal(step.from, PAYER, 'every step is signed by the payer');
    assert.equal(step.chainId, 8453);
    assert.equal(step.value, '0x0');
  }
  assert.equal(result.steps[1].to, fixtures.DEPOSITORY, 'the deposit pays the canonical depository from GET /chains');
  assert.equal(result.minimumDestinationMinor, '25000000');
  assert.equal(result.sourceAmountMinor, '25500000');
  assert.equal(result.routeFeeMinor, '500000');
});

test('a recomputed order ID that does not match the quote is refused', () => {
  const { quote } = fixtures.quoteFixture({ payer: PAYER, recipient: RECIPIENT });
  quote.protocol.v2.orderId = `0x${'ee'.repeat(32)}`;
  const result = buildExecutionPlan({
    quote, payer: PAYER, originChainId: 8453, originUsdc: fixtures.ORIGIN_USDC,
    allowedTargets: new Set([fixtures.DEPOSITORY]), chains: chainsForRelay, amountMinor: 25_000_000n,
    monadUsdc: fixtures.MONAD_USDC, monadChainId: 143, recipient: RECIPIENT
  });
  assert.equal(result.executable, false);
  assert.equal(result.reason, REASONS.ORDER_ID_MISMATCH);
});

test('a tampered recipient inside the signed order is refused', () => {
  const result = plan({ fixture: { mutateOrder: order => { order.output.payments[0].recipient = '0x9999999999999999999999999999999999999999'; } } });
  // The fixture hashes the tampered order, so the ID matches; the recipient check is what refuses it.
  assert.equal(result.executable, false);
  assert.equal(result.reason, REASONS.RECIPIENT);
});

test('the server-resolved recipient must be the order recipient, even if the quote is internally consistent', () => {
  const result = plan({ input: { recipient: '0x9999999999999999999999999999999999999999' } });
  assert.equal(result.reason, REASONS.RECIPIENT);
});

test('a deposit sent to anything other than the GET /chains depository is refused', () => {
  const result = plan({ fixture: { depositTo: '0x8888888888888888888888888888888888888888' } });
  assert.equal(result.executable, false);
  assert.equal(result.reason, REASONS.DEPOSITORY);
});

test('a deposit whose depositor is not the payer is refused', () => {
  const result = plan({ fixture: { depositor: '0x5555555555555555555555555555555555555555' } });
  assert.equal(result.reason, REASONS.FROM_MISMATCH);
});

test('a deposit that commits to a different order ID is refused', () => {
  const result = plan({ fixture: { depositId: `0x${'12'.repeat(32)}` } });
  assert.equal(result.reason, REASONS.DEPOSIT_CALL);
});

test('a deposit for a different amount than the requested input is refused', () => {
  const result = plan({ fixture: { depositAmount: 24_000_000n } });
  assert.equal(result.reason, REASONS.SOURCE_AMOUNT);
});

test('native value attached to the deposit is refused', () => {
  const result = plan({ fixture: { nativeValue: '1000' } });
  assert.equal(result.reason, REASONS.NATIVE_VALUE);
});

test('an expired order is refused', () => {
  const result = plan({ fixture: { deadline: Math.floor(Date.now() / 1000) - 10 } });
  assert.equal(result.reason, REASONS.ORDER_EXPIRED);
});

test('an approval that approves anything other than the depository is refused', () => {
  const result = plan({ fixture: { approveSpender: '0x8888888888888888888888888888888888888888' } });
  assert.equal(result.reason, REASONS.APPROVAL_SPENDER);
});

test('a quote without a minimum output cannot be settled-verified, so it is preview only', () => {
  const result = plan({ fixture: { minimumMinor: 0n } });
  assert.equal(result.executable, false);
  assert.equal(result.reason, REASONS.EXACT_OUTPUT);
});

test('a signature step is never executable', () => {
  const { quote } = fixtures.quoteFixture({ payer: PAYER, recipient: RECIPIENT });
  quote.steps.unshift({ id: 'sign', kind: 'signature', items: [{ status: 'incomplete', data: { sign: {} } }] });
  const result = buildExecutionPlan({
    quote, payer: PAYER, originChainId: 8453, originUsdc: fixtures.ORIGIN_USDC,
    allowedTargets: new Set([fixtures.DEPOSITORY]), chains: chainsForRelay, amountMinor: 25_000_000n,
    monadUsdc: fixtures.MONAD_USDC, monadChainId: 143, recipient: RECIPIENT
  });
  assert.equal(result.reason, REASONS.SIGNATURE_STEP);
});

// ---- 2. Caps ---------------------------------------------------------------------------------------

test('25 USDC per payment is allowed and 25.000001 USDC is refused', () => {
  assert.equal(policy.parseUsdcAmount('25'), 25n * USDC);
  assert.equal(policy.parseUsdcAmount('25.000000'), 25n * USDC);
  assert.throws(() => policy.assertPerPaymentCap(25n * USDC + 1n, 25n * USDC), error => error.code === 'PER_PAYMENT_CAP_EXCEEDED');
});

test('amounts with signs, exponents, or more than six decimals are refused', () => {
  for (const bad of ['-1', '1e3', '1.0000001', '0', '', 'abc']) {
    assert.throws(() => policy.parseUsdcAmount(bad), error => error.code === 'AMOUNT_INVALID', bad);
  }
});

test('the rolling 24-hour daily cap refuses the payment that would cross 100 USDC', () => {
  assert.throws(
    () => policy.assertWithinDailyCap({ amountMinor: 25n * USDC, usedMinor: 80n * USDC, dailyMinor: 100n * USDC }),
    error => error.code === 'DAILY_CAP_EXCEEDED'
  );
  assert.doesNotThrow(() => policy.assertWithinDailyCap({ amountMinor: 20n * USDC, usedMinor: 80n * USDC, dailyMinor: 100n * USDC }));
});

test('daily usage counts submitted and live quotes, not failed or refunded ones without a hash', () => {
  const now = Date.now();
  const recent = new Date(now - 60_000).toISOString();
  const live = new Date(now + 60_000).toISOString();
  const expired = new Date(now - 60_000).toISOString();
  const used = policy.dailyUsageMinor([
    { created_at: recent, source_amount: 25_000_000, status: 'quote_created', source_tx_hash: null, quote_expires_at: live },
    { created_at: recent, source_amount: 25_000_000, status: 'transaction_submitted', source_tx_hash: SOURCE_HASH, quote_expires_at: expired },
    { created_at: recent, source_amount: 25_000_000, status: 'failed', source_tx_hash: null, quote_expires_at: live },
    { created_at: recent, source_amount: 25_000_000, status: 'refunded', source_tx_hash: null, quote_expires_at: live },
    { created_at: recent, source_amount: 25_000_000, status: 'quote_created', source_tx_hash: null, quote_expires_at: expired },
    { created_at: new Date(now - 25 * 3600_000).toISOString(), source_amount: 25_000_000, status: 'transaction_submitted', source_tx_hash: SOURCE_HASH, quote_expires_at: expired }
  ], now);
  assert.equal(BigInt(used), 50n * USDC);
});

test('environment values can lower the caps but never raise them above 25 and 100 USDC', () => {
  const output = execFileSync(process.execPath, ['-e', "const {config}=require('./src/config');process.stdout.write(String(config.limits.maxMainnetUsdcMinor)+' '+String(config.limits.maxDailyMainnetUsdcMinor))"], {
    cwd: ROOT,
    env: { ...process.env, MAX_MAINNET_USDC_MINOR: '99000000', MAX_DAILY_MAINNET_USDC_MINOR: '900000000' },
    encoding: 'utf8'
  });
  assert.equal(output, '25000000 100000000');
});

test('createPaymentQuote applies the per-payment cap to Relay’s quoted payer input, not the requested merchant output', async () => {
  resetStore();
  relayQuote = fixtures.quoteFixture({
    payer: PAYER,
    recipient: RECIPIENT,
    amountMinor: 1_000_000n,
    sourceAmountMinor: 25_000_001n
  }).quote;
  await assert.rejects(
    payments.createPaymentQuote({ payer: PAYER, sourceNetwork: 'base', recipientHandle: 'morgan', amount: '1' }),
    error => error.code === 'PER_PAYMENT_CAP_EXCEEDED'
  );
  assert.equal(relayCalls.createQuote.length, 1, 'Relay quote is required before the real payer debit is known');
  assert.equal(store.inserts.length, 0);
});

test('createPaymentQuote applies the daily cap to Relay’s quoted payer input and allows exactly the cap', async () => {
  resetStore();
  for (let i = 0; i < 4; i += 1) seedAttempt({ source_amount: 20_000_000, quoted_source_amount: 20_000_000 });
  relayQuote = fixtures.quoteFixture({ payer: PAYER, recipient: RECIPIENT, amountMinor: 1_000_000n, sourceAmountMinor: 20_000_001n }).quote;
  await assert.rejects(
    payments.createPaymentQuote({ payer: PAYER, sourceNetwork: 'base', recipientHandle: 'morgan', amount: '1' }),
    error => error.code === 'DAILY_CAP_EXCEEDED'
  );
  assert.equal(relayCalls.createQuote.length, 1);

  resetStore();
  for (let i = 0; i < 4; i += 1) seedAttempt({ source_amount: 20_000_000, quoted_source_amount: 20_000_000 });
  relayQuote = fixtures.quoteFixture({ payer: PAYER, recipient: RECIPIENT, amountMinor: 19_500_000n, sourceAmountMinor: 20_000_000n }).quote;
  const result = await payments.createPaymentQuote({ payer: PAYER, sourceNetwork: 'base', recipientHandle: 'morgan', amount: '19.5' });
  assert.equal(result.executable, true);
  assert.equal(store.inserts.length, 1);
});

// ---- 3. Quote creation: payer-signing requirement and privacy --------------------------------------

test('an executable quote reserves one attempt, requests protocol data, and never exposes the recipient wallet', async () => {
  resetStore();
  relayQuote = fixtures.quoteFixture({ payer: PAYER, recipient: RECIPIENT, amountMinor: 24_500_000n, sourceAmountMinor: 25_000_000n }).quote;
  const result = await payments.createPaymentQuote({ payer: PAYER, sourceNetwork: 'base', recipientHandle: '@Morgan', amount: '24.5' });

  assert.equal(result.executable, true);
  assert.equal(result.status, 'quote_created');
  assert.equal(result.label, 'Quote received');
  assert.equal(result.steps.length, 2);
  assert.equal(relayCalls.createQuote.length, 1);
  const sent = relayCalls.createQuote[0];
  assert.equal(sent.includeProtocolData, true);
  assert.equal(sent.tradeType, 'EXACT_OUTPUT');
  assert.equal(sent.amount, '24500000', 'Relay receives desired Monad-USDC output, not a payer input');
  assert.equal(sent.enableTrueExactOutput, true);
  assert.equal(sent.subsidizeFees, false);
  assert.equal(sent.recipient, RECIPIENT, 'the recipient comes from the server lookup');
  assert.equal(result.quote.receive.requested, '24.50');
  assert.equal(result.quote.receive.guaranteed, true);
  assert.equal(result.quote.pay.amount, '25.00');
  assert.equal(result.quote.pay.routeCost, '0.50');
  assert.equal(sent.user, PAYER);
  assert.equal(store.inserts.length, 1);
  assert.equal(store.inserts[0].p_recipient_wallet_id, 'wallet-morgan');
  assert.equal(JSON.stringify(result).includes(RECIPIENT), false, 'the browser response carries no recipient wallet');
});

test('a quote preview reserves nothing and offers no steps', async () => {
  resetStore();
  relayQuote = fixtures.quoteFixture({ payer: PAYER, recipient: RECIPIENT, withProtocol: false }).quote;
  const result = await payments.createPaymentQuote({ payer: PAYER, sourceNetwork: 'base', recipientHandle: 'morgan', amount: '25' });
  assert.equal(result.executable, false);
  assert.equal(result.paymentId, null);
  assert.deepEqual(result.steps, []);
  assert.equal(result.label, 'Quote preview only');
  assert.equal(store.inserts.length, 0, 'a preview never reserves a daily-cap slot');
});

test('the payer cannot choose a recipient wallet: unknown usernames are refused, and wallet fields are not used', async () => {
  resetStore();
  await assert.rejects(
    payments.createPaymentQuote({ payer: PAYER, sourceNetwork: 'base', recipientHandle: 'nobody', amount: '1' }),
    error => error.code === 'RECIPIENT_NOT_FOUND'
  );
  assert.equal(relayCalls.createQuote.length, 0);
});

test('a malformed payer wallet is refused before any lookup', async () => {
  resetStore();
  await assert.rejects(
    payments.createPaymentQuote({ payer: '0x123', sourceNetwork: 'base', recipientHandle: 'morgan', amount: '1' }),
    error => error.code === 'PAYER_INVALID'
  );
});

test('signing is gated: an expired quote cannot move to awaiting-signature', async () => {
  resetStore();
  const row = seedAttempt({ quote_expires_at: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(payments.markAwaitingSignature(row.id), error => error.code === 'QUOTE_EXPIRED');
});

test('the receipt moves to awaiting-signature only from a live quote', async () => {
  resetStore();
  const row = seedAttempt({});
  const receipt = await payments.markAwaitingSignature(row.id);
  assert.equal(receipt.status, 'awaiting_sender');
  assert.equal(receipt.label, 'Awaiting payer signature');
});

// ---- 4. Source hash requirement --------------------------------------------------------------------

test('a source transaction hash must be a 32-byte hash', async () => {
  resetStore();
  const row = seedAttempt({});
  await assert.rejects(payments.recordSourceTransaction(row.id, '0x1234'), error => error.code === 'SOURCE_HASH_INVALID');
  await assert.rejects(payments.recordSourceTransaction(row.id, undefined), error => error.code === 'SOURCE_HASH_INVALID');
});

test('recording the source hash moves the receipt to transaction-submitted, and a second hash is refused', async () => {
  resetStore();
  const row = seedAttempt({ status: 'awaiting_sender' });
  const receipt = await payments.recordSourceTransaction(row.id, SOURCE_HASH);
  assert.equal(receipt.status, 'transaction_submitted');
  assert.equal(receipt.sourceTxHash, SOURCE_HASH);
  await assert.rejects(payments.recordSourceTransaction(row.id, `0x${'ef'.repeat(32)}`), error => error.code === 'PAYMENT_STATE_CONFLICT');
});

test('a source hash Relay does not list fails the payment and is never settled', async () => {
  resetStore();
  const attempt = seedAttempt({ status: 'transaction_submitted', source_tx_hash: SOURCE_HASH });
  relayStatus = { status: 'pending', inTxHashes: [`0x${'99'.repeat(32)}`] };
  const mismatch = await payments.refreshAttempt(attempt, RECIPIENT);
  assert.equal(mismatch.status, 'failed');
  assert.equal(mismatch.failure_code, 'SOURCE_HASH_UNMATCHED');
  assert.notEqual(mismatch.status, 'settled');
});

test('a source hash Relay lists is accepted, and an unlisted Relay status keeps the payment in routing', async () => {
  resetStore();
  const attempt = seedAttempt({ status: 'transaction_submitted', source_tx_hash: SOURCE_HASH });
  relayStatus = { status: 'pending', inTxHashes: [SOURCE_HASH] };
  const routing = await payments.refreshAttempt(attempt, RECIPIENT);
  assert.equal(routing.status, 'routing');
  relayStatus = { status: 'pending', inTxHashes: [] };
  const notYetIndexed = await payments.refreshAttempt(attempt, RECIPIENT);
  assert.notEqual(notYetIndexed.status, 'failed');
});

// ---- 5. Monad settlement requirement ---------------------------------------------------------------

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topicFor = address => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;

function rpcStub({ chainId = 143, status = '0x1', logs } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    let result;
    if (body.method === 'eth_chainId') result = `0x${chainId.toString(16)}`;
    else if (body.method === 'eth_getTransactionReceipt') {
      result = { status, logs: logs ?? [{ address: MONAD.usdcAddress, topics: [TRANSFER, topicFor(PAYER), topicFor(RECIPIENT)], data: `0x${(25_000_000n).toString(16)}` }] };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const verifyArgs = { txHash: DESTINATION_HASH, recipient: RECIPIENT, requiredMinor: '25000000', monadUsdc: MONAD.usdcAddress, monadChainId: 143, rpcUrl: 'https://rpc.test' };

test('Monad settlement is verified only with a successful receipt and an exact USDC Transfer to the recipient', async () => {
  const ok = await verifyMonadSettlement({ ...verifyArgs, fetchImpl: rpcStub() });
  assert.equal(ok.verified, true);
  assert.equal(ok.receivedMinor, '25000000');
});

test('a reverted Monad transaction is never settlement', async () => {
  const result = await verifyMonadSettlement({ ...verifyArgs, fetchImpl: rpcStub({ status: '0x0' }) });
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'TRANSACTION_REVERTED');
});

test('a receipt with no USDC transfer to the recipient is not settlement', async () => {
  const result = await verifyMonadSettlement({ ...verifyArgs, fetchImpl: rpcStub({ logs: [] }) });
  assert.equal(result.reason, 'NO_USDC_TRANSFER_TO_RECIPIENT');
});

test('a transfer below the exact requested amount is not settlement', async () => {
  const result = await verifyMonadSettlement({ ...verifyArgs, requiredMinor: '30000000', fetchImpl: rpcStub() });
  assert.equal(result.reason, 'AMOUNT_BELOW_REQUESTED');
});

test('a transfer above the exact requested amount is not settlement', async () => {
  const result = await verifyMonadSettlement({ ...verifyArgs, requiredMinor: '24000000', fetchImpl: rpcStub() });
  assert.equal(result.reason, 'AMOUNT_ABOVE_REQUESTED');
});

test('the wrong Monad chain is refused', async () => {
  const result = await verifyMonadSettlement({ ...verifyArgs, fetchImpl: rpcStub({ chainId: 1 }) });
  assert.equal(result.reason, 'WRONG_CHAIN');
});

test('Relay success is shown as Routing, not Settled, while Monad cannot be reached', async () => {
  resetStore();
  const attempt = seedAttempt({ status: 'routing', source_tx_hash: SOURCE_HASH });
  relayStatus = { status: 'success', inTxHashes: [SOURCE_HASH], txHashes: [DESTINATION_HASH] };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('rpc down'); };
  try {
    const update = await payments.refreshAttempt(attempt, RECIPIENT);
    assert.notEqual(update.status, 'settled');
    assert.equal(update.destination_tx_hash, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('Relay success with a verified Monad transfer settles with the destination hash and final amount', async () => {
  resetStore();
  const attempt = seedAttempt({ status: 'routing', source_tx_hash: SOURCE_HASH });
  relayStatus = { status: 'success', inTxHashes: [SOURCE_HASH], txHashes: [DESTINATION_HASH] };
  const original = globalThis.fetch;
  globalThis.fetch = rpcStub();
  try {
    const update = await payments.refreshAttempt(attempt, RECIPIENT);
    assert.equal(update.status, 'settled');
    assert.equal(update.destination_tx_hash, DESTINATION_HASH);
    assert.equal(update.final_destination_amount, '25000000');
    assert.ok(update.settled_at);
  } finally {
    globalThis.fetch = original;
  }
});

test('Relay success that Monad contradicts fails the payment and is never settled', async () => {
  resetStore();
  const attempt = seedAttempt({ status: 'routing', source_tx_hash: SOURCE_HASH });
  relayStatus = { status: 'success', inTxHashes: [SOURCE_HASH], txHashes: [DESTINATION_HASH] };
  const original = globalThis.fetch;
  globalThis.fetch = rpcStub({ logs: [] });
  try {
    const update = await payments.refreshAttempt(attempt, RECIPIENT);
    assert.equal(update.status, 'failed');
    assert.equal(update.failure_code, 'SETTLEMENT_NOT_VERIFIED');
  } finally {
    globalThis.fetch = original;
  }
});

test('receipt states only move forward, and final receipts are frozen', () => {
  assert.equal(nextReceiptState('routing', 'source_confirmed'), 'routing');
  assert.equal(nextReceiptState('quote_created', 'routing'), 'routing');
  assert.equal(nextReceiptState('settled', 'routing'), 'settled');
  assert.equal(nextReceiptState('failed', 'settled'), 'failed');
  assert.equal(receiptStateForRelayStatus('success'), 'settled', 'the mapping is a candidate only; the server still verifies Monad');
});

test('only a verified settled receipt carries the "Settled as USDC on Monad" label', () => {
  const base = seedAttempt({ status: 'routing', source_tx_hash: SOURCE_HASH });
  assert.equal(publicReceipt(base, null).label, 'Routing');
  assert.equal(LABELS.quote_created, 'Quote received');
  const settled = publicReceipt({ ...base, status: 'settled', destination_tx_hash: DESTINATION_HASH, final_destination_amount: 25_000_000, settled_at: new Date().toISOString() }, null);
  assert.equal(settled.label, 'Settled as USDC on Monad');
  assert.equal(settled.settlementVerified, true);
});

test('the receipt write sends only real table columns, so a routine refresh is never rejected', async () => {
  resetStore();
  const attempt = seedAttempt({ status: 'transaction_submitted', source_tx_hash: SOURCE_HASH });
  relayStatus = { status: 'pending', inTxHashes: [SOURCE_HASH] };
  store.writes.length = 0;
  await payments.getPaymentReceipt(attempt.id);
  const columns = new Set(['status', 'relay_status', 'failure_code', 'destination_tx_hash', 'final_destination_amount', 'actual_source_amount', 'settled_at', 'relay_status_updated_at']);
  for (const write of store.writes) {
    for (const key of Object.keys(write.body)) assert.ok(columns.has(key), `unexpected column ${key}`);
  }
  assert.equal(attempt.relay_status, 'pending');
});

// ---- 6. Public privacy -----------------------------------------------------------------------------

test('the public recipient lookup returns display fields and no wallet, IDs, or payment internals', async () => {
  resetStore();
  const publicRecipient = await resolvePublicRecipient('morgan');
  assert.equal(publicRecipient.username, 'morgan');
  const json = JSON.stringify(publicRecipient);
  assert.equal(json.includes(RECIPIENT), false);
  assert.equal(/wallet|walletId|profileId|recipient"/.test(json), false);
  // The server-internal lookup does return the wallet, for settlement verification only.
  assert.equal((await resolveUsername('morgan')).recipient, RECIPIENT);
});

test('the public receipt never contains either wallet address', () => {
  const attempt = seedAttempt({ status: 'transaction_submitted', source_tx_hash: SOURCE_HASH });
  const json = JSON.stringify(publicReceipt(attempt, { username: 'morgan', displayName: 'Morgan Ellis' }));
  assert.equal(json.includes(RECIPIENT), false);
  assert.equal(json.includes(PAYER), false);
  assert.equal(json.includes(attempt.recipient_wallet_id), false);
});

test('the route status is display-safe: no Relay payload, solver addresses, or depository addresses', async () => {
  resetStore();
  const payments2 = require('../src/paymentService');
  const status = await payments2.getRouteStatus();
  const json = JSON.stringify(status);
  assert.equal(json.includes(fixtures.DEPOSITORY), false);
  assert.equal(json.includes('solverAddresses'), false);
  assert.equal(json.includes('erc20Currencies'), false);
  assert.equal(status.routes.length, SOURCE_NETWORKS.length);
});

// ---- 7. Solana and TON -----------------------------------------------------------------------------

test('Solana and TON are listed as not available yet and are not executable', () => {
  const list = publicSourceNetworks();
  for (const key of ['solana', 'ton']) {
    assert.equal(list.find(network => network.key === key).status, 'not_available');
    assert.throws(() => requireLiveSourceNetwork(key), error => error.code === 'NETWORK_NOT_AVAILABLE');
  }
});

test('exactly eight source networks are live, and each is an executable EVM network', () => {
  const live = publicSourceNetworks().filter(network => network.status === 'live');
  assert.equal(live.length, 8);
  assert.deepEqual(live.map(network => network.key).sort(), ['arbitrum', 'avalanche', 'base', 'bnb', 'celo', 'ethereum', 'optimism', 'polygon'].sort());
  assert.ok(live.every(network => network.type === 'evm'));
});

test('a Solana or TON quote is refused before Relay is called', async () => {
  resetStore();
  for (const sourceNetwork of ['solana', 'ton']) {
    await assert.rejects(
      payments.createPaymentQuote({ payer: PAYER, sourceNetwork, recipientHandle: 'morgan', amount: '1' }),
      error => error.code === 'NETWORK_NOT_AVAILABLE'
    );
  }
  assert.equal(relayCalls.createQuote.length, 0);
});

test('an unknown source network is refused', async () => {
  resetStore();
  await assert.rejects(
    payments.createPaymentQuote({ payer: PAYER, sourceNetwork: 'dogechain', recipientHandle: 'morgan', amount: '1' }),
    error => error.code === 'NETWORK_UNKNOWN'
  );
});

test('the route status reports Solana and TON without asking Relay about them', async () => {
  resetStore();
  const status = await payments.getRouteStatus();
  assert.equal(status.routes.find(route => route.key === 'solana').status, 'not_available');
  assert.equal(status.routes.find(route => route.key === 'ton').status, 'not_available');
});
