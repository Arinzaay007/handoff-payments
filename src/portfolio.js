// Recipient portfolio for the signed-in owner: the real Monad USDC balance plus verified
// recipient receipt activity. Server-only.
//
// Rules:
//   * The balance is read on-chain (ERC-20 balanceOf on Monad USDC, chain 143). A database total
//     is never presented as a wallet balance. When the chain cannot be read, the balance is
//     reported as "unavailable" with a null amount — never a fake zero.
//   * Activity is scoped strictly to the signed-in recipient profile and shows only attempts
//     whose on-chain source transaction was submitted: quote_created and awaiting_sender records
//     are excluded, both in the query and again in code.
//   * The response carries no payer address, no private key material, and no recipient wallet
//     address. The owner sees their wallet on /api/me; nothing here is public.
const { request } = require('./supabase');
const { config } = require('./config');
const { MONAD } = require('./paymentNetworks');
const { formatUsdc } = require('./paymentPolicy');
const { LABELS, FAILURE_MESSAGES, PRE_SUBMISSION_STATES, isFinal, networkByChainId } = require('./paymentStatus');
const { readMonadUsdcBalance } = require('./monadBalance');

const ACTIVITY_LIMIT = 50;

// Display-safe receipt for the recipient's own dashboard. Deliberately excludes the payer
// address, both wallets, and database identifiers other than the payment ID.
function recipientActivityItem(attempt) {
  const network = networkByChainId(attempt.source_chain_id);
  const isFailed = attempt.status === 'failed';
  const failureCode = isFailed ? (attempt.failure_code || 'RELAY_FAILURE') : null;
  return {
    paymentId: attempt.id,
    status: attempt.status,
    label: LABELS[attempt.status] || 'Pending',
    final: isFinal(attempt.status),
    sourceNetwork: network ? { key: network.key, name: network.name } : null,
    send: { amount: formatUsdc(attempt.source_amount), asset: 'USDC' },
    receive: {
      network: MONAD.name,
      asset: MONAD.asset,
      minimum: attempt.minimum_destination_amount ? formatUsdc(attempt.minimum_destination_amount) : null,
      amount: attempt.status === 'settled' && attempt.final_destination_amount
        ? formatUsdc(attempt.final_destination_amount)
        : null
    },
    sourceTxHash: attempt.source_tx_hash,
    destinationTxHash: attempt.status === 'settled' ? attempt.destination_tx_hash || null : null,
    settlementVerified: attempt.status === 'settled',
    failure: isFailed ? { code: failureCode, message: FAILURE_MESSAGES[failureCode] || FAILURE_MESSAGES.RELAY_FAILURE } : null,
    createdAt: attempt.created_at || null,
    updatedAt: attempt.updated_at || null
  };
}

// Defense in depth: even if a row somehow slipped past the query filters, show it only if it
// belongs to this profile and its on-chain source transaction was submitted. Pre-submission
// records (quote_created, awaiting_sender) are never activity.
function isVisibleRecipientActivity(row, profileId) {
  if (!row || row.recipient_profile_id !== profileId) return false;
  return Boolean(row.source_tx_hash) && !PRE_SUBMISSION_STATES.has(row.status);
}

async function listRecipientActivity(profileId) {
  const rows = await request(
    `payment_attempts?select=id,recipient_profile_id,status,source_chain_id,source_amount,minimum_destination_amount,final_destination_amount,source_tx_hash,destination_tx_hash,failure_code,created_at,updated_at`
    + `&recipient_profile_id=eq.${encodeURIComponent(profileId)}`
    + `&source_tx_hash=not.is.null&status=not.in.(quote_created,awaiting_sender)`
    + `&order=created_at.desc&limit=${ACTIVITY_LIMIT}`
  );
  return (Array.isArray(rows) ? rows : [])
    .filter(row => isVisibleRecipientActivity(row, profileId))
    .map(recipientActivityItem);
}

async function readBalance(walletAddress) {
  const checkedAt = new Date().toISOString();
  try {
    const read = await readMonadUsdcBalance({
      walletAddress,
      rpcUrl: config.monad.rpcUrl,
      monadUsdc: MONAD.usdcAddress,
      monadChainId: MONAD.chainId
    });
    if (!read.available) {
      return {
        asset: MONAD.asset,
        network: MONAD.name,
        chainId: MONAD.chainId,
        status: 'unavailable',
        amount: null,
        checkedAt
      };
    }
    return {
      asset: MONAD.asset,
      network: MONAD.name,
      chainId: MONAD.chainId,
      status: 'available',
      amount: formatUsdc(read.balanceMinor),
      checkedAt
    };
  } catch {
    // Any unexpected failure is still "unavailable". Never guess a balance.
    return {
      asset: MONAD.asset,
      network: MONAD.name,
      chainId: MONAD.chainId,
      status: 'unavailable',
      amount: null,
      checkedAt
    };
  }
}

/**
 * GET /api/me/portfolio — for the signed-in owner only. `profile` is the profile resolved from
 * the verified Dynamic subject (see profileService.getProfileForSubject), so the scope is always
 * the caller's own recipient profile.
 */
async function getRecipientPortfolio(profile) {
  const [balance, activity] = await Promise.all([
    readBalance(profile.wallet),
    listRecipientActivity(profile.id)
  ]);
  return {
    balance,
    activity,
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  getRecipientPortfolio,
  listRecipientActivity,
  recipientActivityItem,
  isVisibleRecipientActivity
};
