// Loaded with `node --import` before server.js in tests only.
// It answers Dynamic's JWKS request and the Supabase REST calls from memory, and records every
// outbound request in HANDOFF_TEST_LOG so tests can prove what the server did or did not send.
import fs from 'node:fs';

const logFile = process.env.HANDOFF_TEST_LOG;
const jwks = process.env.HANDOFF_TEST_JWKS;
const environmentId = process.env.DYNAMIC_ENVIRONMENT_ID;
const supabaseUrl = process.env.SUPABASE_URL;
const FIXTURE = {
  morganId: '22222222-2222-4222-8222-222222222222',
  dormantId: '33333333-3333-4333-8333-333333333333',
  morganWallet: '0x7777777777777777777777777777777777777777'
};

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
    // Fixture profiles for the public payment page tests. The sensitive fields below exist in the
    // mock rows on purpose: the server must never copy them into any public response.
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
    return json([]);
  }
  record({ kind: 'blocked', url });
  return json({ message: 'Blocked in tests.' }, 599);
};
