// One-time, short-lived USDC authorization for a Handoff-to-Handoff payment.
//
// This is EIP-3009's transferWithAuthorization message. It is deliberately not an allowance:
// the authorization has one nonce, a short validity window, one sender, one recipient, and one
// exact USDC amount. The browser signs it with the sender's Dynamic embedded account; the server
// recovers and verifies that signer before its separately funded relayer broadcasts it on Monad.
const { recoverTypedDataAddress, isAddress, getAddress } = require('viem');
const { MONAD } = require('./paymentNetworks');

const AUTHORIZATION_TTL_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 30;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

// Monad's deployed USDC contract identifies its EIP-712 domain as "USDC" (not
// Circle's more common "USD Coin" label). The value was read from the live
// contract's name(), version(), and DOMAIN_SEPARATOR() before release. A mismatch
// makes a locally valid signature revert when transferWithAuthorization is relayed.
const USDC_EIP3009_DOMAIN = Object.freeze({
  name: 'USDC',
  version: '2',
  chainId: MONAD.chainId,
  verifyingContract: MONAD.usdcAddress
});

const TRANSFER_WITH_AUTHORIZATION_TYPES = Object.freeze({
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
});

function authError(message, code = 'AUTHORIZATION_INVALID', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function validAddress(value) {
  return typeof value === 'string' && isAddress(value);
}

// crypto.randomUUID() gives 128 random bits. EIP-3009 takes bytes32, so left-pad it to exactly
// 32 bytes rather than inventing a second client-controlled nonce format.
function nonceFromUuid(uuid) {
  const compact = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw authError('Could not prepare this transfer.', 'TRANSFER_PREPARATION_FAILED', 500);
  return `0x${compact.padStart(64, '0')}`;
}

function authorizationMessage({ from, to, amountMinor, validAfter, validBefore, nonce }) {
  if (!validAddress(from) || !validAddress(to)) throw authError('Could not prepare this transfer.', 'TRANSFER_PREPARATION_FAILED', 500);
  if (!/^\d+$/.test(String(amountMinor || '')) || BigInt(amountMinor) <= 0n) throw authError('Enter an amount greater than zero.', 'AMOUNT_INVALID');
  if (!Number.isSafeInteger(Number(validAfter)) || !Number.isSafeInteger(Number(validBefore)) || Number(validBefore) <= Number(validAfter)) {
    throw authError('Could not prepare this transfer.', 'TRANSFER_PREPARATION_FAILED', 500);
  }
  if (!BYTES32_RE.test(String(nonce || ''))) throw authError('Could not prepare this transfer.', 'TRANSFER_PREPARATION_FAILED', 500);
  return {
    from: getAddress(from),
    to: getAddress(to),
    value: BigInt(amountMinor).toString(),
    validAfter: BigInt(validAfter).toString(),
    validBefore: BigInt(validBefore).toString(),
    nonce: String(nonce).toLowerCase()
  };
}

function typedAuthorization(input) {
  return {
    domain: { ...USDC_EIP3009_DOMAIN },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorizationMessage(input)
  };
}

function isAuthorizationLive({ validAfter, validBefore }, nowSeconds = Math.floor(Date.now() / 1000)) {
  return Number(validAfter) < nowSeconds + CLOCK_SKEW_SECONDS && Number(validBefore) > nowSeconds;
}

async function verifyAuthorization({ from, to, amountMinor, validAfter, validBefore, nonce, signature }, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!SIGNATURE_RE.test(String(signature || ''))) throw authError('Confirm the transfer in your secure sign-in to continue.');
  const typedData = typedAuthorization({ from, to, amountMinor, validAfter, validBefore, nonce });
  if (!isAuthorizationLive(typedData.message, nowSeconds)) {
    throw authError('This transfer confirmation has expired. Start again to create a new one.', 'AUTHORIZATION_EXPIRED', 409);
  }
  let recovered;
  try {
    recovered = await recoverTypedDataAddress({ ...typedData, signature });
  } catch {
    throw authError('We could not verify that confirmation. Please start again.', 'AUTHORIZATION_INVALID', 409);
  }
  if (recovered.toLowerCase() !== typedData.message.from.toLowerCase()) {
    throw authError('This confirmation does not match your Handoff account. Please start again.', 'AUTHORIZATION_MISMATCH', 409);
  }
  return { typedData, signer: recovered.toLowerCase(), signature: String(signature).toLowerCase() };
}

module.exports = {
  AUTHORIZATION_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  USDC_EIP3009_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  nonceFromUuid,
  authorizationMessage,
  typedAuthorization,
  isAuthorizationLive,
  verifyAuthorization,
  authError
};
