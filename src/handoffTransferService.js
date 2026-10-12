// Handoff-to-Handoff payment orchestration. Server-only except for a deliberately limited typed
// message returned for Dynamic to sign. No browser-supplied address, amount, nonce, calldata, or
// transaction hash is accepted as a source of truth.
const { randomUUID } = require('crypto');
const { privateKeyToAccount } = require('viem/accounts');
const { config, handoffTransfersReady } = require('./config');
const { request } = require('./supabase');
const { getProfileForSubject } = require('./profileService');
const { requireEmbeddedWallet } = require('./dynamicAuth');
const { resolveUsername } = require('./usernameService');
const { MONAD } = require('./paymentNetworks');
const { parseUsdcAmount, formatUsdc, dailyCapError } = require('./paymentPolicy');
const {
  AUTHORIZATION_TTL_SECONDS,
  nonceFromUuid,
  typedAuthorization,
  verifyAuthorization,
  isAuthorizationLive
} = require('./handoffTransferAuth');
const { relayTransferWithAuthorization } = require('./handoffRelayer');
const { getRelayerFundingStatus } = require('./handoffRelayerFunding');
const { verifyMonadSettlement, verifyMonadAuthorizationSubmission } = require('./monadSettlement');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const FINAL_STATES = new Set(['settled', 'failed', 'expired']);

function serviceError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

async function getAvailability() {
  if (!handoffTransfersReady()) return { available: false, reason: 'NOT_CONFIGURED' };
  return getRelayerFundingStatus({
    privateKey: config.handoffTransfers.relayerPrivateKey,
    rpcUrl: config.monad.rpcUrl,
    minimumBalanceWei: config.handoffTransfers.minimumBalanceWei
  });
}

async function ensureAvailable() {
  const readiness = await getAvailability();
  if (!readiness.available) {
    // Do not disclose whether this is key setup, a specific relayer address/balance, or an RPC
    // concern. Recipients simply see that the fee-sponsored feature is not ready.
    throw serviceError('Send money is not available yet. Handoff is preparing the sending fee.', 'SEND_MONEY_UNAVAILABLE', 503);
  }
  return readiness;
}

function mapDatabaseError(error) {
  const message = String(error?.message || '');
  if (message === 'DAILY_CAP_EXCEEDED') return dailyCapError(config.limits.maxDailyMainnetUsdcMinor);
  if (message === 'PER_TRANSFER_CAP_EXCEEDED') {
    return serviceError(`A single transfer can be at most ${formatUsdc(config.limits.maxMainnetUsdcMinor)} USDC.`, 'PER_TRANSFER_CAP_EXCEEDED');
  }
  if (message === 'INVALID_RECIPIENT') return serviceError('Choose another active Handoff username.', 'RECIPIENT_INVALID');
  if (error?.details?.code === 'PGRST202' || error?.details?.code === '42883') {
    console.error('Handoff: migration 0005 is not applied (handoff transfer function missing).');
    return serviceError('Send money is temporarily unavailable. Try again shortly.', 'SEND_MONEY_UNAVAILABLE', 503);
  }
  if (error?.details?.code === '23505') return serviceError('This transfer already exists. Start a new one.', 'TRANSFER_CONFLICT', 409);
  return error;
}

async function authenticatedSender(user) {
  const profile = await getProfileForSubject(user.subject);
  if (!profile?.wallet || !profile?.walletId) {
    throw serviceError('Finish setting up your Handoff payment name before sending money.', 'PROFILE_NOT_READY', 409);
  }
  const embeddedWallet = requireEmbeddedWallet(user).toLowerCase();
  if (embeddedWallet !== profile.wallet.toLowerCase()) {
    // The Dynamic credential and the server's claimed-payment profile must agree. This never
    // reaches the browser as an address comparison failure.
    throw serviceError('Your secure account changed. Sign in again before sending money.', 'SENDER_ACCOUNT_MISMATCH', 409);
  }
  return profile;
}

function requireTransferId(transferId) {
  if (!UUID_RE.test(String(transferId || ''))) throw serviceError('Transfer not found.', 'TRANSFER_NOT_FOUND', 404);
  return String(transferId).toLowerCase();
}

async function getTransferForSender(transferId, senderProfileId) {
  const id = requireTransferId(transferId);
  const rows = await request(
    `handoff_transfers?select=*&id=eq.${id}&sender_profile_id=eq.${encodeURIComponent(senderProfileId)}&limit=1`
  );
  const transfer = firstRow(rows);
  if (!transfer) throw serviceError('Transfer not found.', 'TRANSFER_NOT_FOUND', 404);
  return transfer;
}

async function transferRecipient(transfer) {
  const rows = await request(
    `profiles?select=username,display_name&id=eq.${encodeURIComponent(transfer.recipient_profile_id)}&limit=1`
  );
  const profile = firstRow(rows);
  if (!profile) return { username: 'handoff-user', displayName: 'Handoff user' };
  return { username: profile.username, displayName: profile.display_name || profile.username };
}

