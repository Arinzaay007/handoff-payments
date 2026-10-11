// Single source of truth for payment source networks and the Monad settlement destination.
// The browser receives this list from /api/public-config; it never decides on its own that a
// network is live.

const MONAD = Object.freeze({
  chainId: 143,
  name: 'Monad',
  asset: 'USDC',
  // Circle-issued USDC on Monad mainnet (https://www.circle.com/blog/now-available-usdc-cctp-wallets-and-contracts-on-monad).
  usdcAddress: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
  decimals: 6
});

// status: 'live' networks can create executable Relay payloads at launch.
// status: 'not_available' networks are shown everywhere as "Not available yet" and are rejected by the API.
// nativeCurrency is display-only: the wallet computes and pays its own source-chain gas separately
// from the Relay USDC quote.
const SOURCE_NETWORKS = Object.freeze([
  { key: 'ethereum', name: 'Ethereum', chainId: 1, type: 'evm', nativeCurrency: 'ETH', status: 'live' },
  { key: 'base', name: 'Base', chainId: 8453, type: 'evm', nativeCurrency: 'ETH', status: 'live' },
  { key: 'arbitrum', name: 'Arbitrum', chainId: 42161, type: 'evm', nativeCurrency: 'ETH', status: 'live' },
  { key: 'optimism', name: 'Optimism', chainId: 10, type: 'evm', nativeCurrency: 'ETH', status: 'live' },
  { key: 'polygon', name: 'Polygon', chainId: 137, type: 'evm', nativeCurrency: 'POL', status: 'live' },
  { key: 'bnb', name: 'BNB Chain', chainId: 56, type: 'evm', nativeCurrency: 'BNB', status: 'live' },
  { key: 'avalanche', name: 'Avalanche', chainId: 43114, type: 'evm', nativeCurrency: 'AVAX', status: 'live' },
  { key: 'celo', name: 'Celo', chainId: 42220, type: 'evm', nativeCurrency: 'CELO', status: 'live' },
  { key: 'solana', name: 'Solana', chainId: 792703809, type: 'svm', nativeCurrency: 'SOL', status: 'not_available' },
  { key: 'ton', name: 'TON', chainId: 224235520, type: 'tonvm', nativeCurrency: 'TON', status: 'not_available' }
]);

const LIVE_NETWORKS = Object.freeze(SOURCE_NETWORKS.filter(network => network.status === 'live'));

class NetworkUnavailableError extends Error {
  constructor(network) {
    super(`${network.name} is not available yet.`);
    this.name = 'NetworkUnavailableError';
    this.code = 'NETWORK_NOT_AVAILABLE';
    this.status = 400;
  }
}

function findSourceNetwork(key) {
  return SOURCE_NETWORKS.find(network => network.key === key) || null;
}

// Returns the live network or throws. Unknown keys and not-yet-available networks both fail closed.
function requireLiveSourceNetwork(key) {
  const network = findSourceNetwork(String(key || ''));
  if (!network) {
    const error = new Error('Choose a supported source network.');
    error.code = 'NETWORK_UNKNOWN';
    error.status = 400;
    throw error;
  }
  if (network.status !== 'live') throw new NetworkUnavailableError(network);
  return network;
}

// Public, display-safe description. Contains no secrets and no recipient data.
function publicSourceNetworks() {
  return SOURCE_NETWORKS.map(network => ({
    key: network.key,
    name: network.name,
    chainId: network.chainId,
    type: network.type,
    nativeCurrency: network.nativeCurrency,
    status: network.status
  }));
}

module.exports = {
  MONAD,
  SOURCE_NETWORKS,
  LIVE_NETWORKS,
  findSourceNetwork,
  requireLiveSourceNetwork,
  publicSourceNetworks,
  NetworkUnavailableError
};
