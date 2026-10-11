const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDynamicSettings } = require('../src/dynamicSettings');
const { isEmbeddedEvmCredential } = require('../src/dynamicAuth');

const ADDRESS = '0x3333333333333333333333333333333333333333';
const EMBEDDED_EVM = { format: 'blockchain', chain: 'EVM', address: ADDRESS, wallet_provider: 'embeddedWallet' };

test('settings register only the connectors supplied for embedded EVM wallets', () => {
  const embeddedOnly = () => ['embedded-evm-connector'];
  const settings = buildDynamicSettings({ environmentId: 'env-1', connectors: [embeddedOnly] });
  assert.deepEqual(settings.walletConnectors, [embeddedOnly]);
  assert.equal(settings.environmentId, 'env-1');
});

test('settings reject a missing environment or an empty connector list', () => {
  assert.throws(() => buildDynamicSettings({ environmentId: '', connectors: [() => []] }), /environment ID is required/);
  assert.throws(() => buildDynamicSettings({ environmentId: 'env-1', connectors: [] }), /embedded wallet connector/);
});

test('social providers are filtered out in code for recipient onboarding', () => {
  const settings = buildDynamicSettings({ environmentId: 'env-1', connectors: [() => []] });
  assert.deepEqual(settings.socialProvidersFilter(['google', 'apple', 'x', 'discord']), []);
  assert.equal(settings.social, undefined);
});

test('settings use connect-and-sign so Dynamic issues a verified-credential JWT', () => {
  const settings = buildDynamicSettings({ environmentId: 'env-1', connectors: [() => []] });
  assert.equal(settings.initialAuthenticationMode, 'connect-and-sign');
  assert.equal(settings.debugError, false);
});

test('hosted recipient auth is passkey-first with email OTP only as its fallback', () => {
  const settings = buildDynamicSettings({ environmentId: 'env-1', connectors: [() => []] });
  assert.deepEqual(settings.overrides.views, [{
    type: 'login',
    sections: [
      { type: 'passkey' },
      { type: 'separator', label: 'or' },
      { type: 'email' }
    ]
  }]);
});

test('only embedded EVM credentials can name a recipient', () => {
  assert.equal(isEmbeddedEvmCredential(EMBEDDED_EVM), true);
  assert.equal(isEmbeddedEvmCredential({ ...EMBEDDED_EVM, chain: 'eip155' }), true);
  assert.equal(isEmbeddedEvmCredential({ ...EMBEDDED_EVM, format: undefined }), true);
  assert.equal(isEmbeddedEvmCredential({ ...EMBEDDED_EVM, wallet_provider: 'browserExtension' }), false);
  assert.equal(isEmbeddedEvmCredential({ ...EMBEDDED_EVM, wallet_provider: undefined }), false);
  assert.equal(isEmbeddedEvmCredential({ ...EMBEDDED_EVM, chain: 'SOL' }), false);
  assert.equal(isEmbeddedEvmCredential({ ...EMBEDDED_EVM, format: 'email' }), false);
  assert.equal(isEmbeddedEvmCredential({ ...EMBEDDED_EVM, address: 'not-an-address' }), false);
  assert.equal(isEmbeddedEvmCredential({ ...EMBEDDED_EVM, address: undefined }), false);
  assert.equal(isEmbeddedEvmCredential(null), false);
  assert.equal(isEmbeddedEvmCredential('0x'), false);
});
