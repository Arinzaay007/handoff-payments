// Static audits for recipient onboarding, non-custodial boundaries, and exact-output checkout.
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
const profileService = read('src/profileService.js');
const payments = read('src/paymentService.js');
const executionPlan = read('src/executionPlan.js');
const qrClient = read('src/qr-client.js');
const authModal = indexHtml.slice(indexHtml.indexOf('id="authModal"'), indexHtml.indexOf('<div class="toast"'));

test('the recipient browser bundle registers only Dynamic embedded EVM wallet connectors', () => {
  assert.match(bundleSource, /import \{ DynamicWaasEVMConnectors \} from '@dynamic-labs\/waas-evm'/);
  for (const forbidden of [
    'EthereumWalletConnectors', '@dynamic-labs/ethereum', 'MetaMask', 'metamask', 'WalletConnect',
    'walletConnect', 'Coinbase', 'injected', 'FallbackEvmConnector', 'EthereumWalletConnectorsWithConfig',
    '@dynamic-labs/solana', '@dynamic-labs/flow', 'MagicWalletConnectors', 'BloctoEvmWalletConnectors'
  ]) {
    assert.equal(bundleSource.includes(forbidden), false, `bundle must not reference ${forbidden}`);
  }
});

test('recipient onboarding is passkey-first with an email fallback and has no key-export path', () => {
  assert.match(indexHtml, /New here\? Start with your email/);
  assert.match(indexHtml, /Get started securely/);
  assert.match(indexHtml, /Set up your passkey/);
  assert.match(bundleSource, /setShowAuthFlow\(true\)/);
  assert.match(bundleSource, /useRegisterPasskey/, 'Dynamic owns the device passkey enrollment prompt');
  assert.match(bundleSource, /createWalletAccount\(/, 'Dynamic provisions the embedded account after hosted sign-in');

  const productSurface = bundleSource + appJs + indexHtml;
  for (const forbidden of [
    'useEmbeddedReveal', 'initExportProcess', 'exportWalletKey', 'wallet:export', 'wallet.waas.export',
    'LegacyWalletMigrationProvider', 'useLegacyWalletExport', 'openWalletSettings', 'getExportHandler',
    'seedPhrase', 'mnemonic', 'privateKey', 'legacyExportFrame', 'walletAddress', 'copyWallet'
  ]) {
    assert.equal(productSurface.includes(forbidden), false, `${forbidden} must not be exposed in recipient product code`);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'src/walletExport.js')), false, 'the application contains no wallet-export module');
  assert.equal(fs.existsSync(path.join(ROOT, 'test/wallet-export.test.js')), false, 'no export workflow remains to test');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(Boolean(pkg.dependencies['@dynamic-labs/legacy-embedded-wallet-migration']), false, 'legacy export dependency is removed');
});

test('the owner identity UI never renders an address, settings panel, or export control', () => {
  for (const forbidden of ['id="walletAddress"', 'id="copyWallet"', 'id="openWalletSettings"', 'id="exportWalletKey"', 'id="exportKeyModal"']) {
    assert.equal(indexHtml.includes(forbidden), false, `${forbidden} must not be rendered`);
  }
  assert.match(indexHtml, /Your name is how you get paid/);
  assert.match(indexHtml, /Share my payment page/);
});

test('the recipient dashboard keeps blockchain implementation language out of its default shell', () => {
  const recipientShell = indexHtml.slice(indexHtml.indexOf('<div class="app-shell">'), indexHtml.indexOf('<section class="public-page"'));
  for (const infrastructureWord of ['Monad', 'USDC', 'EVM', 'Relay', 'wallet', 'blockchain', 'chain', 'non-custodial']) {
    assert.equal(recipientShell.toLowerCase().includes(infrastructureWord.toLowerCase()), false, `${infrastructureWord} is not recipient-facing dashboard copy`);
  }
  assert.match(recipientShell, /Share your payment page/);
  assert.match(recipientShell, /Available balance/);
  for (const unfinished of ['generateRequest', 'sharePreview', 'requestAmount', 'requestNote', 'requestExpiry']) {
    assert.equal(recipientShell.includes(unfinished), false, `${unfinished} is not a fake recipient request feature`);
  }
});

