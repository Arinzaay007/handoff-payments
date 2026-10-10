// Turns a Relay quote into either an executable, validated transaction plan or a quote-preview result.
// Anything that cannot be verified fails closed to "Quote preview only". The browser only ever signs
// steps that pass every check here. Handoff never signs, and never holds a key.
//
// Verification follows Relay's input-validation guide for protocol.v2 quotes:
//   1. Recompute the order ID from orderData with @relay-protocol/settlement-sdk and compare it.
//   2. Check the order's input (origin USDC, amount) and output (Monad USDC, server-resolved recipient,
//      minimumAmount, deadline) against what Handoff asked for.
//   3. Pin the deposit to the canonical depository from GET /chains, and require the deposit call to
//      commit to the verified order ID, the payer, the input token, and the exact input amount.

const { getOrderId } = require('@relay-protocol/settlement-sdk');
const { decodeFunctionData, parseAbi } = require('viem');

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA_RE = /^0x([0-9a-fA-F]{2})*$/;
const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;
const APPROVE_SELECTOR = '0x095ea7b3';
const MAX_CALLDATA_BYTES = 24 * 1024;

// Relay's chain vmType names mapped to the VM identifiers getOrderId expects.
const VM_TYPES = Object.freeze({
  bvm: 'bitcoin-vm',
  evm: 'ethereum-vm',
  hypevm: 'hyperliquid-vm',
  lvm: 'lighter-vm',
  svm: 'solana-vm',
  tonvm: 'ton-vm',
  tvm: 'tron-vm',
  xrpvm: 'xrp-vm'
});

const DEPOSIT_ABI = parseAbi([
  'function depositNative(address depositor, bytes32 id)',
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)'
]);

// Machine-readable reason codes. None contain Relay's raw payload.
const REASONS = Object.freeze({
  NO_STEPS: 'NO_TRANSACTION_STEPS',
  SIGNATURE_STEP: 'SIGNATURE_STEP_UNSUPPORTED',
  MALFORMED: 'MALFORMED_TRANSACTION',
  PROTOCOL_MISSING: 'PROTOCOL_V2_MISSING',
  ORDER_ID_UNVERIFIED: 'ORDER_ID_UNVERIFIED',
  ORDER_ID_MISMATCH: 'ORDER_ID_MISMATCH',
  ORDER_SHAPE: 'ORDER_SHAPE_UNSUPPORTED',
  ORDER_EXPIRED: 'ORDER_EXPIRED',
  CHAIN_MISMATCH: 'CHAIN_MISMATCH',
  FROM_MISMATCH: 'PAYER_MISMATCH',
  NATIVE_VALUE: 'NATIVE_VALUE_UNSUPPORTED',
  TARGET: 'TARGET_NOT_RELAY_CONTRACT',
  APPROVAL_SPENDER: 'APPROVAL_SPENDER_MISMATCH',
  NO_SOURCE_STEP: 'MISSING_SOURCE_STEP',
  DEPOSITORY: 'DEPOSITORY_MISMATCH',
  DEPOSIT_CALL: 'DEPOSIT_CALL_MISMATCH',
  ORIGIN_CURRENCY: 'ORIGIN_CURRENCY_MISMATCH',
  MISSING_MINIMUM: 'MISSING_MINIMUM_OUTPUT',
  DESTINATION: 'DESTINATION_MISMATCH',
  RECIPIENT: 'RECIPIENT_MISMATCH',
  AMOUNT: 'QUOTE_AMOUNT_MISMATCH',
  DESTINATION_CALLS: 'DESTINATION_CALLS_UNSUPPORTED',
  REQUEST_ID: 'MISSING_REQUEST_ID'
});

const PREVIEW_MESSAGE = 'Quote preview only. Relay did not return an executable transaction for this route, so Handoff cannot submit a payment for it.';

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isAddress(value) {
  return typeof value === 'string' && EVM_ADDRESS_RE.test(value);
}

