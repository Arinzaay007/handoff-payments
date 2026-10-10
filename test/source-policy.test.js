// Static audits: requirements that are about what the code must NOT contain, and what it must keep.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const bundleSource = read('src/dynamic-client.js');
const exportSource = read('src/walletExport.js');
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

test('key export is delegated to Dynamic\'s secure reveal and the bundle never handles key material', () => {
  // The owner key export (Identity → Export wallet key) must be Dynamic's own embedded-wallet
  // reveal flow (useEmbeddedReveal → initExportProcess), which renders the key only inside
  // Dynamic's isolated secure iframe. The bundle never imports, receives, persists, or forwards
  // key material itself: it drives the flow and discards the result.
  const exportBundle = bundleSource + exportSource;
  assert.match(bundleSource, /useEmbeddedReveal/);
  assert.match(exportSource, /initExportProcess\(false, false, primaryWallet\.id\)/,
    'private-key reveal targets the existing primary wallet through Dynamic\'s flow');
  assert.match(exportSource, /if \(!primaryWallet\?\.id\)/, 'reveal fails closed without a primary wallet ID');
  for (const forbidden of [
    'importPrivateKey', 'exportClientKeyshares', 'backupKeyShares',
    'mnemonic', 'seedPhrase', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'
  ]) {
    assert.equal(exportBundle.includes(forbidden), false, `bundle must not reference ${forbidden}`);
  }
  // Nothing is sent to a server and nothing is logged: the reveal result is discarded.
  assert.equal(/fetch\(/.test(exportBundle), false, 'the bundle never posts anything anywhere');
  assert.equal(/console\.log/.test(exportBundle), false);
  assert.equal(read('src/dynamicSettings.js').includes('privateKey'), false);
});

test('wallet export authorization (step-up, then MFA) always runs before the reveal', () => {
  const authorize = exportSource.indexOf('await authorizeWalletExport(deps);');
  const reveal = exportSource.indexOf('await initExportProcess(false, false, primaryWallet.id);');
  const legacyReveal = exportSource.indexOf('await deps.revealLegacyWalletKey({');
  assert.ok(authorize > 0, 'runWalletExport authorizes first');
  assert.ok(reveal > authorize && legacyReveal > authorize, 'both reveals come after authorization');
  assert.match(exportSource, /promptStepUpAuth\(\{ requestedScopes: \[WALLET_EXPORT_SCOPE\] \}\)/);
  assert.match(exportSource, /WALLET_EXPORT_SCOPE = 'wallet:export'/);
  assert.match(exportSource, /WALLET_WAAS_EXPORT_MFA_ACTION = 'wallet\.waas\.export'/);
  assert.match(bundleSource, /exportWalletKey: \(\) => runWalletExport\(exportDepsRef\.current\)/);
  assert.equal(/exportWalletKey[^\n]*=>\s*(initExportProcess|revealLegacyWalletKey|deps\.initExportProcess)/.test(bundleSource), false,
    'exportWalletKey never skips straight to a reveal');
});

test('a refused authorization shows the exact denial copy in the dialog and toast', () => {
  assert.match(exportSource, /EXPORT_DENIED_MESSAGE = 'Secure export authorization was denied'/);
  assert.match(appJs, /const EXPORT_DENIED_MESSAGE = 'Secure export authorization was denied'/);
  assert.match(appJs, /error\?\.code === 'EXPORT_AUTHORIZATION_DENIED'/);
});

test('legacy V1/V2 wallets use the official migration package without auto-upgrading or recreating a wallet', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['@dynamic-labs/legacy-embedded-wallet-migration'], 'the official legacy package is a dependency');
  assert.match(bundleSource, /LegacyWalletMigrationProvider, \{ autoOpen: false \}/);
  assert.match(bundleSource, /useLegacyWalletExport/);
  assert.match(exportSource, /isLegacyWallet/);
  // A migration (upgradeToDynamicWaas) creates a new WaaS wallet. Nothing in Handoff may start one.
  for (const [name, source] of [['bundle', bundleSource], ['export module', exportSource], ['app', appJs], ['index', indexHtml]]) {
    assert.equal(/upgradeToDynamicWaas|startUpgrade|LegacyWalletMigrationModal|autoOpen: true/.test(source), false, `${name} must not start a wallet migration`);
  }
  assert.equal(/DYNAMIC_ENVIRONMENT_ID/.test(exportSource + bundleSource), false, 'the environment id stays in config, not the export code');
});

test('Identity opens secure wallet settings only through Dynamic\'s existing-wallet profile', () => {
  assert.match(indexHtml, /id="openWalletSettings">Open secure Dynamic wallet settings<\/button>/);
  assert.match(bundleSource, /openWalletSettings: \(\) => setShowDynamicUserProfile\(true\)/);
  assert.match(appJs, /window\.HandoffDynamic\.openWalletSettings\(\)/);

  const settingsAction = appJs.slice(
    appJs.indexOf('function openWalletSettings()'),
    appJs.indexOf('// Identity → Export wallet key')
  );
  assert.doesNotMatch(settingsAction, /createWallet|upgrade|migrate|replace|primaryWallet|walletAddress|fetch\(/i,
    'opening settings must not create, migrate, replace, select, or send a wallet');
});

test('the bundle exposes only the documented hosted-auth and key-export surface', () => {
  const exposed = bundleSource.slice(bundleSource.indexOf('window.HandoffDynamic = {'));
  assert.match(exposed, /initialize,/);
  assert.match(exposed, /openAuth:/);
  assert.match(exposed, /getToken:/);
  assert.match(exposed, /retryWalletSetup:/);
  assert.match(exposed, /signOut:/);
  assert.match(exposed, /openWalletSettings:/);
  assert.match(exposed, /exportWalletKey:/);
  assert.match(exposed, /clearExportFrame:/);
  assert.doesNotMatch(exposed, /sendEmailOTP|verifyOTP|registerPasskey|signInWithPasskey|usePasskey/);
  // Dynamic's export frame is only ever cleared — never read, captured, or returned.
  assert.match(bundleSource, /getExportHandler\?\.\(\)\?\.clear\?\.\(\)/);
  assert.doesNotMatch(bundleSource, /=\s*[^=\n]*getExportHandler/);
});

test('the server has no endpoint that exports or accepts a key', () => {
  for (const forbidden of ['privateKey', 'importPrivateKey', 'mnemonic', 'seedPhrase', 'exportWalletKey']) {
    assert.equal(serverJs.includes(forbidden), false, `server.js must not reference ${forbidden}`);
  }
  assert.doesNotMatch(serverJs, /\/api\/[a-z0-9/-]*key[a-z0-9-]*/i, 'no API path may deal with keys');
  assert.match(serverJs, /requireDynamicUser\(req\.headers\.authorization\)/, 'the owner endpoints stay authenticated');
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
