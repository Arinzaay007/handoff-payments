// Receipt states and their public shape. Pure functions, so the rules can be tested without I/O.
const { formatUsdc } = require('./paymentPolicy');
const { SOURCE_NETWORKS, MONAD } = require('./paymentNetworks');

const RECEIPT_ORDER = Object.freeze(['quote_created', 'awaiting_sender', 'transaction_submitted', 'source_confirmed', 'routing', 'settled']);
const RANK = Object.freeze(Object.fromEntries(RECEIPT_ORDER.map((state, index) => [state, index])));
const FINAL_STATES = Object.freeze(new Set(['settled', 'failed', 'refunded']));
const PRE_SUBMISSION_STATES = Object.freeze(new Set(['quote_created', 'awaiting_sender']));

const LABELS = Object.freeze({
  quote_created: 'Quote received',
  awaiting_sender: 'Awaiting payer signature',
  transaction_submitted: 'Transaction submitted',
  source_confirmed: 'Source confirmed',
  routing: 'Routing',
  settled: 'Settled as USDC on Monad',
  failed: 'Failed',
  refunded: 'Refunded to payer'
});

const FAILURE_MESSAGES = Object.freeze({
  RELAY_FAILURE: 'Relay could not complete this route. No settlement was recorded.',
  SOURCE_HASH_UNMATCHED: 'The submitted source transaction does not match this route. No settlement was recorded.',
  QUOTE_EXPIRED: 'This quote expired before the transaction was submitted.',
  SIGNATURE_REJECTED: 'The transaction was not signed in your wallet.',
  SETTLEMENT_NOT_VERIFIED: 'Monad did not verify the exact requested USDC amount. This was not recorded as a completed exact payment.'
});

// Maps Relay's intent status to a receipt state. "success" is intentionally NOT mapped to settled here:
// the server must verify Monad USDC settlement first (see paymentService.refreshAttempt).
function receiptStateForRelayStatus(relayStatus) {
  switch (relayStatus) {
    case 'waiting': return 'transaction_submitted';
    case 'depositing': return 'source_confirmed';
    case 'pending':
    case 'submitted':
    case 'delayed': return 'routing';
    case 'success': return 'settled';
    case 'refund': return 'refunded';
    case 'failure': return 'failed';
    default: return null;
  }
}

function isFinal(state) {
  return FINAL_STATES.has(state);
}

// Returns the state to store. Receipts never move backwards, and final receipts never change.
function nextReceiptState(current, target) {
  if (!target || target === current) return current;
  if (isFinal(current)) return current;
  if (target === 'failed' || target === 'refunded') return target;
  if (RANK[target] === undefined || RANK[current] === undefined) return current;
  return RANK[target] >= RANK[current] ? target : current;
}

function networkByChainId(chainId) {
  return SOURCE_NETWORKS.find(network => network.chainId === Number(chainId)) || null;
}

function displayAmount(value) {
  return value === null || value === undefined ? null : formatUsdc(value);
}

/**
 * Display-safe receipt. Contains NO payer wallet, NO recipient wallet, NO database identifiers other
 * than the payment ID the payer already holds, and no provider error text.
 */
function publicReceipt(attempt, recipient) {
  const network = networkByChainId(attempt.source_chain_id);
  const isFailed = attempt.status === 'failed';
  const failureCode = isFailed ? (attempt.failure_code || 'RELAY_FAILURE') : null;
  const exactOutput = attempt.exact_output === true;
  const requestedDestination = attempt.requested_destination_amount || attempt.minimum_destination_amount;
  const quotedSource = attempt.quoted_source_amount || attempt.source_amount;
  return {
    paymentId: attempt.id,
    status: attempt.status,
    label: LABELS[attempt.status] || 'Pending',
    final: isFinal(attempt.status),
    // The quote lapsed before any source transaction was recorded. The payer must get a new quote.
    quoteExpired: PRE_SUBMISSION_STATES.has(attempt.status) && !attempt.source_tx_hash
      && Date.parse(attempt.quote_expires_at || '') <= Date.now(),
    exactOutput,
    sourceNetwork: network ? { key: network.key, name: network.name } : null,
    // Quoted and confirmed source debits are separate values; the latter remains null until Relay
    // confirms the deposit. Both intentionally exclude the wallet's separately-paid native gas.
    send: {
      quoted: { amount: displayAmount(quotedSource), asset: 'USDC' },
      actual: { amount: displayAmount(attempt.actual_source_amount), asset: 'USDC' },
      routeCost: displayAmount(attempt.quoted_route_fee_amount)
    },
    networkGas: network ? { asset: network.nativeCurrency, paidBy: 'payer' } : null,
    receive: {
      network: MONAD.name,
      asset: MONAD.asset,
      requested: displayAmount(requestedDestination),
      guaranteed: exactOutput,
      amount: attempt.status === 'settled' && attempt.final_destination_amount ? formatUsdc(attempt.final_destination_amount) : null
    },
    recipient: recipient ? { username: recipient.username, displayName: recipient.displayName } : null,
    sourceTxHash: attempt.source_tx_hash || null,
    destinationTxHash: attempt.status === 'settled' ? attempt.destination_tx_hash || null : null,
    settlementVerified: attempt.status === 'settled',
    failure: isFailed ? { code: failureCode, message: FAILURE_MESSAGES[failureCode] || FAILURE_MESSAGES.RELAY_FAILURE } : null,
    expiresAt: attempt.quote_expires_at || null,
    updatedAt: attempt.updated_at || null
  };
}

module.exports = {
  RECEIPT_ORDER,
  LABELS,
  FAILURE_MESSAGES,
  PRE_SUBMISSION_STATES,
  receiptStateForRelayStatus,
  nextReceiptState,
  isFinal,
  networkByChainId,
  publicReceipt
};
