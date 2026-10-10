// Payment execution orchestration. Server-only. Handoff never holds keys and never broadcasts a
// transaction: the payer's own EVM wallet signs and broadcasts each validated step.
//
// Receipt lifecycle:
//   quote_created → awaiting_sender → transaction_submitted → source_confirmed → routing → settled | failed | refunded
// "settled" is written only after verifyMonadSettlement() confirms a Monad USDC Transfer to the recipient.
const { config } = require('./config');
const { request } = require('./supabase');
const { resolveUsername } = require('./usernameService');
const { validateHandoffHandle } = require('./identity');
const { MONAD, requireLiveSourceNetwork } = require('./paymentNetworks');
const relay = require('./relayClient');
const { buildExecutionPlan } = require('./executionPlan');
const policy = require('./paymentPolicy');
const { receiptStateForRelayStatus, nextReceiptState, isFinal, publicReceipt, FAILURE_MESSAGES } = require('./paymentStatus');
const { verifyMonadSettlement } = require('./monadSettlement');

const QUOTE_TTL_MS = 5 * 60 * 1000;
const REFRESH_MIN_INTERVAL_MS = 2000;
const PAYER_RE = /^0x[0-9a-fA-F]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const PRE_SUBMISSION = new Set(['quote_created', 'awaiting_sender']);
const lastRefreshAt = new Map();

