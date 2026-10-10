// Server-only read of the real Monad USDC balance for a wallet. This is the on-chain ERC-20
// balanceOf call on the Monad USDC contract after verifying the RPC serves chain ID 143.
//
// The balance is never taken from a database row: a total of recorded payments is NOT a wallet
// balance. When the chain cannot be read (RPC down, wrong chain, malformed response) this module
// reports unavailable and the caller must never substitute a zero.
const { MONAD } = require('./paymentNetworks');
const { rpcCall } = require('./monadSettlement');

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// ERC-20 balanceOf(address) selector.
const BALANCE_OF = '0x70a08231';

function balanceOfData(walletAddress) {
  return `${BALANCE_OF}${walletAddress.slice(2).toLowerCase().padStart(64, '0')}`;
}

/**
 * @returns {Promise<{available: true, balanceMinor: string} | {available: false, reason: string}>}
 */
async function readMonadUsdcBalance({
  walletAddress,
  rpcUrl,
  monadUsdc = MONAD.usdcAddress,
  monadChainId = MONAD.chainId,
  fetchImpl = fetch
}) {
  if (!EVM_ADDRESS_RE.test(String(walletAddress || ''))) {
    return { available: false, reason: 'INVALID_WALLET' };
  }

  // The RPC must be serving Monad (chain 143) before any balance is believed.
  const chain = await rpcCall(rpcUrl, 'eth_chainId', [], fetchImpl);
  if (!chain.ok) return { available: false, reason: 'RPC_UNAVAILABLE' };
  if (Number.parseInt(String(chain.result), 16) !== monadChainId) {
    return { available: false, reason: 'WRONG_CHAIN' };
  }

  const call = await rpcCall(
    rpcUrl,
    'eth_call',
    [{ to: monadUsdc, data: balanceOfData(walletAddress) }, 'latest'],
    fetchImpl
  );
  if (!call.ok) return { available: false, reason: 'RPC_UNAVAILABLE' };
  const raw = String(call.result ?? '');
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(raw)) return { available: false, reason: 'RPC_UNAVAILABLE' };

  return { available: true, balanceMinor: BigInt(raw).toString() };
}

module.exports = { readMonadUsdcBalance, balanceOfData };