test('a shared payment page is neutral before the payer intentionally opens checkout', () => {
  const publicLanding = indexHtml.slice(indexHtml.indexOf('<section class="public-page"'), indexHtml.indexOf('<div class="modal-backdrop"'));
  assert.match(publicLanding, /Send a payment to this Handoff name/);
  assert.match(publicLanding, />Make a payment/);
  for (const infrastructureWord of ['Monad', 'USDC', 'EVM', 'Relay', 'wallet', 'network', 'gas', 'chain']) {
    assert.equal(publicLanding.toLowerCase().includes(infrastructureWord.toLowerCase()), false, `${infrastructureWord} is deferred until payer checkout`);
  }
});

test('recipient QR sharing encodes only a canonical payment-page URL locally', () => {
  assert.match(indexHtml, /id="showPaymentQr"/);
  assert.match(indexHtml, /id="paymentQrImage"/);
  assert.match(appJs, /window\.HandoffQr\?\.paymentPageDataUrl/);
  assert.match(appJs, /canonicalPaymentUrl\(username\)/);
  assert.match(qrClient, /import QRCode from 'qrcode'/);
  assert.match(qrClient, /new URL\(paymentPageUrl\)/);
  assert.match(qrClient, /\/\@\[a-z0-9_\]\{3,24\}/i);
  assert.doesNotMatch(qrClient + appJs.slice(appJs.indexOf('function paymentQrUrl'), appJs.indexOf('async function initialiseDynamic')), /requestAmount|requestNote|paymentAmount|note=/i);
});

test('the browser profile response excludes the recipient wallet while the server retains it only for verified portfolio reads', () => {
  assert.match(profileService, /function publicProfileResponse/);
  assert.doesNotMatch(profileService.slice(profileService.indexOf('function publicProfileResponse'), profileService.indexOf('// Server-internal')), /wallet/);
  assert.match(serverJs, /profile: publicProfileResponse\(profile\)/);
  assert.match(serverJs, /getRecipientPortfolio\(profile\)/);
});

test('the server has no endpoint that exports or accepts a key', () => {
  for (const forbidden of ['privateKey', 'importPrivateKey', 'mnemonic', 'seedPhrase', 'exportWalletKey']) {
    assert.equal(serverJs.includes(forbidden), false, `server.js must not reference ${forbidden}`);
  }
  assert.doesNotMatch(serverJs, /\/api\/[a-z0-9/-]*key[a-z0-9-]*/i, 'no API path may deal with keys');
  assert.match(serverJs, /requireDynamicUser\(req\.headers\.authorization\)/, 'the owner endpoints stay authenticated');
});

test('onboarding uses Dynamic hosted auth and no hand-built email, code, passkey, or wallet-address fields', () => {
  assert.match(appJs, /window\.HandoffDynamic\.openAuth\(\)/);
  assert.match(appJs, /window\.HandoffDynamic\.registerPasskey\(\)/, 'passkey enrollment delegates to Dynamic');
  for (const removed of ['authEmail', 'authCode', 'sendEmailCode', 'verifyEmailCode', 'passkeySignIn', 'data-auth-step="email"', 'data-auth-step="code"']) {
    assert.equal(indexHtml.includes(removed) || appJs.includes(removed), false, `${removed} must be removed`);
  }
  assert.equal(/<select/i.test(authModal), false, 'no wallet dropdown in onboarding');
  assert.equal(/claimWallet|walletAddress|wallet-address|recipient wallet/i.test(authModal), false);
  const inputs = [...authModal.matchAll(/<input id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(inputs, ['claimUsername'], 'the only hand-built onboarding input is the @username');
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

test('the payer checkout remains a separate external-wallet flow', () => {
  assert.match(appJs, /window\.ethereum/);
  assert.match(appJs, /function ethereumAccount\(\)/);
  assert.match(appJs, /eth_requestAccounts/);
});

test('merchant checkout requests and verifies Relay exact output, never exact input', () => {
  assert.match(payments, /tradeType: 'EXACT_OUTPUT'/);
  assert.match(payments, /enableTrueExactOutput: true/);
  assert.match(payments, /subsidizeFees: false/);
  assert.doesNotMatch(payments, /tradeType: 'EXACT_INPUT'/);
  assert.match(executionPlan, /requestedDestinationMinor/);
  assert.match(executionPlan, /EXACT_OUTPUT_NOT_GUARANTEED/);
  assert.match(read('src/monadSettlement.js'), /AMOUNT_BELOW_REQUESTED/);
  assert.match(read('src/monadSettlement.js'), /AMOUNT_ABOVE_REQUESTED/);
});

test('Monad settlement is decided on the server, and Relay is never called from the browser', () => {
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
