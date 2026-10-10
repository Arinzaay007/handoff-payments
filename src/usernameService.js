const { request } = require('./supabase');
const { validateHandoffHandle } = require('./identity');

/**
 * Public, read-only resolution used by checkout.
 * The client never chooses a recipient address; it supplies a username, and this service
 * resolves the one active Monad wallet from the server-owned data model.
 */
async function resolveUsername(input) {
  const username = validateHandoffHandle(input);
  const profiles = await request(
    `profiles?select=id,username,display_name,avatar_url&username_normalized=eq.${encodeURIComponent(username)}&limit=1`
  );
  const profile = profiles?.[0];
  if (!profile) return null;

  const wallets = await request(
    `recipient_wallets?select=wallet_address,chain_id&profile_id=eq.${encodeURIComponent(profile.id)}&is_active=is.true&chain_id=eq.143&limit=1`
  );
  const wallet = wallets?.[0];
  if (!wallet) return null;

  return {
    username: profile.username,
    displayName: profile.display_name || profile.username,
    avatarUrl: profile.avatar_url || null,
    recipient: wallet.wallet_address,
    settlement: { chainId: 143, asset: 'USDC' }
  };
}

module.exports = { resolveUsername };