function digits(value) {
  return typeof value === 'string' ? /^\d+$/.test(value) : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// The spender in an ERC-20 approve(address,uint256) call, or null if the calldata is not an approve.
function decodeApproveSpender(data) {
  if (typeof data !== 'string' || data.length !== 2 + 8 + 128) return null;
  if (data.slice(0, 10).toLowerCase() !== APPROVE_SELECTOR) return null;
  const word = data.slice(10, 74);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) return null;
  return `0x${word.slice(24)}`.toLowerCase();
}

function notExecutable(reason, extra = {}) {
  return { executable: false, reason, message: PREVIEW_MESSAGE, steps: [], ...extra };
}

/**
 * Builds the protocol lookups from GET /chains. Always derived from the chain list, never from a quote.
 */
function protocolRegistry(chains) {
  const vmByProtocolId = {};
  const depositoryByProtocolId = {};
  const protocolIdByEvmChain = {};
  for (const chain of Array.isArray(chains) ? chains : []) {
    const v2 = chain?.protocol?.v2;
    if (!v2?.chainId) continue;
    const vm = VM_TYPES[chain.vmType];
    if (!vm) continue;
    vmByProtocolId[v2.chainId] = vm;
    if (typeof v2.depository === 'string') depositoryByProtocolId[v2.chainId] = v2.depository.toLowerCase();
    protocolIdByEvmChain[Number(chain.id)] = v2.chainId;
  }
  return { vmByProtocolId, depositoryByProtocolId, protocolIdByEvmChain };
}

// Verifies the order itself: ID, input, output, recipient, minimum, deadline, and the canonical depository.
function verifyProtocolOrder({ v2, registry, originChainId, originUsdc, monadChainId, monadUsdc, recipient, amountMinor, nowSeconds }) {
  if (!v2 || typeof v2 !== 'object' || !HASH32_RE.test(String(v2.orderId || '')) || !v2.orderData) {
    return { ok: false, reason: REASONS.PROTOCOL_MISSING };
  }

  let computed;
  try {
    computed = getOrderId(v2.orderData, registry.vmByProtocolId);
  } catch {
    return { ok: false, reason: REASONS.ORDER_ID_UNVERIFIED };
  }
  if (lower(computed) !== lower(v2.orderId)) return { ok: false, reason: REASONS.ORDER_ID_MISMATCH };

  const order = v2.orderData;
  const inputs = Array.isArray(order.inputs) ? order.inputs : [];
  if (inputs.length !== 1 || !inputs[0]?.payment) return { ok: false, reason: REASONS.ORDER_SHAPE };
  const payment = inputs[0].payment;

  // Input: the origin chain and origin USDC, for exactly the amount Handoff asked for.
  if (payment.chainId !== registry.protocolIdByEvmChain[originChainId]) return { ok: false, reason: REASONS.CHAIN_MISMATCH };
  if (lower(payment.currency) !== originUsdc) return { ok: false, reason: REASONS.ORIGIN_CURRENCY };
  if (!digits(payment.amount) || BigInt(payment.amount) !== amountMinor) return { ok: false, reason: REASONS.AMOUNT };

  // Output: Monad USDC to the server-resolved recipient, with a minimum we can verify on-chain later.
  const output = order.output || {};
  if (output.chainId !== registry.protocolIdByEvmChain[monadChainId]) return { ok: false, reason: REASONS.DESTINATION };
  const outputs = Array.isArray(output.payments) ? output.payments : [];
  if (outputs.length !== 1) return { ok: false, reason: REASONS.ORDER_SHAPE };
  const out = outputs[0];
  if (lower(out.currency) !== monadUsdc) return { ok: false, reason: REASONS.DESTINATION };
  if (lower(out.recipient) !== lower(recipient)) return { ok: false, reason: REASONS.RECIPIENT };
  if (!digits(out.minimumAmount) || BigInt(out.minimumAmount) <= 0n) return { ok: false, reason: REASONS.MISSING_MINIMUM };
  if (Array.isArray(output.calls) && output.calls.length > 0) return { ok: false, reason: REASONS.DESTINATION_CALLS };
  if (!digits(output.deadline) || Number(output.deadline) <= nowSeconds) return { ok: false, reason: REASONS.ORDER_EXPIRED };

  // The depository comes from GET /chains. The quote's own claim must agree with it.
  const depository = registry.depositoryByProtocolId[payment.chainId];
  if (!depository) return { ok: false, reason: REASONS.DEPOSITORY };
  const claimed = lower(v2.paymentDetails?.depository);
  if (claimed !== depository) return { ok: false, reason: REASONS.DEPOSITORY };
  if (v2.paymentDetails?.amount !== undefined && String(v2.paymentDetails.amount) !== String(payment.amount)) {
    return { ok: false, reason: REASONS.AMOUNT };
  }

  return { ok: true, orderId: computed, depository, payment, minimumAmount: String(out.minimumAmount) };
}

