// Loaded with `node --import` before server.js in tests only.
// It answers Dynamic's JWKS request and the Supabase REST calls from memory, and records every
// outbound request in HANDOFF_TEST_LOG so tests can prove what the server did or did not send.
import fs from 'node:fs';

const logFile = process.env.HANDOFF_TEST_LOG;
const jwks = process.env.HANDOFF_TEST_JWKS;
const environmentId = process.env.DYNAMIC_ENVIRONMENT_ID;
const supabaseUrl = process.env.SUPABASE_URL;

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
    return json([]);
  }
  record({ kind: 'blocked', url });
  return json({ message: 'Blocked in tests.' }, 599);
};
