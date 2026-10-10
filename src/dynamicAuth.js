const crypto = require('crypto');
const { config } = require('./config');
const { assertEvmAddress } = require('./identity');

const DYNAMIC_JWKS_BASE = 'https://app.dynamicauth.com/api/v0/sdk';
const JWKS_CACHE_MS = 60 * 60 * 1000;
let jwksCache = { keys: [], expiresAt: 0 };

function authError(message, code = 'DYNAMIC_SESSION_INVALID', status = 401) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function decodeBase64Url(segment) {
  return Buffer.from(segment, 'base64url');
}

function parseJwt(token) {
  if (typeof token !== 'string' || token.length > 20000) {
    throw authError('A valid Handoff session is required.');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw authError('A valid Handoff session is required.');
  try {
    return {
      header: JSON.parse(decodeBase64Url(parts[0]).toString('utf8')),
      payload: JSON.parse(decodeBase64Url(parts[1]).toString('utf8')),
      signature: decodeBase64Url(parts[2]),
      signingInput: `${parts[0]}.${parts[1]}`
    };
  } catch {
    throw authError('A valid Handoff session is required.');
  }
}

async function fetchJwks(force = false) {
  if (!force && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  let response;
  const jwksUrl = `${DYNAMIC_JWKS_BASE}/${encodeURIComponent(config.dynamic.environmentId)}/.well-known/jwks`;
  try {
    response = await fetch(jwksUrl, { signal: AbortSignal.timeout(10000) });
  } catch {
    throw authError('Authentication verification is temporarily unavailable.', 'DYNAMIC_AUTH_UNAVAILABLE', 503);
  }
  if (!response.ok) {
    throw authError('Authentication verification is temporarily unavailable.', 'DYNAMIC_AUTH_UNAVAILABLE', 503);
  }
  const body = await response.json();
  if (!Array.isArray(body?.keys)) {
    throw authError('Authentication verification is temporarily unavailable.', 'DYNAMIC_AUTH_UNAVAILABLE', 503);
  }
  jwksCache = { keys: body.keys, expiresAt: Date.now() + JWKS_CACHE_MS };
  return jwksCache.keys;
}

async function signingKey(kid) {
  let keys = await fetchJwks();
  let key = keys.find(item => item.kid === kid);
  if (!key) {
    keys = await fetchJwks(true);
    key = keys.find(item => item.kid === kid);
  }
  if (!key || key.kty !== 'RSA') throw authError('A valid Handoff session is required.');
  try {
    return crypto.createPublicKey({ key, format: 'jwk' });
  } catch {
    throw authError('A valid Handoff session is required.');
  }
}

function bearerToken(value) {
  const matched = String(value || '').match(/^Bearer\s+(.+)$/i);
  return matched?.[1]?.trim() || null;
}

function verifiedEvmWallets(payload) {
  const credentials = Array.isArray(payload.verified_credentials) ? payload.verified_credentials : [];
  return [...new Set(credentials
    .map(credential => credential?.address)
    .filter(address => /^0x[0-9a-fA-F]{40}$/.test(String(address || '')))
    .map(address => String(address).toLowerCase()))];
}

async function requireDynamicUser(authorization) {
  if (!config.dynamic.environmentId) {
    throw authError('Dynamic authentication is not configured for this deployment.', 'DYNAMIC_NOT_CONFIGURED', 503);
  }

  const token = bearerToken(authorization);
  if (!token) throw authError('Sign in to continue.');
  const parsed = parseJwt(token);
  if (parsed.header.alg !== 'RS256' || !parsed.header.kid) {
    throw authError('A valid Handoff session is required.');
  }

  const key = await signingKey(parsed.header.kid);
  const verified = crypto.verify('RSA-SHA256', Buffer.from(parsed.signingInput), key, parsed.signature);
  if (!verified) throw authError('A valid Handoff session is required.');

  const now = Math.floor(Date.now() / 1000);
  if (!parsed.payload.sub || !Number.isFinite(Number(parsed.payload.exp)) || Number(parsed.payload.exp) <= now) {
    throw authError('Your Handoff session has expired. Sign in again.');
  }
  if (parsed.payload.nbf && Number(parsed.payload.nbf) > now + 30) {
    throw authError('Your Handoff session is not active yet.');
  }
  if (parsed.payload.iat && Number(parsed.payload.iat) > now + 300) {
    throw authError('Your Handoff session has an invalid issue time.');
  }
  if (parsed.payload.environment_id !== config.dynamic.environmentId) {
    throw authError('This session belongs to a different Dynamic environment.');
  }
  const environment = config.dynamic.environmentId;
  const allowedIssuers = new Set([
    `app.dynamicauth.com/${environment}`,
    `https://app.dynamicauth.com/${environment}`,
    `app.dynamic.xyz/${environment}`,
    `https://app.dynamic.xyz/${environment}`
  ]);
  if (!allowedIssuers.has(String(parsed.payload.iss || ''))) {
    throw authError('This session has an invalid issuer.');
  }
  const scopes = String(parsed.payload.scope || '').split(/\s+/);
  if (!scopes.includes('user:basic')) {
    throw authError('Complete authentication before continuing.');
  }

  return {
    subject: String(parsed.payload.sub),
    email: typeof parsed.payload.email === 'string' ? parsed.payload.email : null,
    displayName: [parsed.payload.given_name, parsed.payload.family_name].filter(Boolean).join(' ').trim() || parsed.payload.alias || null,
    verifiedWallets: verifiedEvmWallets(parsed.payload)
  };
}

function selectVerifiedWallet(user, requestedAddress) {
  const normalized = requestedAddress ? assertEvmAddress(requestedAddress).toLowerCase() : null;
  if (normalized && user.verifiedWallets.includes(normalized)) return normalized;
  if (!normalized && user.verifiedWallets.length === 1) return user.verifiedWallets[0];
  if (!user.verifiedWallets.length) {
    throw authError('No verified EVM wallet is attached to this Dynamic session. Finish wallet creation, then sign in again.', 'NO_VERIFIED_WALLET', 409);
  }
  throw authError('Select a wallet verified by your Dynamic session.', 'WALLET_NOT_VERIFIED', 403);
}

module.exports = { requireDynamicUser, selectVerifiedWallet };
