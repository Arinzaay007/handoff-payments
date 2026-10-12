// Server-only Monad relayer for one-time USDC EIP-3009 authorizations.
// The relayer key never enters public config, HTTP responses, logs, or browser JavaScript.
const { createWalletClient, defineChain, http, parseSignature } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { MONAD } = require('./paymentNetworks');

const monad = defineChain({
  id: MONAD.chainId,
  name: MONAD.name,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } }
});

const TRANSFER_WITH_AUTHORIZATION_ABI = Object.freeze([{
  type: 'function',
  name: 'transferWithAuthorization',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'v', type: 'uint8' },
    { name: 'r', type: 'bytes32' },
    { name: 's', type: 'bytes32' }
  ],
  outputs: []
}]);

function relayerError(message, code = 'SEND_MONEY_UNAVAILABLE', status = 503) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function hasValidRelayerKey(privateKey) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(privateKey || ''));
}

/**
 * Broadcast exactly the transfer verified in handoffTransferAuth. `authorization` must be the
 * server-rebuilt typed message; this function never accepts browser-provided calldata.
 */
async function relayTransferWithAuthorization({ privateKey, rpcUrl, authorization, signature }) {
  if (!hasValidRelayerKey(privateKey)) {
    throw relayerError('Send money is not available yet. Handoff is preparing the sending fee.', 'SEND_MONEY_UNAVAILABLE');
  }
  if (!rpcUrl) throw relayerError('Send money is temporarily unavailable. Try again shortly.');
  let signatureParts;
  try {
    signatureParts = parseSignature(signature);
  } catch {
    throw relayerError('We could not verify that confirmation. Please start again.', 'AUTHORIZATION_INVALID', 409);
  }
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain: monad,
    transport: http(rpcUrl, { timeout: 15_000 })
  });
  try {
    const txHash = await client.writeContract({
      address: MONAD.usdcAddress,
      abi: TRANSFER_WITH_AUTHORIZATION_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        Number(signatureParts.v),
        signatureParts.r,
        signatureParts.s
      ]
    });
    return { txHash, relayerAddress: account.address };
  } catch (error) {
    // Provider details can include a decoded contract error or relayer-account information. Keep
    // it server-side only; the HTTP boundary presents one stable, non-sensitive message.
    console.error('Handoff relayer could not submit authorization:', error?.shortMessage || error?.name || 'unknown');
    throw relayerError('We could not submit this transfer yet. Please try again shortly.', 'RELAYER_SUBMISSION_FAILED', 503);
  }
}

module.exports = {
  monad,
  TRANSFER_WITH_AUTHORIZATION_ABI,
  hasValidRelayerKey,
  relayTransferWithAuthorization,
  relayerError
};
