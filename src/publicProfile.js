const { resolveUsername } = require('./usernameService');
const { normaliseHandle } = require('./identity');

const HANDLE_RE = /^[a-z0-9_]{3,24}$/;

/**
 * Public, display-safe profile for a canonical /@username payment page.
 *
 * Returns null unless the handle is a claimed profile with an active Monad recipient wallet.
 * The result is deliberately minimal: username, display name, and settlement metadata only.
 * It never includes the recipient wallet address, the Dynamic subject, an email, a token,
 * or any database identifier. The wallet is checked here but never copied into the output.
 */
async function getPublicProfile(input) {
  const handle = normaliseHandle(input);
  if (!HANDLE_RE.test(handle)) return null;

  const resolved = await resolveUsername(handle);
  if (!resolved) return null;

  return {
    username: resolved.username,
    displayName: resolved.displayName,
    settlement: { chainId: 143, asset: 'USDC' }
  };
}

module.exports = { getPublicProfile };
