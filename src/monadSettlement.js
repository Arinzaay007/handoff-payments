// Verifies Monad USDC settlement on-chain before a payment is shown as Settled.
// Relay reporting "success" is necessary but not enough: the Monad receipt must succeed and must
// contain an ERC-20 Transfer of the Monad USDC contract to the server-resolved recipient, for at
// least the minimum output Relay promised at quote time.

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const RPC_TIMEOUT_MS = 10000;

async function rpcCall(rpcUrl, method, params, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };
  let body = null;
  try { body = await response.json(); } catch { return { ok: false }; }
  if (body?.error) return { ok: false };
  return { ok: true, result: body?.result ?? null };
}

function topicAddress(topic) {
  return typeof topic === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic) ? `0x${topic.slice(-40)}`.toLowerCase() : null;
}

/**
 * @returns {Promise<{verified: boolean, reason: string, receivedMinor?: string}>}
 */
async function verifyMonadSettlement({ txHash, recipient, minimumMinor, monadUsdc, monadChainId, rpcUrl, fetchImpl = fetch }) {
  if (!HASH_RE.test(String(txHash || ''))) return { verified: false, reason: 'INVALID_HASH' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(recipient || ''))) return { verified: false, reason: 'INVALID_RECIPIENT' };

  const chain = await rpcCall(rpcUrl, 'eth_chainId', [], fetchImpl);
  if (!chain.ok) return { verified: false, reason: 'RPC_UNAVAILABLE' };
  if (Number.parseInt(String(chain.result), 16) !== monadChainId) return { verified: false, reason: 'WRONG_CHAIN' };

  const receiptCall = await rpcCall(rpcUrl, 'eth_getTransactionReceipt', [txHash], fetchImpl);
  if (!receiptCall.ok) return { verified: false, reason: 'RPC_UNAVAILABLE' };
  const receipt = receiptCall.result;
  if (!receipt) return { verified: false, reason: 'RECEIPT_PENDING' };
  if (receipt.status !== '0x1') return { verified: false, reason: 'TRANSACTION_REVERTED' };

  const wantedRecipient = recipient.toLowerCase();
  const usdc = monadUsdc.toLowerCase();
  let received = 0n;
  for (const log of Array.isArray(receipt.logs) ? receipt.logs : []) {
    if (String(log.address || '').toLowerCase() !== usdc) continue;
    if (!Array.isArray(log.topics) || log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) continue;
    if (topicAddress(log.topics[2]) !== wantedRecipient) continue;
    if (typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(log.data)) continue;
    received += BigInt(log.data);
  }

  if (received === 0n) return { verified: false, reason: 'NO_USDC_TRANSFER_TO_RECIPIENT' };
  if (received < BigInt(minimumMinor)) {
    return { verified: false, reason: 'AMOUNT_BELOW_MINIMUM', receivedMinor: received.toString() };
  }
  return { verified: true, reason: 'VERIFIED', receivedMinor: received.toString() };
}

module.exports = { verifyMonadSettlement, TRANSFER_TOPIC, rpcCall };
