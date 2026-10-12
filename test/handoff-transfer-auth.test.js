const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFunctionData, hashDomain } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  USDC_EIP3009_DOMAIN,
  nonceFromUuid,
  typedAuthorization,
  verifyAuthorization,
  isAuthorizationLive
} = require('../src/handoffTransferAuth');
const { TRANSFER_WITH_AUTHORIZATION_ABI, hasValidRelayerKey } = require('../src/handoffRelayer');
const { verifyMonadAuthorizationSubmission } = require('../src/monadSettlement');

const SENDER_KEY = `0x${'42'.repeat(32)}`;
const recipient = '0x9999999999999999999999999999999999999999';

function authorizationInput() {
  const now = Math.floor(Date.now() / 1000);
  const sender = privateKeyToAccount(SENDER_KEY);
  return {
    from: sender.address,
    to: recipient,
    amountMinor: '1250000',
    validAfter: now - 30,
    validBefore: now + 300,
    nonce: nonceFromUuid('123e4567-e89b-12d3-a456-426614174000')
  };
}

test('a Handoff transfer authorization is a short-lived, Monad-USDC EIP-3009 message', () => {
  const typed = typedAuthorization(authorizationInput());
  // Monad USDC's live DOMAIN_SEPARATOR is for EIP-712 name "USDC", version "2".
  // Signing Circle's more common "USD Coin" domain recovers locally but reverts on Monad.
  assert.equal(USDC_EIP3009_DOMAIN.name, 'USDC');
  assert.equal(USDC_EIP3009_DOMAIN.version, '2');
  assert.deepEqual(typed.domain, USDC_EIP3009_DOMAIN);
  assert.equal(typed.primaryType, 'TransferWithAuthorization');
  assert.equal(typed.message.value, '1250000');
  assert.match(typed.message.nonce, /^0x[0-9a-f]{64}$/);
  assert.equal(isAuthorizationLive(typed.message), true);
  assert.equal(Object.keys(typed.types).join(','), 'TransferWithAuthorization');
});

test('Monad USDC authorization domain matches the deployed contract domain separator', () => {
  // eth_call DOMAIN_SEPARATOR() on Monad USDC, checked 2026-10-12.
  const separator = hashDomain({
    domain: USDC_EIP3009_DOMAIN,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ]
    }
  });
  assert.equal(separator, '0xfe22123edc0dd4aeb912eb7948c5f0e531592c2053b3067612f427db342c93c6');
});

test('the recovered signer must be the authenticated sender, not merely any valid signature', async () => {
  const input = authorizationInput();
  const account = privateKeyToAccount(SENDER_KEY);
  const typed = typedAuthorization(input);
  const signature = await account.signTypedData(typed);
  const verified = await verifyAuthorization({ ...input, signature });
  assert.equal(verified.signer, account.address.toLowerCase());
  await assert.rejects(
    verifyAuthorization({ ...input, from: recipient, signature }),
    error => error.code === 'AUTHORIZATION_MISMATCH'
  );
});

test('the relayer ABI can call only USDC transferWithAuthorization and a key is validated before use', () => {
  assert.equal(TRANSFER_WITH_AUTHORIZATION_ABI.length, 1);
  assert.equal(TRANSFER_WITH_AUTHORIZATION_ABI[0].name, 'transferWithAuthorization');
  assert.equal(TRANSFER_WITH_AUTHORIZATION_ABI[0].inputs.length, 9);
  assert.equal(hasValidRelayerKey(SENDER_KEY), true);
  assert.equal(hasValidRelayerKey('0x1234'), false);
});

test('a submitted relayer transaction is checked against the signed authorization before receipt verification', async () => {
  const input = authorizationInput();
  const account = privateKeyToAccount(SENDER_KEY);
  const typed = typedAuthorization(input);
  const signature = await account.signTypedData(typed);
  const r = `0x${signature.slice(2, 66)}`;
  const s = `0x${signature.slice(66, 130)}`;
  const v = Number.parseInt(signature.slice(130, 132), 16);
  const data = encodeFunctionData({
    abi: TRANSFER_WITH_AUTHORIZATION_ABI,
    functionName: 'transferWithAuthorization',
    args: [typed.message.from, typed.message.to, BigInt(typed.message.value), BigInt(typed.message.validAfter), BigInt(typed.message.validBefore), typed.message.nonce, v, r, s]
  });
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_getTransactionByHash') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
        to: USDC_EIP3009_DOMAIN.verifyingContract,
        from: account.address,
        input: data
      } }));
    }
    throw new Error(`Unexpected RPC ${request.method}`);
  };
  const verified = await verifyMonadAuthorizationSubmission({
    txHash: `0x${'aa'.repeat(32)}`,
    authorization: typed.message,
    relayerAddress: account.address,
    monadUsdc: USDC_EIP3009_DOMAIN.verifyingContract,
    rpcUrl: 'https://rpc.example',
    fetchImpl
  });
  assert.deepEqual(verified, { verified: true, reason: 'VERIFIED' });

  const mismatch = await verifyMonadAuthorizationSubmission({
    txHash: `0x${'aa'.repeat(32)}`,
    authorization: { ...typed.message, value: '1' },
    relayerAddress: account.address,
    monadUsdc: USDC_EIP3009_DOMAIN.verifyingContract,
    rpcUrl: 'https://rpc.example',
    fetchImpl
  });
  assert.equal(mismatch.reason, 'AUTHORIZATION_MISMATCH');
});