function publicTransfer(transfer, recipient) {
  const status = transfer.status;
  const final = FINAL_STATES.has(status);
  return {
    transferId: transfer.id,
    status,
    final,
    amount: formatUsdc(transfer.amount),
    asset: 'USDC',
    recipient: { username: recipient.username, displayName: recipient.displayName },
    // Never return signer/recipient account addresses, authorization signatures, database wallet
    // IDs, relayer address, or transaction hash into the recipient-facing experience.
    message: status === 'settled' ? 'Money sent and confirmed.'
      : status === 'submitted' ? 'Your money is on its way. We are confirming it now.'
        : status === 'authorized' ? 'Your confirmation is ready. We are sending it securely.'
          : status === 'expired' ? 'This transfer confirmation expired. Start a new transfer.'
            : status === 'failed' ? 'This transfer could not be completed. Your money was not sent.'
              : 'Ready for your confirmation.'
  };
}

function authorizationFor(transfer) {
  return typedAuthorization({
    from: transfer.sender_wallet_address,
    to: transfer.recipient_wallet_address,
    amountMinor: String(transfer.amount),
    validAfter: Number(transfer.authorization_valid_after),
    validBefore: Number(transfer.authorization_valid_before),
    nonce: transfer.authorization_nonce
  });
}

async function createTransferIntent({ user, recipientHandle, amount }) {
  await ensureAvailable();
  const sender = await authenticatedSender(user);
  if (typeof recipientHandle !== 'string') throw serviceError('Enter a Handoff username.', 'RECIPIENT_INVALID');
  const recipient = await resolveUsername(recipientHandle);
  if (!recipient) throw serviceError('This Handoff username is not active yet.', 'RECIPIENT_NOT_FOUND', 404);
  if (recipient.profileId === sender.id) throw serviceError('Choose another Handoff username.', 'RECIPIENT_INVALID');
  const amountMinor = parseUsdcAmount(amount);
  if (amountMinor > config.limits.maxMainnetUsdcMinor) {
    throw serviceError(`A single transfer can be at most ${formatUsdc(config.limits.maxMainnetUsdcMinor)} USDC.`, 'PER_TRANSFER_CAP_EXCEEDED');
  }

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 30;
  const validBefore = now + AUTHORIZATION_TTL_SECONDS;
  const nonce = nonceFromUuid(randomUUID());
  let transfer;
  try {
    transfer = firstRow(await request('rpc/reserve_handoff_transfer', {
      method: 'POST',
      body: {
        p_sender_profile_id: sender.id,
        p_sender_wallet_id: sender.walletId,
        p_sender_wallet_address: sender.wallet.toLowerCase(),
        p_recipient_profile_id: recipient.profileId,
        p_recipient_wallet_id: recipient.walletId,
        p_recipient_wallet_address: recipient.recipient.toLowerCase(),
        p_amount: amountMinor.toString(),
        p_authorization_nonce: nonce,
        p_valid_after: validAfter,
        p_valid_before: validBefore,
        p_per_transfer_cap: config.limits.maxMainnetUsdcMinor.toString(),
        p_daily_cap: config.limits.maxDailyMainnetUsdcMinor.toString()
      }
    }));
  } catch (error) {
    throw mapDatabaseError(error);
  }
  if (!transfer?.id) throw serviceError('We could not prepare this transfer. Try again.', 'TRANSFER_CONFLICT', 409);
  const authorization = authorizationFor(transfer);
  return {
    ...publicTransfer(transfer, recipient),
    validUntil: new Date(validBefore * 1000).toISOString(),
    // This message is constrained and generated from the just-reserved server record. It is for
    // Dynamic's signTypedData call only; the page never renders its internal account fields.
    authorization
  };
}

