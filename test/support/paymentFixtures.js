// Test-only fixtures: a Relay-shaped quote whose protocol.v2 order is hashed with the real settlement
// SDK, so the verifier under test runs the same checks it would run against Relay's responses.
const { encodeFunctionData, parseAbi } = require('viem');
const { getOrderId } = require('@relay-protocol/settlement-sdk');

const ORIGIN_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MONAD_USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const SOLVER = '0x3333333333333333333333333333333333333333';
const REQUEST_ID = `0x${'cd'.repeat(32)}`;

function chainsFixture() {
  return [
    {
      id: 8453,
      name: 'Base',
      vmType: 'evm',
      erc20Currencies: [{ symbol: 'USDC', address: ORIGIN_USDC, supportsBridging: true, decimals: 6 }],
      contracts: { multicall: '0x5555555555555555555555555555555555555555' },
      solverAddresses: [SOLVER],
      protocol: { v2: { chainId: 'base', depository: DEPOSITORY, depositoryVault: '0x6666666666666666666666666666666666666666' } }
    },
    {
      id: 143,
      name: 'Monad',
      vmType: 'evm',
      erc20Currencies: [{ symbol: 'USDC', address: MONAD_USDC, supportsBridging: true, decimals: 6 }],
      contracts: {},
      protocol: { v2: { chainId: 'monad', depository: '0x7777777777777777777777777777777777777777' } }
    }
  ];
}

/**
 * Builds a quote. Options let tests break exactly one property at a time.
 */
function quoteFixture({
  payer,
  recipient,
  amountMinor = 25_000_000n,
  minimumMinor = 24_000_000n,
  deadline = Math.floor(Date.now() / 1000) + 600,
  withProtocol = true,
  depositRecipient,
  depositTo = DEPOSITORY,
  depositAmount = amountMinor,
  depositId,
  depositor,
  nativeValue = '0',
  approveSpender = DEPOSITORY,
  mutateOrder
} = {}) {
  const orderData = {
    version: 'v1',
    solverChainId: 'monad',
    solver: SOLVER,
    salt: `0x${'ab'.repeat(32)}`,
    inputs: [{ payment: { chainId: 'base', currency: ORIGIN_USDC, amount: amountMinor.toString(), weight: '1' }, refunds: [] }],
    output: {
      chainId: 'monad',
      payments: [{ recipient, currency: MONAD_USDC, minimumAmount: minimumMinor.toString(), expectedAmount: '24500000' }],
      calls: [],
      deadline,
      extraData: '0x'
    },
    fees: []
  };
  if (mutateOrder) mutateOrder(orderData);
  const registry = { base: 'ethereum-vm', monad: 'ethereum-vm' };
  const orderId = getOrderId(orderData, registry);
  const id = depositId || orderId;

  const deposit = encodeFunctionData({
    abi: parseAbi(['function depositErc20(address depositor, address token, uint256 amount, bytes32 id)']),
    functionName: 'depositErc20',
    args: [depositor || payer, ORIGIN_USDC, depositAmount, id]
  });
  const approve = encodeFunctionData({
    abi: parseAbi(['function approve(address spender, uint256 amount)']),
    functionName: 'approve',
    args: [approveSpender, amountMinor]
  });

  const quote = {
    requestId: REQUEST_ID,
    steps: [
      { id: 'approve', action: 'Approve USDC', kind: 'transaction', items: [{ status: 'incomplete', data: { from: payer, to: ORIGIN_USDC, data: approve, value: '0', chainId: 8453 } }] },
      { id: 'deposit', action: 'Deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { from: payer, to: depositTo, data: deposit, value: nativeValue, chainId: 8453 } }] }
    ],
    details: {
      currencyIn: { amount: amountMinor.toString() },
      currencyOut: { amount: '24500000', minimumAmount: minimumMinor.toString() },
      timeEstimate: 45
    }
  };
  if (withProtocol) {
    quote.protocol = {
      v2: {
        orderId,
        orderData,
        orderSignature: `0x${'11'.repeat(65)}`,
        paymentDetails: { chainId: 'base', depository: DEPOSITORY, currency: ORIGIN_USDC, amount: amountMinor.toString() }
      }
    };
  }
  return { quote, orderId, depositRecipient };
}

module.exports = { ORIGIN_USDC, MONAD_USDC, DEPOSITORY, REQUEST_ID, chainsFixture, quoteFixture };