function serviceError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function limits() {
  return { perPaymentMinor: config.limits.maxMainnetUsdcMinor, dailyMinor: config.limits.maxDailyMainnetUsdcMinor };
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

// Converts database errors from the cap function and the migration state into safe API errors.
function mapDatabaseError(error) {
  const message = String(error?.message || '');
  if (message === 'DAILY_CAP_EXCEEDED') return policy.dailyCapError(limits().dailyMinor);
  if (message === 'PER_PAYMENT_CAP_EXCEEDED') return serviceError(`A single payment can be at most ${policy.formatUsdc(limits().perPaymentMinor)} USDC.`, 'PER_PAYMENT_CAP_EXCEEDED');
  if (error?.details?.code === 'PGRST202' || error?.details?.code === '42883') {
    console.error('Handoff: payment migration 0003 is not applied (reserve_payment_attempt missing).');
    return serviceError('Payments are temporarily unavailable.', 'PAYMENTS_UNAVAILABLE', 503);
  }
  if (error?.details?.code === '23505') return serviceError('This payment could not be recorded because it already exists.', 'PAYMENT_CONFLICT', 409);
  return error;
}

async function recentAttemptsForPayer(payer) {
  const since = new Date(Date.now() - policy.DAY_MS).toISOString();
  const rows = await request(
    `payment_attempts?select=id,source_amount,status,source_tx_hash,quote_expires_at,created_at&payer_address=eq.${encodeURIComponent(payer)}&created_at=gt.${encodeURIComponent(since)}&order=created_at.desc&limit=500`
  );
  return Array.isArray(rows) ? rows : [];
}

function toDecimalString(value) {
  return /^\d+$/.test(String(value ?? '')) ? String(value) : null;
}

function publicQuoteSummary(quote, network, amountMinor) {
  const out = quote?.details?.currencyOut;
  const expected = toDecimalString(out?.amount);
  const minimum = toDecimalString(out?.minimumAmount);
  const time = Number.isSafeInteger(quote?.details?.timeEstimate) ? quote.details.timeEstimate : null;
  return {
    send: { amount: policy.formatUsdc(amountMinor), asset: 'USDC' },
    sourceNetwork: { key: network.key, name: network.name },
    receive: {
      network: MONAD.name,
      asset: MONAD.asset,
      expected: expected ? policy.formatUsdc(expected) : null,
      minimum: minimum ? policy.formatUsdc(minimum) : null
    },
    timeEstimateSeconds: time
  };
}

/**
 * POST /api/payments/quote
 * Returns either an executable quote (with validated transaction steps the payer must sign) or a
 * "Quote preview only" result with no steps. Nothing is persisted for a preview.
 */
async function createPaymentQuote({ payer, sourceNetwork, recipientHandle, amount }) {
  if (!PAYER_RE.test(String(payer || ''))) throw serviceError('Connect an EVM wallet to get a quote.', 'PAYER_INVALID');
  const network = requireLiveSourceNetwork(sourceNetwork);
  const payerLower = payer.toLowerCase();
  const amountMinor = policy.parseUsdcAmount(amount);
  policy.assertPerPaymentCap(amountMinor, limits().perPaymentMinor);

  // The recipient is resolved here, from the username only. No wallet can be supplied by the caller.
  let handle;
  try {
    handle = validateHandoffHandle(recipientHandle);
  } catch (error) {
    throw serviceError(error.message, 'RECIPIENT_INVALID', 400);
  }
  const recipient = await resolveUsername(handle);
  if (!recipient) throw serviceError('This Handoff username is not registered.', 'RECIPIENT_NOT_FOUND', 404);

  // Daily cap, pre-check. The database re-checks inside a lock when the attempt is reserved.
  const usedMinor = policy.dailyUsageMinor(await recentAttemptsForPayer(payerLower));
  policy.assertWithinDailyCap({ amountMinor, usedMinor, dailyMinor: limits().dailyMinor });

  const chains = await relay.getChains();
  const origin = relay.findChain(chains, network.chainId);
  const originUsdc = relay.usdcOf(origin);
  if (!origin || !originUsdc) {
    throw serviceError(`USDC routing from ${network.name} is unavailable right now.`, 'ROUTE_UNAVAILABLE', 422);
  }
  const destination = relay.findChain(chains, MONAD.chainId);
  if (!destination || relay.usdcOf(destination)?.address?.toLowerCase() !== MONAD.usdcAddress) {
    throw serviceError('Monad USDC routing is unavailable right now.', 'ROUTE_UNAVAILABLE', 503);
  }

  const quote = await relay.createQuote({
    user: payerLower,
    refundTo: payerLower,
    recipient: recipient.recipient,
    originChainId: network.chainId,
    destinationChainId: MONAD.chainId,
    originCurrency: originUsdc.address,
    destinationCurrency: MONAD.usdcAddress,
    amount: amountMinor.toString(),
    tradeType: 'EXACT_INPUT',
    // Protocol data is required to verify the order locally before anything is signed.
    includeProtocolData: true
  });

  const plan = buildExecutionPlan({
    quote,
    payer: payerLower,
    originChainId: network.chainId,
    originUsdc: originUsdc.address.toLowerCase(),
    allowedTargets: relay.relayContractAddresses(origin),
    chains,
    amountMinor,
    monadUsdc: MONAD.usdcAddress,
    monadChainId: MONAD.chainId,
    // The server-resolved recipient. The payer never supplies or edits this.
    recipient: String(recipient.recipient || '').toLowerCase()
  });
  const summary = publicQuoteSummary(quote, network, amountMinor);

  if (!plan.executable) {
    // Preview only: nothing is reserved, and no transaction can be submitted for this quote.
    return {
      executable: false,
      status: 'quote_preview',
      label: 'Quote preview only',
      reason: plan.reason,
      message: plan.message,
      paymentId: null,
      expiresAt: null,
      quote: summary,
      steps: []
    };
  }

  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
  let row;
  try {
    row = firstRow(await request('rpc/reserve_payment_attempt', {
      method: 'POST',
      body: {
        p_payer_address: payerLower,
        p_recipient_profile_id: recipient.profileId,
        p_recipient_wallet_id: recipient.walletId,
        p_source_chain_id: network.chainId,
        p_source_currency: originUsdc.address.toLowerCase(),
        p_source_amount: amountMinor.toString(),
        p_minimum_destination_amount: plan.minimumDestinationMinor,
        p_relay_request_id: plan.requestId,
        p_quote_expires_at: expiresAt,
        p_per_payment_cap: limits().perPaymentMinor.toString(),
        p_daily_cap: limits().dailyMinor.toString()
      }
    }));
  } catch (error) {
    throw mapDatabaseError(error);
  }
  if (!row?.id) throw serviceError('Handoff could not record this quote. Try again.', 'PAYMENT_CONFLICT', 409);

  return {
    executable: true,
    status: 'quote_created',
    label: 'Quote received',
    reason: null,
    message: null,
    paymentId: row.id,
    expiresAt,
    quote: summary,
    steps: plan.steps.map(({ index, role, chainId, from, to, data, value }) => ({ index, role, chainId, from, to, data, value }))
  };
}

/**
 * GET /api/relay/routes. Display-safe: one status per source network, nothing from Relay's payload.
 * Solana and TON are reported as not available yet without consulting Relay at all.
 */
async function getRouteStatus() {
  const { SOURCE_NETWORKS } = require('./paymentNetworks');
  let chains = null;
  try {
    chains = await relay.getChains();
  } catch {
    chains = null;
  }
  const routes = SOURCE_NETWORKS.map(network => {
    if (network.status !== 'live') return { key: network.key, status: 'not_available' };
    const chain = chains ? relay.findChain(chains, network.chainId) : null;
    const open = Boolean(chain && relay.usdcOf(chain));
    return { key: network.key, status: chains ? (open ? 'open' : 'unavailable') : 'unknown' };
  });
  return { checkedAt: new Date().toISOString(), routes };
}

async function getAttempt(paymentId) {
  if (!UUID_RE.test(String(paymentId || ''))) throw serviceError('Payment not found.', 'PAYMENT_NOT_FOUND', 404);
  const rows = await request(`payment_attempts?select=*&id=eq.${paymentId}&limit=1`);
  const attempt = firstRow(rows);
  if (!attempt) throw serviceError('Payment not found.', 'PAYMENT_NOT_FOUND', 404);
  return attempt;
}

async function recipientFor(attempt) {
  const profiles = await request(`profiles?select=username,display_name&id=eq.${attempt.recipient_profile_id}&limit=1`);
  const profile = firstRow(profiles);
  return profile ? { username: profile.username, displayName: profile.display_name || profile.username } : null;
}

async function recipientWalletAddress(attempt) {
  // Server-internal: used only to verify the Monad Transfer. Never returned to a caller.
  const wallets = await request(`recipient_wallets?select=wallet_address&id=eq.${attempt.recipient_wallet_id}&limit=1`);
  return firstRow(wallets)?.wallet_address || null;
}

async function patchAttempt(paymentId, fields, filter = '') {
  const rows = await request(`payment_attempts?id=eq.${paymentId}${filter}`, { method: 'PATCH', body: fields });
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

/**
 * POST /api/payments/:id/awaiting-signature
 * Called right before the payer's wallet is asked to sign the first transaction.
 */
async function markAwaitingSignature(paymentId) {
  const attempt = await getAttempt(paymentId);
  if (attempt.status === 'awaiting_sender') return publicReceipt(attempt, await recipientFor(attempt));
  if (attempt.status !== 'quote_created') {
    throw serviceError('This payment is no longer waiting for a signature.', 'PAYMENT_STATE_CONFLICT', 409);
  }
  if (Date.parse(attempt.quote_expires_at) <= Date.now()) {
    throw serviceError('This quote has expired. Get a new quote to continue.', 'QUOTE_EXPIRED', 409);
  }
  try {
    await patchAttempt(paymentId, { status: 'awaiting_sender' }, '&status=eq.quote_created');
  } catch (error) {
    throw mapDatabaseError(error);
  }
  const updated = await getAttempt(paymentId);
  return publicReceipt(updated, await recipientFor(updated));
}

/**
 * POST /api/payments/:id/source-transaction  body: { txHash }
 * Records the payer's source (deposit) transaction hash. The hash is then verified against Relay's
 * status on every refresh: a hash Relay does not recognise fails the payment rather than settling it.
 */
async function recordSourceTransaction(paymentId, txHash) {
  if (!HASH_RE.test(String(txHash || ''))) throw serviceError('Enter a valid transaction hash.', 'SOURCE_HASH_INVALID');
  const attempt = await getAttempt(paymentId);
  if (attempt.source_tx_hash) {
    if (attempt.source_tx_hash.toLowerCase() === txHash.toLowerCase()) {
      return publicReceipt(attempt, await recipientFor(attempt));
    }
    throw serviceError('A source transaction is already recorded for this payment.', 'PAYMENT_STATE_CONFLICT', 409);
  }
  if (!PRE_SUBMISSION.has(attempt.status)) {
    throw serviceError('This payment is no longer waiting for a source transaction.', 'PAYMENT_STATE_CONFLICT', 409);
  }
  // Funds may already have moved if the wallet broadcast before the expiry check, so a late hash is
  // still recorded. Relay status decides what happens next.
  try {
    await patchAttempt(paymentId, { source_tx_hash: txHash, status: 'transaction_submitted' }, '&source_tx_hash=is.null');
  } catch (error) {
    throw mapDatabaseError(error);
  }
  const updated = await getAttempt(paymentId);
  if (updated.source_tx_hash?.toLowerCase() !== txHash.toLowerCase()) {
    throw serviceError('A source transaction is already recorded for this payment.', 'PAYMENT_STATE_CONFLICT', 409);
  }
  return publicReceipt(updated, await recipientFor(updated));
}

function failureCodeFrom(relayStatus) {
  const raw = relayStatus.refundFailReason || relayStatus.failReason;
  return typeof raw === 'string' && /^[A-Z_]{2,40}$/.test(raw) && FAILURE_MESSAGES[raw] ? raw : 'RELAY_FAILURE';
}

// Monad verdicts that mean the chain contradicts Relay's success. Anything else is treated as "not yet".
const DEFINITIVE_SETTLEMENT_FAILURES = new Set(['TRANSACTION_REVERTED', 'NO_USDC_TRANSFER_TO_RECIPIENT', 'AMOUNT_BELOW_MINIMUM']);

// Advances the receipt from Relay's status. Settlement is accepted only after Monad verification.
async function refreshAttempt(attempt, recipientWallet) {
  const relayStatus = await relay.getIntentStatus(attempt.relay_request_id);
  const sourceHash = attempt.source_tx_hash.toLowerCase();

  // A source hash Relay does not list is a mismatch. Relay lists inbound hashes once it indexes them.
  const inbound = Array.isArray(relayStatus.inTxHashes) ? relayStatus.inTxHashes.map(hash => String(hash).toLowerCase()) : [];
  if (inbound.length > 0 && !inbound.includes(sourceHash)) {
    return { status: 'failed', failure_code: 'SOURCE_HASH_UNMATCHED', relay_status: relayStatus.status || null };
  }

  const target = receiptStateForRelayStatus(relayStatus.status);
  const base = { relay_status: relayStatus.status || null };

  if (relayStatus.status === 'failure') return { ...base, status: 'failed', failure_code: failureCodeFrom(relayStatus) };
  if (relayStatus.status === 'refund') return { ...base, status: 'refunded', failure_code: failureCodeFrom(relayStatus) };
  if (relayStatus.status !== 'success') {
    const next = nextReceiptState(attempt.status, target);
    return next === attempt.status ? base : { ...base, status: next };
  }

  // Relay says success. Only Monad can confirm that USDC reached the recipient.
  const destinationHash = Array.isArray(relayStatus.txHashes)
    ? relayStatus.txHashes.map(String).reverse().find(hash => HASH_RE.test(hash))
    : null;
  if (!destinationHash || !recipientWallet) {
    const next = nextReceiptState(attempt.status, 'routing');
    return { ...base, status: next };
  }
  const verdict = await verifyMonadSettlement({
    txHash: destinationHash,
    recipient: recipientWallet,
    minimumMinor: attempt.minimum_destination_amount,
    monadUsdc: MONAD.usdcAddress,
    monadChainId: MONAD.chainId,
    rpcUrl: config.monad.rpcUrl
  });
  if (verdict.verified) {
    return {
      ...base,
      status: 'settled',
      destination_tx_hash: destinationHash,
      final_destination_amount: verdict.receivedMinor,
      settled_at: new Date().toISOString()
    };
  }
  // Pending reasons keep the payment in routing. A definitive contradiction fails it, never settles it.
  if (!DEFINITIVE_SETTLEMENT_FAILURES.has(verdict.reason)) {
    return { ...base, status: nextReceiptState(attempt.status, 'routing') };
  }
  return { ...base, status: 'failed', failure_code: 'SETTLEMENT_NOT_VERIFIED', destination_tx_hash: destinationHash };
}

/**
 * GET /api/payments/:id — the receipt. Refreshes from Relay (and Monad, if Relay reports success)
 * at most once every couple of seconds per payment.
 */
async function getPaymentReceipt(paymentId) {
  let attempt = await getAttempt(paymentId);
  const recipient = await recipientFor(attempt);
  const now = Date.now();
  const due = !isFinal(attempt.status) && attempt.source_tx_hash && attempt.relay_request_id
    && now - (lastRefreshAt.get(paymentId) || 0) >= REFRESH_MIN_INTERVAL_MS;

  if (due) {
    lastRefreshAt.set(paymentId, now);
    try {
      const recipientWallet = await recipientWalletAddress(attempt);
      const update = await refreshAttempt(attempt, recipientWallet);
      const diff = Object.fromEntries(Object.entries(update).filter(([key, value]) => value !== undefined && value !== attempt[key]));
      // Only write when something real changed. Routine polls that change nothing do not touch the row.
      if (Object.keys(diff).length > 0 && !Object.keys(diff).every(key => key === 'relay_status_updated_at')) {
        try {
          attempt = (await patchAttempt(paymentId, { ...diff, relay_status_updated_at: new Date().toISOString() })) || await getAttempt(paymentId);
        } catch {
          // A concurrent refresh already moved the receipt. Re-read it and return that state.
          attempt = await getAttempt(paymentId);
        }
      }
    } catch (error) {
      // Relay or Monad is unreachable: keep the last known state. Never guess a new one.
      console.warn('Handoff: payment refresh deferred.', error.code || error.message);
    }
  }
  return publicReceipt(attempt, recipient);
}

module.exports = {
  createPaymentQuote,
  getRouteStatus,
  markAwaitingSignature,
  recordSourceTransaction,
  getPaymentReceipt,
  // Exposed for unit tests.
  refreshAttempt,
  publicQuoteSummary,
  _lastRefreshAt: lastRefreshAt
};
