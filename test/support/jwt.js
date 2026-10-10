// Test-only helpers: an RSA key pair and Dynamic-shaped RS256 access tokens.
// The private key exists only in test memory and is never written to the repository.
const crypto = require('crypto');

const ENVIRONMENT_ID = 'env-test-00000000-0000-4000-8000-000000000001';
const KID = 'handoff-test-key-1';

function createTestKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, publicKey, jwks: { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] } };
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signToken({ privateKey, kid = KID, payload, alg = 'RS256' }) {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

const credentials = {
  embeddedEvm: (address, chain = 'EVM') => ({
    id: `embedded-${address.slice(2, 8)}`,
    format: 'blockchain',
    chain,
    address,
    wallet_provider: 'embeddedWallet',
    wallet_name: 'dynamicwaas',
    signin_enabled: true
  }),
  externalEvm: (address) => ({
    id: `external-${address.slice(2, 8)}`,
    format: 'blockchain',
    chain: 'EVM',
    address,
    wallet_provider: 'browserExtension',
    wallet_name: 'metamask'
  }),
  email: (email) => ({ id: 'email-1', format: 'email', email })
};

function basePayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'dynamic-user-test-1',
    iss: `app.dynamicauth.com/${ENVIRONMENT_ID}`,
    environment_id: ENVIRONMENT_ID,
    scope: 'user:basic',
    iat: now,
    exp: now + 600,
    email: 'ada@example.com',
    given_name: 'Ada',
    family_name: 'Lovelace',
    verified_credentials: [
      credentials.email('ada@example.com'),
      credentials.embeddedEvm('0xAbCdEf0123456789aBCdef0123456789AbCdEf01')
    ],
    ...overrides
  };
}

module.exports = { ENVIRONMENT_ID, KID, createTestKeys, signToken, credentials, basePayload };
