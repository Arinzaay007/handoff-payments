const { request } = require('./supabase');
const { validateHandoffHandle } = require('./identity');

function profileResponse(profile, wallet) {
  if (!profile || !wallet) return null;
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name || profile.username,
    avatarUrl: profile.avatar_url || null,
    wallet: wallet.wallet_address,
    settlement: { chainId: 143, asset: 'USDC' }
  };
}

async function getProfileForSubject(subject) {
  const profiles = await request(
    `profiles?select=id,username,display_name,avatar_url&auth_subject=eq.${encodeURIComponent(subject)}&limit=1`
  );
  const profile = profiles?.[0];
  if (!profile) return null;
  const wallets = await request(
    `recipient_wallets?select=wallet_address,chain_id&profile_id=eq.${encodeURIComponent(profile.id)}&is_active=is.true&chain_id=eq.143&limit=1`
  );
  return profileResponse(profile, wallets?.[0]);
}

async function claimProfile({ subject, username, displayName, walletAddress }) {
  const normalized = validateHandoffHandle(username);
  const rows = await request('rpc/claim_handoff_profile', {
    method: 'POST',
    body: {
      p_auth_subject: subject,
      p_username: normalized,
      p_display_name: displayName || null,
      p_wallet_address: walletAddress
    }
  });
  const row = rows?.[0];
  if (!row) throw new Error('Handoff could not create this profile.');
  return {
    id: row.profile_id,
    username: row.username,
    displayName: row.display_name || row.username,
    avatarUrl: null,
    wallet: row.wallet_address,
    settlement: { chainId: Number(row.chain_id), asset: 'USDC' }
  };
}

module.exports = { getProfileForSubject, claimProfile };
