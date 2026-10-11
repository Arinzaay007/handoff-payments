// Loaded with `node --import` before server.js in tests only.
// It answers Dynamic's JWKS request, the Supabase REST calls, and (when configured) the Monad RPC
// from memory, and records every outbound request in HANDOFF_TEST_LOG so tests can prove what the
// server did or did not send.
import fs from 'node:fs';

const logFile = process.env.HANDOFF_TEST_LOG;
const jwks = process.env.HANDOFF_TEST_JWKS;
const environmentId = process.env.DYNAMIC_ENVIRONMENT_ID;
const supabaseUrl = process.env.SUPABASE_URL;
const monadRpcUrl = process.env.HANDOFF_TEST_MONAD_RPC_URL;
const monadRpcMode = process.env.HANDOFF_TEST_MONAD_RPC_MODE || 'ok';
// 0x499602d2 = 1234567890 minor units = 1234.56 USDC. Deliberately different from any fixture
// activity total so tests can prove the balance is the chain read, not a database sum.
const monadBalanceHex = process.env.HANDOFF_TEST_MONAD_BALANCE_HEX || '0x499602d2';

const FIXTURE = {
  morganId: '22222222-2222-4222-8222-222222222222',
  dormantId: '33333333-3333-4333-8333-333333333333',
  morganWallet: '0x7777777777777777777777777777777777777777',
  // Payer addresses are sensitive. They live in these mock rows on purpose: the server must never
  // copy them into any response to the recipient.
  morganPayer: '0x1111111111111111111111111111111111111111'
};

// Unfiltered on purpose: includes pre-submission rows and a foreign-profile row so tests can prove
// the server filters activity in both the query and the code.
function morganAttempts() {
  return [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      recipient_profile_id: FIXTURE.morganId,
      payer_address: FIXTURE.morganPayer,
      status: 'settled',
      source_chain_id: 8453,
      source_amount: '25000000',
      minimum_destination_amount: '24000000',
      final_destination_amount: '24500000',
      source_tx_hash: `0x${'ab'.repeat(32)}`,
      destination_tx_hash: `0x${'cd'.repeat(32)}`,
      failure_code: null,
      created_at: '2026-10-09T10:00:00.000Z',
      updated_at: '2026-10-09T10:05:00.000Z'
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      recipient_profile_id: FIXTURE.morganId,
      payer_address: FIXTURE.morganPayer,
      status: 'routing',
      source_chain_id: 1,
      source_amount: '10000000',
      minimum_destination_amount: '9900000',
      final_destination_amount: null,
      source_tx_hash: `0x${'ef'.repeat(32)}`,
      destination_tx_hash: null,
      failure_code: null,
      created_at: '2026-10-09T09:00:00.000Z',
      updated_at: '2026-10-09T09:01:00.000Z'
    },
    {
      // Before its source transaction: must never appear in the portfolio.
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      recipient_profile_id: FIXTURE.morganId,
      payer_address: FIXTURE.morganPayer,
      status: 'quote_created',
      source_chain_id: 8453,
      source_amount: '25000000',
      minimum_destination_amount: '24000000',
      final_destination_amount: null,
      source_tx_hash: null,
      destination_tx_hash: null,
      failure_code: null,
      created_at: '2026-10-09T11:00:00.000Z',
      updated_at: '2026-10-09T11:00:00.000Z'
    },
    {
      // Waiting for the payer's signature: must never appear in the portfolio.
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      recipient_profile_id: FIXTURE.morganId,
      payer_address: FIXTURE.morganPayer,
      status: 'awaiting_sender',
      source_chain_id: 42161,
      source_amount: '3000000',
      minimum_destination_amount: '2900000',
      final_destination_amount: null,
      source_tx_hash: null,
      destination_tx_hash: null,
      failure_code: null,
      created_at: '2026-10-09T11:30:00.000Z',
      updated_at: '2026-10-09T11:30:00.000Z'
    },
    {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      recipient_profile_id: FIXTURE.morganId,
      payer_address: FIXTURE.morganPayer,
      status: 'transaction_submitted',
      source_chain_id: 137,
      source_amount: '5000000',
      minimum_destination_amount: '4900000',
      final_destination_amount: null,
      source_tx_hash: `0x${'9f'.repeat(32)}`,
      destination_tx_hash: null,
      failure_code: null,
      created_at: '2026-10-09T08:00:00.000Z',
      updated_at: '2026-10-09T08:01:00.000Z'
    },
    {
      // Another profile's attempt. The recipient-profile filter must keep it out of Morgan's view.
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      recipient_profile_id: FIXTURE.dormantId,
      payer_address: FIXTURE.morganPayer,
      status: 'settled',
      source_chain_id: 8453,
      source_amount: '77000000',
      minimum_destination_amount: '76000000',
      final_destination_amount: '76500000',
      source_tx_hash: `0x${'22'.repeat(32)}`,
      destination_tx_hash: `0x${'33'.repeat(32)}`,
      failure_code: null,
      created_at: '2026-10-09T07:00:00.000Z',
      updated_at: '2026-10-09T07:05:00.000Z'
    }
  ];
}