async function markExpired(transfer, senderProfileId) {
  try {
    const expired = firstRow(await request('rpc/expire_handoff_transfer', {
      method: 'POST',
      body: { p_transfer_id: transfer.id, p_sender_profile_id: senderProfileId }
    }));
    return expired || transfer;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

async function markSubmission(transfer, senderProfileId, txHash) {
  try {
    const submitted = firstRow(await request('rpc/record_handoff_transfer_submission', {
      method: 'POST',
      body: { p_transfer_id: transfer.id, p_sender_profile_id: senderProfileId, p_tx_hash: txHash }
    }));
    if (!submitted) throw serviceError('This transfer could not be submitted. Start a new one.', 'TRANSFER_STATE_CONFLICT', 409);
    return submitted;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

async function finalizeIfMined(transfer) {
  if (transfer.status !== 'submitted' || !HASH_RE.test(String(transfer.relayer_tx_hash || ''))) return transfer;
  const authorization = authorizationFor(transfer);
  let relayerAddress = null;
  try { relayerAddress = privateKeyToAccount(config.handoffTransfers.relayerPrivateKey).address; } catch { /* A removed key cannot validate completion. */ }
  const submission = await verifyMonadAuthorizationSubmission({
    txHash: transfer.relayer_tx_hash,
    authorization: authorization.message,
    relayerAddress,
    monadUsdc: MONAD.usdcAddress,
    rpcUrl: config.monad.rpcUrl
  });
  if (submission.reason === 'TRANSACTION_PENDING' || submission.reason === 'RPC_UNAVAILABLE') return transfer;
  const verification = submission.verified ? await verifyMonadSettlement({
    txHash: transfer.relayer_tx_hash,
    recipient: transfer.recipient_wallet_address,
    requiredMinor: String(transfer.amount),
    monadUsdc: MONAD.usdcAddress,
    monadChainId: MONAD.chainId,
    rpcUrl: config.monad.rpcUrl
  }) : { verified: false, reason: submission.reason };
  if (verification.verified) {
    try {
      return firstRow(await request('rpc/settle_handoff_transfer', {
        method: 'POST', body: { p_transfer_id: transfer.id, p_tx_hash: transfer.relayer_tx_hash }
      })) || transfer;
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }
  if (verification.reason === 'TRANSACTION_REVERTED' || verification.reason === 'AMOUNT_BELOW_REQUESTED' || verification.reason === 'AMOUNT_ABOVE_REQUESTED' || verification.reason === 'NO_USDC_TRANSFER_TO_RECIPIENT') {
    // A confirmed revert or non-exact receipt must never be shown as a completed transfer.
    try {
      const failed = firstRow(await request(
        `handoff_transfers?id=eq.${transfer.id}&status=eq.submitted`,
        { method: 'PATCH', body: { status: 'failed', failure_code: verification.reason } }
      ));
      return failed || transfer;
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }
  // Pending and temporary RPC failures remain submitted, never settled optimistically.
  return transfer;
}

async function relayAuthorizedTransfer(transfer, senderProfileId) {
  if (transfer.status !== 'authorized') return transfer;
  if (!isAuthorizationLive({ validAfter: transfer.authorization_valid_after, validBefore: transfer.authorization_valid_before })) {
    return markExpired(transfer, senderProfileId);
  }
  const authorization = authorizationFor(transfer);
  // The signature was verified before it was persisted. Re-verify when resuming an authorized
  // intent so an incomplete request cannot cause the relayer to broadcast altered stored data.
  await verifyAuthorization({
    from: authorization.message.from,
    to: authorization.message.to,
    amountMinor: authorization.message.value,
    validAfter: Number(authorization.message.validAfter),
    validBefore: Number(authorization.message.validBefore),
    nonce: authorization.message.nonce,
    signature: transfer.authorization_signature
  });
  const relayed = await relayTransferWithAuthorization({
    privateKey: config.handoffTransfers.relayerPrivateKey,
    rpcUrl: config.monad.rpcUrl,
    authorization: authorization.message,
    signature: transfer.authorization_signature
  });
  const submitted = await markSubmission(transfer, senderProfileId, relayed.txHash);
  return finalizeIfMined(submitted);
}

async function submitTransferAuthorization({ user, transferId, signature }) {
  await ensureAvailable();
  const sender = await authenticatedSender(user);
  let transfer = await getTransferForSender(transferId, sender.id);
  if (transfer.status === 'created') {
    const authorization = authorizationFor(transfer);
    await verifyAuthorization({
      from: authorization.message.from,
      to: authorization.message.to,
      amountMinor: authorization.message.value,
      validAfter: Number(authorization.message.validAfter),
      validBefore: Number(authorization.message.validBefore),
      nonce: authorization.message.nonce,
      signature
    });
    try {
      transfer = firstRow(await request('rpc/record_handoff_transfer_authorization', {
        method: 'POST',
        body: { p_transfer_id: transfer.id, p_sender_profile_id: sender.id, p_signature: String(signature).toLowerCase() }
      }));
    } catch (error) {
      throw mapDatabaseError(error);
    }
    if (!transfer) throw serviceError('This transfer confirmation is no longer available. Start again.', 'TRANSFER_STATE_CONFLICT', 409);
  }
  if (transfer.status === 'authorized') transfer = await relayAuthorizedTransfer(transfer, sender.id);
  else if (transfer.status === 'submitted') transfer = await finalizeIfMined(transfer);
  const recipient = await transferRecipient(transfer);
  return publicTransfer(transfer, recipient);
}

async function getTransferStatus({ user, transferId }) {
  const sender = await authenticatedSender(user);
  let transfer = await getTransferForSender(transferId, sender.id);
  if (transfer.status === 'created' || transfer.status === 'authorized') {
    if (!isAuthorizationLive({ validAfter: transfer.authorization_valid_after, validBefore: transfer.authorization_valid_before })) {
      transfer = await markExpired(transfer, sender.id);
    }
  }
  if (transfer.status === 'submitted') transfer = await finalizeIfMined(transfer);
  const recipient = await transferRecipient(transfer);
  return publicTransfer(transfer, recipient);
}

module.exports = {
  createTransferIntent,
  submitTransferAuthorization,
  getTransferStatus,
  publicTransfer,
  authorizationFor,
  getAvailability,
  ensureAvailable,
  mapDatabaseError
};
