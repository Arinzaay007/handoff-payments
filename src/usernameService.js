const { request } = require('./supabase');
const { validateHandoffHandle } = require('./identity');

/**
 * Server-internal resolution. The recipient wallet is returned here for the payment service only.
 * It must never be copied into a public response: use resolvePublicRecipient for that.
 *
 * The client supplies only a username. The one active Monad wallet is read from the data model.
 */
async function resolveUsername(input) {
  const username = validateHandoffHandle(input);
  const profiles = await request(
    `profiles?select=id,username,display_name,avatar_url&username_normalized=eq.${encodeURIComponent(username)}&limit=1`
  );
  const profile = profiles?.[0];
  if (!profile) return null;

  const wallets = await request(
    `recipient_wallets?select=id,wallet_address,chain_id&profile_id=eq.${encodeURIComponent(profile.id)}&is_active=is.true&chain_id=eq.143&limit=1`
  );
  const wallet = wallets?.[0];
  if (!wallet) return null;

  return {
    profileId: profile.id,
    walletId: wallet.id,
    username: profile.username,
    displayName: profile.display_name || profile.username,
    avatarUrl: profile.avatar_url || null,
    recipient: wallet.wallet_address,
    settlement: { chainId: 143, asset: 'USDC' }
  };
}

/**
 * Public projection: display-safe fields only. No wallet, no profile ID, no wallet ID.
 */
function toPublicRecipient(resolved) {
  return {
    username: resolved.username,
    displayName: resolved.displayName,
    avatarUrl: resolved.avatarUrl,
    settlement: { chainId: 143, asset: 'USDC' }
  };
}

async function resolvePublicRecipient(input) {
  const resolved = await resolveUsername(input);
  return resolved ? toPublicRecipient(resolved) : null;
}

module.exports = { resolveUsername, resolvePublicRecipient, toPublicRecipient };
