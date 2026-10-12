// Read-only readiness check for the server-only Handoff relayer. A valid key by itself is never
// enough to open fee-sponsored Send money: Monad must also be reachable and the relayer must hold
// the configured minimum MON operating reserve.
const { privateKeyToAccount } = require('viem/accounts');
const { rpcCall } = require('./monadSettlement');
const { MONAD } = require('./paymentNetworks');
const { hasValidRelayerKey } = require('./handoffRelayer');

function hexQuantity(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : null;
}

async function getRelayerFundingStatus({ privateKey, rpcUrl, minimumBalanceWei }) {
  if (!hasValidRelayerKey(privateKey) || !rpcUrl) return { available: false, reason: 'NOT_CONFIGURED' };
  let address;
  try {
    address = privateKeyToAccount(privateKey).address;
  } catch {
    return { available: false, reason: 'NOT_CONFIGURED' };
  }
  const chain = await rpcCall(rpcUrl, 'eth_chainId', []);
  if (!chain.ok || Number.parseInt(String(chain.result), 16) !== MONAD.chainId) return { available: false, reason: 'RPC_UNAVAILABLE' };
  const balance = await rpcCall(rpcUrl, 'eth_getBalance', [address, 'latest']);
  const wei = balance.ok ? hexQuantity(balance.result) : null;
  if (wei === null) return { available: false, reason: 'RPC_UNAVAILABLE' };
  if (wei < BigInt(minimumBalanceWei)) return { available: false, reason: 'INSUFFICIENT_OPERATING_BALANCE' };
  return { available: true, reason: 'READY' };
}

module.exports = { getRelayerFundingStatus, hexQuantity };
