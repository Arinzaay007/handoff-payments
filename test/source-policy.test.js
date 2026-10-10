// Static audits: requirements that are about what the code must NOT contain, and what it must keep.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const bundleSource = read('src/dynamic-client.js');
const indexHtml = read('public/index.html');
const appJs = read('public/app.js');
const serverJs = read('server.js');
const dynamicAuth = read('src/dynamicAuth.js');
const authModal = indexHtml.slice(indexHtml.indexOf('id="authModal"'), indexHtml.indexOf('<div class="toast"'));

test('the browser bundle registers only Dynamic embedded EVM wallet connectors', () => {
  assert.match(bundleSource, /import \{ DynamicWaasEVMConnectors \} from '@dynamic-labs\/waas-evm'/);
  for (const forbidden of [
    'EthereumWalletConnectors', '@dynamic-labs/ethereum', 'MetaMask', 'metamask', 'WalletConnect',
    'walletConnect', 'Coinbase', 'injected', 'FallbackEvmConnector', 'EthereumWalletConnectorsWithConfig',
    '@dynamic-labs/solana', '@dynamic-labs/flow', 'MagicWalletConnectors', 'BloctoEvmWalletConnectors'
  ]) {
    assert.equal(bundleSource.includes(forbidden), false, `bundle must not reference ${forbidden}`);
  }
});

test('the browser bundle never exports, imports, or handles private key material', () => {
  for (const forbidden of [
    'exportPrivateKey', 'importPrivateKey', 'exportClientKeyshares', 'exportWalletKey',
    'backupKeyShares', 'privateKey', 'mnemonic', 'seedPhrase'
  ]) {
    assert.equal(bundleSource.includes(forbidden), false, `bundle must not reference ${forbidden}`);
  }
  assert.equal(read('src/dynamicSettings.js').includes('privateKey'), false);
});

test('the bundle exposes only the documented hosted-auth surface', () => {
  const exposed = bundleSource.slice(bundleSource.indexOf('window.HandoffDynamic = {'));
  assert.match(exposed, /initialize,/);
  assert.match(exposed, /openAuth:/);
  assert.match(exposed, /getToken:/);
  assert.match(exposed, /retryWalletSetup:/);
  assert.match(exposed, /signOut:/);
  assert.doesNotMatch(exposed, /sendEmailOTP|verifyOTP|registerPasskey|signInWithPasskey|usePasskey/);
});

test('onboarding uses Dynamic\'s hosted widget and has no hand-built email, code, or passkey fields', () => {
  assert.match(appJs, /window\.HandoffDynamic\.openAuth\(\)/);
  assert.match(bundleSource, /setShowAuthFlow\(true\)/);
  for (const removed of ['authEmail', 'authCode', 'sendEmailCode', 'verifyEmailCode', 'passkeySignIn', 'registerPasskey', 'data-auth-step="email"', 'data-auth-step="code"']) {
    assert.equal(indexHtml.includes(removed) || appJs.includes(removed), false, `${removed} must be removed`);
  }
});

test('the onboarding modal has no recipient wallet field, selector, or wallet-missing copy', () => {
  assert.equal(/<select/i.test(authModal), false, 'no wallet dropdown in onboarding');
  assert.equal(/claimWallet|walletAddress|wallet-address|recipient wallet/i.test(authModal), false);
  assert.equal(/No verified EVM wallet found/.test(indexHtml + appJs), false);
  const inputs = [...authModal.matchAll(/<input id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(inputs, ['claimUsername'], 'the only onboarding input is the @username');
});

test('the app sends only { username } to the claim endpoint', () => {
  assert.match(appJs, /apiFetch\('\/api\/me\/claim', \{ method: 'POST', body: \{ username \} \}\)/);
  const claimFn = appJs.slice(appJs.indexOf('async function claimUsername()'), appJs.indexOf('async function signOut()'));
  assert.equal(/walletAddress|claimWallet|\.address\b|\bwallet\b/.test(claimFn), false, 'claim must not reference a wallet');
  assert.match(claimFn, /body: \{ username \}/);
});

test('the server reads no recipient address from the request body', () => {
  assert.equal(/body\.walletAddress|body\[['"]walletAddress/.test(serverJs), false);
  assert.equal(/selectVerifiedWallet|verifiedWallets/.test(serverJs + dynamicAuth), false);
  assert.match(serverJs, /requireEmbeddedWallet\(user\)/);
});

test('the payer checkout still uses window.ethereum (separate signing flow, preserved)', () => {
  assert.match(appJs, /window\.ethereum/);
  assert.match(appJs, /function ethereumAccount\(\)/);
  assert.match(appJs, /eth_requestAccounts/);
});

test('Monad USDC settlement is decided on the server, and Relay is never called from the browser', () => {
  const payments = read('src/paymentService.js');
  assert.match(payments, /destinationChainId: MONAD\.chainId/);
  assert.match(payments, /destinationCurrency: MONAD\.usdcAddress/);
  assert.match(payments, /includeProtocolData: true/);
  assert.match(read('src/relayClient.js'), /https:\/\/api\.relay\.link/);
  assert.equal(appJs.includes('api.relay.link'), false, 'the browser must not address Relay directly');
  assert.equal(appJs.includes('destinationChainId'), false, 'the browser does not choose the destination');
  assert.match(read('src/paymentNetworks.js'), /chainId: 143/);
});

test('the browser network list is the launch list: eight live EVM networks, Solana and TON not available yet', () => {
  const fallback = appJs.slice(appJs.indexOf('const FALLBACK_SOURCE_NETWORKS = ['), appJs.indexOf('];', appJs.indexOf('const FALLBACK_SOURCE_NETWORKS = [')));
  assert.equal((fallback.match(/status: 'live'/g) || []).length, 8);
  assert.equal((fallback.match(/status: 'not_available'/g) || []).length, 2);
  assert.match(fallback, /key: 'solana'[^}]*status: 'not_available'/);
  assert.match(fallback, /key: 'ton'[^}]*status: 'not_available'/);
  assert.equal(/10 NETWORKS|ten planned|Ten planned/i.test(indexHtml + appJs + read('README.md')), false, 'no ten-network claim anywhere');
});

test('mainnet caps are enforced at launch ceilings and the Supabase server-only boundary is preserved', () => {
  const config = read('src/config.js');
  assert.match(config, /MAX_MAINNET_USDC_MINOR/);
  assert.match(config, /capMinor\(required\('MAX_MAINNET_USDC_MINOR'\), 25_000_000n\)/);
  assert.match(config, /capMinor\(required\('MAX_DAILY_MAINNET_USDC_MINOR'\), 100_000_000n\)/);
  assert.match(config, /publicRuntimeConfig/);
  assert.equal(/serviceRoleKey|SUPABASE_SECRET_KEY|RELAY_API_KEY/.test(config.split('publicRuntimeConfig')[1] || ''), false);
});