// The deposit call must commit to the verified order: depositor, token, exact amount, and order ID.
function verifyDepositCall({ data, verified, payer }) {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: DEPOSIT_ABI, data });
  } catch {
    return REASONS.DEPOSIT_CALL;
  }
  if (decoded.functionName !== 'depositErc20') return REASONS.DEPOSIT_CALL;
  const [depositor, token, amount, id] = decoded.args;
  if (lower(depositor) !== payer) return REASONS.FROM_MISMATCH;
  if (lower(token) !== lower(verified.payment.currency)) return REASONS.DEPOSIT_CALL;
  if (BigInt(amount) !== BigInt(verified.payment.amount)) return REASONS.AMOUNT;
  if (lower(id) !== lower(verified.orderId)) return REASONS.DEPOSIT_CALL;
  return null;
}

/**
 * @param {object} input
 * @param {object} input.quote          Parsed Relay /quote/v2 response (requested with includeProtocolData).
 * @param {string} input.payer          Payer wallet, lowercase 0x address.
 * @param {number} input.originChainId  EVM chain ID of the source network.
 * @param {string} input.originUsdc     Origin USDC contract (lowercase), from GET /chains.
 * @param {Set<string>} input.allowedTargets  Relay-published contracts on the origin chain (lowercase).
 * @param {Array}  input.chains         Parsed GET /chains response.
 * @param {bigint} input.amountMinor    Requested source amount, six-decimal minor units.
 * @param {string} input.monadUsdc      Monad USDC contract (lowercase).
 * @param {number} input.monadChainId   Monad EVM chain ID (143).
 * @param {string} input.recipient      Server-resolved recipient wallet (lowercase). Never from the payer.
 * @param {number} [input.nowSeconds]
 */
