const { request } = require('./supabase');
const { validateHandoffHandle } = require('./identity');

// Browser-safe recipient identity. A Handoff username is the product identity; wallet addresses
// remain server-internal for settlement and balance reads.
function publicProfileResponse(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name || profile.username,
    avatarUrl: profile.avatar_url || null,
    settlement: { chainId: 143, asset: 'USDC' }
  };
}

// Server-internal profile with its verified recipient account. Never return this object directly
// from an HTTP endpoint; use publicProfileResponse() at the boundary.
function profileWithWallet(profile, wallet) {
  if (!profile || !wallet) return null;
  // This is server-internal. HTTP responses must pass through publicProfileResponse() and never
  // expose either the embedded account address or its wallet-row identifier.
  return { ...publicProfileResponse(profile), wallet: wallet.wallet_address, walletId: wallet.id || null };
}

async function getProfileForSubject(subject) {
  const profiles = await request(
    `profiles?select=id,username,display_name,avatar_url&auth_subject=eq.${encodeURIComponent(subject)}&limit=1`
  );
  const profile = profiles?.[0];
  if (!profile) return null;
  const wallets = await request(
    `recipient_wallets?select=id,wallet_address,chain_id&profile_id=eq.${encodeURIComponent(profile.id)}&is_active=is.true&chain_id=eq.143&limit=1`
  );
  return profileWithWallet(profile, wallets?.[0]);
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
    settlement: { chainId: Number(row.chain_id), asset: 'USDC' }
  };
}

// A payment name is permanent; the display name is deliberately separate so a recipient can make
// their shared page recognisable without changing their canonical identity or any payment route.
function validateDisplayName(input) {
  if (typeof input !== 'string') {
    const error = new Error('Enter a display name.');
    error.code = 'INVALID_DISPLAY_NAME';
    error.status = 400;
    throw error;
  }
  if (/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/.test(input)) {
    const error = new Error('Use a single-line display name.');
    error.code = 'INVALID_DISPLAY_NAME';
    error.status = 400;
    throw error;
  }
  const displayName = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!displayName || Array.from(displayName).length > 48) {
    const error = new Error('Display names must be between 1 and 48 characters.');
    error.code = 'INVALID_DISPLAY_NAME';
    error.status = 400;
    throw error;
  }
  return displayName;
}

async function updateProfileDisplayName({ subject, displayName }) {
  const name = validateDisplayName(displayName);
  // Scope the update with the verified Dynamic subject. No browser-supplied profile ID is accepted.
  const rows = await request(
    `profiles?auth_subject=eq.${encodeURIComponent(subject)}&select=id,username,display_name,avatar_url`,
    { method: 'PATCH', body: { display_name: name } }
  );
  const profile = rows?.[0];
  if (!profile) {
    const error = new Error('Claim your Handoff username before editing your profile.');
    error.code = 'PROFILE_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  return publicProfileResponse(profile);
}

module.exports = {
  getProfileForSubject,
  claimProfile,
  publicProfileResponse,
  validateDisplayName,
  updateProfileDisplayName
};
