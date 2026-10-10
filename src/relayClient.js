// Server-only Relay API client. The browser never talks to Relay directly and never receives the
// API key. Quote payloads are returned to the browser only after validation in executionPlan.js.
const { config } = require('./config');

const RELAY_BASE_URL = 'https://api.relay.link';
const CHAINS_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
let chainsCache = { expiresAt: 0, chains: null };

function relayError(message, code = 'RELAY_UNAVAILABLE', status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function relayFetch(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  // Relay requires an API key on quote/v2 from 2 October 2026. The key stays on the server.
  if (config.relay.apiKey) headers['x-api-key'] = config.relay.apiKey;

  let response;
  try {
    response = await fetch(`${RELAY_BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw relayError('Relay could not be reached. Try again shortly.');
  }
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json };
}

async function getChains() {
  if (chainsCache.chains && chainsCache.expiresAt > Date.now()) return chainsCache.chains;
  const result = await relayFetch('GET', '/chains');
  const chains = result.json?.chains;
  if (result.status !== 200 || !Array.isArray(chains)) {
    throw relayError('Live routes are unavailable right now. Try again shortly.');
  }
  chainsCache = { chains, expiresAt: Date.now() + CHAINS_TTL_MS };
  return chains;
}

function findChain(chains, chainId) {
  return chains.find(chain => Number(chain.id) === Number(chainId)) || null;
}

// Relay-published contract addresses for a chain. The deposit transaction may only target one of these,
// or the origin USDC contract for an approval. Solver EOAs are deliberately excluded.
function relayContractAddresses(chain) {
  const addresses = new Set();
  const collect = (value) => {
    if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) addresses.add(value.toLowerCase());
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(chain?.contracts);
  collect(chain?.protocol?.v2?.depository);
  collect(chain?.protocol?.v2?.depositoryVault);
  return addresses;
}

function usdcOf(chain) {
  return chain?.erc20Currencies?.find(currency => currency.symbol === 'USDC' && currency.supportsBridging) || null;
}

async function createQuote(params) {
  const result = await relayFetch('POST', '/quote/v2', params);
  if (result.status === 200 && result.json && Array.isArray(result.json.steps)) return result.json;
  if (result.status === 401 || result.status === 403) {
    throw relayError('Live routing is not configured for this deployment yet.', 'RELAY_NOT_CONFIGURED', 503);
  }
  if (result.status === 429) throw relayError('Too many route requests. Try again in a moment.', 'RELAY_RATE_LIMITED', 429);
  // Relay's own message is not forwarded; it can contain request details.
  throw relayError('Relay did not return a route for this payment. Try a different amount or network.', 'RELAY_NO_ROUTE', 422);
}

async function getIntentStatus(requestId) {
  const result = await relayFetch('GET', `/intents/status/v3?requestId=${encodeURIComponent(requestId)}`);
  if (result.status !== 200 || !result.json) {
    throw relayError('Relay status is temporarily unavailable.');
  }
  return result.json;
}

module.exports = {
  RELAY_BASE_URL,
  getChains,
  findChain,
  relayContractAddresses,
  usdcOf,
  createQuote,
  getIntentStatus,
  relayError,
  // Test-only reset for the chains cache.
  _resetChainsCache() { chainsCache = { expiresAt: 0, chains: null }; }
};