function buildExecutionPlan(input) {
  const { quote, payer, originChainId, originUsdc, allowedTargets, chains, amountMinor, monadUsdc, monadChainId, recipient } = input;
  const nowSeconds = Number.isSafeInteger(input.nowSeconds) ? input.nowSeconds : Math.floor(Date.now() / 1000);

  if (!quote || typeof quote !== 'object' || !HASH32_RE.test(String(quote.requestId || ''))) {
    return notExecutable(REASONS.REQUEST_ID);
  }

  const registry = protocolRegistry(chains);
  const verified = verifyProtocolOrder({
    v2: quote.protocol?.v2,
    registry,
    originChainId,
    originUsdc,
    monadChainId,
    monadUsdc,
    recipient: lower(recipient),
    amountMinor,
    nowSeconds
  });
  if (!verified.ok) return notExecutable(verified.reason);

  // The quote's summary must agree with the signed order. The order's minimum is what settlement enforces.
  const out = quote.details?.currencyOut;
  if (out?.minimumAmount !== undefined && String(out.minimumAmount) !== verified.minimumAmount) {
    return notExecutable(REASONS.MISSING_MINIMUM);
  }
  const currencyIn = quote.details?.currencyIn?.amount;
  if (currencyIn !== undefined && (!digits(currencyIn) || String(currencyIn) !== String(amountMinor))) {
    return notExecutable(REASONS.AMOUNT);
  }

  const steps = Array.isArray(quote.steps) ? quote.steps : [];
  const transactionSteps = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') return notExecutable(REASONS.MALFORMED);
    // Items can be absent or empty, which means nothing to do for that step.
    const items = Array.isArray(step.items) ? step.items : [];
    if (items.length === 0) continue;
    if (step.kind === 'signature') return notExecutable(REASONS.SIGNATURE_STEP);
    if (step.kind !== 'transaction') return notExecutable(REASONS.MALFORMED);
    if (items.length !== 1) return notExecutable(REASONS.MALFORMED);
    if (items[0].status === 'complete') continue;
    transactionSteps.push({ id: String(step.id || ''), data: items[0].data });
  }
  if (transactionSteps.length === 0) return notExecutable(REASONS.NO_STEPS);

  const planned = [];
  for (const { id, data: tx } of transactionSteps) {
    if (!tx || typeof tx !== 'object') return notExecutable(REASONS.MALFORMED);
    if (!isAddress(tx.to) || typeof tx.data !== 'string' || !HEX_DATA_RE.test(tx.data)) {
      return notExecutable(REASONS.MALFORMED);
    }
    if (tx.data.length / 2 - 1 > MAX_CALLDATA_BYTES) return notExecutable(REASONS.MALFORMED);
    // A missing chainId is not trusted: the wallet would otherwise pick its own network.
    if (tx.chainId === undefined || Number(tx.chainId) !== originChainId) return notExecutable(REASONS.CHAIN_MISMATCH);
    if (tx.from !== undefined && lower(tx.from) !== payer) return notExecutable(REASONS.FROM_MISMATCH);
    const value = tx.value === undefined ? '0' : String(tx.value);
    if (!digits(value) || value !== '0') return notExecutable(REASONS.NATIVE_VALUE);

    const approveSpender = decodeApproveSpender(tx.data);
    if (approveSpender) {
      // Approvals must target the origin USDC contract and approve the canonical depository only.
      if (lower(tx.to) !== originUsdc) return notExecutable(REASONS.TARGET);
      if (approveSpender !== verified.depository) return notExecutable(REASONS.APPROVAL_SPENDER);
      planned.push({ role: 'approve', id, to: tx.to, data: tx.data });
    } else {
      // The source (deposit) transaction must pay the canonical depository, from GET /chains.
      if (lower(tx.to) !== verified.depository) return notExecutable(REASONS.DEPOSITORY);
      const mismatch = verifyDepositCall({ data: tx.data, verified, payer });
      if (mismatch) return notExecutable(mismatch);
      if (!allowedTargets.has(lower(tx.to))) return notExecutable(REASONS.TARGET);
      planned.push({ role: 'source', id, to: tx.to, data: tx.data });
    }
  }

  const sources = planned.filter(step => step.role === 'source');
  if (sources.length !== 1) return notExecutable(REASONS.NO_SOURCE_STEP);
  // The deposit must be the last transaction. Approvals come before it.
  if (planned[planned.length - 1].role !== 'source') return notExecutable(REASONS.NO_SOURCE_STEP);

  return {
    executable: true,
    reason: null,
    message: null,
    requestId: quote.requestId,
    orderId: verified.orderId,
    depository: verified.depository,
    steps: planned.map((step, index) => ({
      index,
      role: step.role,
      stepId: step.id,
      chainId: originChainId,
      from: payer,
      to: step.to,
      data: step.data,
      value: '0x0'
    })),
    minimumDestinationMinor: verified.minimumAmount,
    expectedDestinationMinor: digits(out?.amount) ? String(out.amount) : null,
    timeEstimateSeconds: digits(quote.details?.timeEstimate) ? Number(quote.details.timeEstimate) : null
  };
}

module.exports = { buildExecutionPlan, decodeApproveSpender, protocolRegistry, REASONS, PREVIEW_MESSAGE };
