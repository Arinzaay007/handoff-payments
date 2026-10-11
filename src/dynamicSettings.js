/**
 * Dynamic SDK settings for Handoff recipient onboarding.
 *
 * Pure module (no browser or React imports) so the policy can be unit-tested in Node.
 *
 * Policy:
 * - Only Dynamic embedded EVM wallet connectors are registered. The caller passes
 *   DynamicWaasEVMConnectors, which excludes injected, WalletConnect, Coinbase,
 *   MetaMask SDK, and fallback EVM connectors.
 * - Social providers are filtered out in code, so no Google/Apple/X/etc. option appears.
 * - The hosted widget uses connect-and-sign, so Dynamic issues a JWT carrying verified
 *   credentials, which the server validates before it derives any recipient.
 * - Phone/SMS/WhatsApp are controlled by the Dynamic dashboard, which must keep them off.
 */

const NO_SOCIAL_PROVIDERS = () => [];

// Dynamic's default login recipe places email before passkey. Supply a narrowly scoped SDK
// view override so recipients see passkey first and can deliberately choose email OTP below it.
// Provider availability remains enforced by the Dynamic environment configuration.
const PASSKEY_FIRST_LOGIN_VIEW = Object.freeze({
  type: 'login',
  sections: Object.freeze([
    Object.freeze({ type: 'passkey' }),
    Object.freeze({ type: 'separator', label: 'or' }),
    Object.freeze({ type: 'email' })
  ])
});

function buildDynamicSettings({ environmentId, connectors }) {
  if (typeof environmentId !== 'string' || !environmentId.trim()) {
    throw new Error('Dynamic environment ID is required.');
  }
  if (!Array.isArray(connectors) || connectors.length === 0) {
    throw new Error('At least one Dynamic embedded wallet connector is required.');
  }
  return {
    environmentId: environmentId.trim(),
    appName: 'Handoff',
    walletConnectors: connectors,
    initialAuthenticationMode: 'connect-and-sign',
    socialProvidersFilter: NO_SOCIAL_PROVIDERS,
    overrides: {
      views: [PASSKEY_FIRST_LOGIN_VIEW]
    },
    logLevel: 'ERROR',
    // Keep Dynamic's own error text out of the UI; the app shows friendly copy instead.
    debugError: false
  };
}

module.exports = { buildDynamicSettings };