function record(entry) {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === `https://app.dynamicauth.com/api/v0/sdk/${environmentId}/.well-known/jwks`) {
    return json(JSON.parse(jwks));
  }
  if (monadRpcUrl && url.startsWith(monadRpcUrl)) {
    const payload = init.body ? JSON.parse(init.body) : {};
    record({ kind: 'monad-rpc', method: payload.method, params: payload.params });
    if (monadRpcMode === 'unavailable') return json({ message: 'Blocked in tests.' }, 599);
    if (payload.method === 'eth_chainId') {
      // 0x8f = 143 (Monad). 'wrong-chain' answers 0x1 (Ethereum) so tests can prove the balance
      // reader refuses to believe a non-Monad RPC.
      return json({ jsonrpc: '2.0', id: 1, result: monadRpcMode === 'wrong-chain' ? '0x1' : '0x8f' });
    }
    if (payload.method === 'eth_call') {
      return json({ jsonrpc: '2.0', id: 1, result: monadBalanceHex });
    }
    return json({ jsonrpc: '2.0', id: 1, result: null });
  }
  if (supabaseUrl && url.startsWith(`${supabaseUrl}/rest/v1/`)) {
    const path = url.slice(`${supabaseUrl}/rest/v1/`.length);
    const body = init.body ? JSON.parse(init.body) : null;
    record({ kind: 'supabase', path, method: init.method || 'GET', body });
    if (path === 'rpc/claim_handoff_profile') {
      return json([{
        profile_id: '11111111-1111-4111-8111-111111111111',
        username: body.p_username,
        display_name: body.p_display_name,
        wallet_address: body.p_wallet_address,
        chain_id: 143
      }]);
    }
    if ((init.method || 'GET') === 'PATCH' && path.startsWith('profiles?') && path.includes('auth_subject=eq.dynamic-user-test-1')) {
      return json([{
        id: '11111111-1111-4111-8111-111111111111',
        username: 'ada_01',
        display_name: body.display_name,
        avatar_url: null
      }]);
    }
    // Fixture profiles for the public payment page tests. The sensitive fields below exist in the
    // mock rows on purpose: the server must never copy them into any public response.
    if (path.startsWith('profiles?') && path.includes('auth_subject=eq.dynamic-subject-secret-morgan')) {
      return json([{
        id: FIXTURE.morganId, username: 'morgan', display_name: 'Morgan Ellis', avatar_url: null,
        auth_subject: 'dynamic-subject-secret-morgan', email: 'morgan@example.com'
      }]);
    }
    if (path.startsWith('profiles?') && path.includes('auth_subject=eq.dynamic-subject-secret-dormant')) {
      return json([{
        id: FIXTURE.dormantId, username: 'dormant', display_name: 'Dormant Account', avatar_url: null,
        auth_subject: 'dynamic-subject-secret-dormant', email: 'dormant@example.com'
      }]);
    }
    if (path.startsWith('profiles?') && path.includes('username_normalized=eq.morgan')) {
      return json([{
        id: FIXTURE.morganId, username: 'morgan', display_name: 'Morgan Ellis', avatar_url: null,
        auth_subject: 'dynamic-subject-secret-morgan', email: 'morgan@example.com'
      }]);
    }
    if (path.startsWith('profiles?') && path.includes('username_normalized=eq.dormant')) {
      return json([{
        id: FIXTURE.dormantId, username: 'dormant', display_name: 'Dormant Account', avatar_url: null,
        auth_subject: 'dynamic-subject-secret-dormant', email: 'dormant@example.com'
      }]);
    }
    if (path.startsWith('recipient_wallets?') && path.includes(`profile_id=eq.${FIXTURE.morganId}`)) {
      return json([{ wallet_address: FIXTURE.morganWallet, chain_id: 143 }]);
    }
    if (path.startsWith('payment_attempts?') && path.includes(`recipient_profile_id=eq.${FIXTURE.morganId}`)) {
      return json(morganAttempts());
    }
    return json([]);
  }
  record({ kind: 'blocked', url });
  return json({ message: 'Blocked in tests.' }, 599);
};
