const state = {
  selectedNetwork: null,
  requestType: 'fixed',
  balanceVisible: true,
  liveChains: null,
  quote: null,
  recipient: null,
  auth: {
    ready: false,
    // True while Dynamic holds a signed-in session for this browser.
    signedIn: false,
    // Set when the visitor chose "Continue with email", so a fresh sign-in opens onboarding.
    awaitingSignIn: false,
    // Incremented to cancel any older provisioning loop.
    flowToken: 0,
    profile: null
  }
};

// Timing is overridable only by tests, through window.HandoffOnboardingTiming.
const ONBOARDING = Object.assign({ pollMs: 2000, timeoutMs: 30000 }, window.HandoffOnboardingTiming || {});
const FRIENDLY_SIGN_IN_UNAVAILABLE = 'Secure sign-in is temporarily unavailable. Please try again shortly.';
const FRIENDLY_SETUP_FAILED = 'We could not finish setting up your account. Try again in a moment.';
const FRIENDLY_NETWORK = 'Handoff could not be reached. Check your connection and try again.';
const WALLET_PENDING_CODES = new Set(['EMBEDDED_WALLET_PENDING', 'EMBEDDED_WALLET_AMBIGUOUS']);

const networks = [
  { id: 1, key: 'ethereum', name: 'Ethereum', short: 'ETH', color: '#dfe7ff', type: 'evm' },
  { id: 8453, key: 'base', name: 'Base', short: 'B', color: '#cee6ff', type: 'evm' },
  { id: 42161, key: 'arbitrum', name: 'Arbitrum', short: 'A', color: '#d9e8ff', type: 'evm' },
  { id: 10, key: 'optimism', name: 'Optimism', short: 'OP', color: '#ffd9dd', type: 'evm' },
  { id: 137, key: 'polygon', name: 'Polygon', short: 'P', color: '#e8ddff', type: 'evm' },
  { id: 56, key: 'bnb', name: 'BNB Chain', short: 'BNB', color: '#fff0b7', type: 'evm' },
  { id: 43114, key: 'avalanche', name: 'Avalanche', short: 'AV', color: '#ffe0df', type: 'evm' },
  { id: 792703809, key: 'solana', name: 'Solana', short: 'S', color: '#dff9e6', type: 'svm' },
  { id: 224235520, key: 'ton', name: 'TON', short: 'T', color: '#d9edff', type: 'tonvm' },
  { id: 42220, key: 'celo', name: 'Celo', short: 'CE', color: '#eaffbd', type: 'evm' }
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const isEvmAddress = value => /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
const shortAddress = value => value && isEvmAddress(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—';
const initial = value => String(value || 'H').trim().charAt(0).toUpperCase() || 'H';

// Canonical public payment page for a username, derived from the origin the page was served from.
function canonicalPaymentUrl(username) {
  return new URL(`/@${username}`, window.location.origin).toString();
}
function makeId() {
  return `HF-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
}
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => el.classList.remove('visible'), 3200);
}
function copyText(text, message = 'Copied to clipboard') {
  if (!text || text === '—') return toast('Complete your Handoff profile first.');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast(message)).catch(() => toast(text));
  else toast(text);
}
function openModal(id) {
  $('#modalBackdrop').classList.add('visible');
  const modal = $(`#${id}`);
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
}
function closeModals() {
  $('#modalBackdrop').classList.remove('visible');
  $$('.modal.visible').forEach(modal => { modal.classList.remove('visible'); modal.setAttribute('aria-hidden', 'true'); });
}
function goTo(page) {
  $$('.page').forEach(el => el.classList.remove('active'));
  $(`#${page}Page`).classList.add('active');
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  const labels = {
    overview: ['OMNICHAIN PAYMENTS', 'One handle. Every chain.'],
    'get-paid': ['PAYMENT REQUESTS', 'Get paid your way'],
    activity: ['PAYMENT HISTORY', 'Clear from source to settlement'],
    identity: ['YOUR PAYMENT IDENTITY', 'Your handle, not your address']
  };
  $('#pageEyebrow').textContent = labels[page][0];
  $('#pageTitle').textContent = labels[page][1];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderActivity() {
  const blank = `<div class="activity-item"><div class="activity-icon in">⌁</div><div class="activity-main"><b>No confirmed payments yet</b><span>New activity appears here after source confirmation and Monad settlement.</span></div></div>`;
  $('#activityList').innerHTML = blank;
  $('#activityFullList').innerHTML = blank;
}
function renderIdentity() {
  const profile = state.auth.profile;
  const handle = profile ? `@${profile.username}` : 'Sign in to claim your @username';
  const name = profile?.displayName || 'Sign in to Handoff';
  const link = profile ? canonicalPaymentUrl(profile.username).replace(/^https?:\/\//, '') : 'A verified Handoff username resolves to Monad USDC.';
  const avatar = initial(profile?.displayName || profile?.username);

  $('#identityHandle').textContent = handle;
  $('#identityLink').textContent = link;
  $('#identityAvatar').textContent = avatar;
  $('#previewName').textContent = name;
  $('#previewHandle').textContent = profile ? handle : 'Claim a Handoff username';
  $('#previewAvatar').textContent = avatar;
  $('#profileName').textContent = name;
  $('#profileHandle').textContent = profile ? `${handle} · Ready to receive on Monad` : 'Your Monad recipient wallet stays under your control.';
  $('#profileAvatar').textContent = avatar;
  $('#walletAddress').textContent = profile ? shortAddress(profile.wallet) : '—';
  $('#profileMiniAvatar').textContent = avatar;
  $('#profileMiniName').textContent = profile ? name : 'Sign in to Handoff';
  $('#profileMiniHandle').textContent = profile ? handle : 'Claim your payment handle';
  $('#authButton').innerHTML = state.auth.signedIn ? 'Sign out <span>↗</span>' : 'Sign in <span>↗</span>';
  $('#balanceAmount').innerHTML = state.balanceVisible && profile ? '—' : '•••';
  $('#balanceSub').innerHTML = profile
    ? '<span class="stable-dot">$</span> Confirmed balance will appear after activity sync <span class="balance-network">on Monad</span>'
    : '<span class="stable-dot">$</span> Sign in to view confirmed USDC <span class="balance-network">on Monad</span>';

  $('#aliasList').innerHTML = profile
    ? `<div class="alias-entry"><div class="alias-platform">@</div><div class="alias-data"><b>Handoff username</b><span>@${profile.username}</span></div><div class="alias-status">✓ Active</div></div>`
    : '<div class="alias-entry"><div class="alias-platform">@</div><div class="alias-data"><b>One canonical username</b><span>Sign in to claim your payment identity.</span></div></div>';
}

function liveChain(chainId) {
  if (!state.liveChains) return null;
  return state.liveChains.find(chain => Number(chain.id) === Number(chainId));
}
function hasUsdc(chain) {
  return chain?.erc20Currencies?.some(currency => currency.symbol === 'USDC' && currency.supportsBridging);
}
function networkAvailable(network) {
  if (!state.liveChains) return true;
  const chain = liveChain(network.id);
  if (!chain) return false;
  if (network.key === 'ton') return chain.currency?.supportsBridging === true;
  return hasUsdc(chain);
}
function renderRails() {
  $('#routesGrid').innerHTML = networks.map(network => `
    <div class="rail ${networkAvailable(network) ? '' : 'unavailable'}" title="${network.name}">
      <span class="rail-icon" style="background:${network.color}">${network.short}</span>
      <span>${network.name}</span>${networkAvailable(network) ? '<i class="route-live"></i>' : ''}
    </div>`).join('');
}
function renderNetworkPicker() {
  $('#networkPicker').innerHTML = networks.map(network => `
    <button class="network-option ${networkAvailable(network) ? '' : 'unavailable'}" data-network="${network.key}" ${networkAvailable(network) ? '' : 'disabled'}>
      <span class="rail-icon" style="background:${network.color}">${network.short}</span>
      <span><b>${network.name}</b><small>${network.type === 'evm' ? 'USDC' : network.key === 'ton' ? 'TON → USDC' : 'USDC / SOL → USDC'}</small></span>
    </button>`).join('');
  $$('.network-option').forEach(button => button.addEventListener('click', () => selectNetwork(button.dataset.network)));
}
async function refreshRoutes(silent = false) {
  const status = $('#routeSyncText');
  status.textContent = 'Syncing routes…';
  try {
    const response = await fetch('/api/relay/chains');
    if (!response.ok) throw new Error('Relay did not respond');
    const data = await response.json();
    state.liveChains = data.chains || [];
    renderRails();
    renderNetworkPicker();
    const available = networks.filter(networkAvailable).length;
    $('#railStatus').textContent = `${available} source networks are live in Relay right now. Final availability is confirmed by a live quote.`;
    status.textContent = `${available}/10 routes checked live`;
    if (!silent) toast(`Live Relay data checked: ${available} routes available.`);
  } catch {
    status.textContent = 'Route check unavailable';
    $('#railStatus').textContent = 'Route status will be checked before payment. Relay must return a valid live quote before anything can be signed.';
    if (!silent) toast('Could not reach Relay. Check again before paying.');
  }
}

function showPayStep(name) {
  $$('.modal-step', $('#payModal')).forEach(step => step.classList.toggle('active', step.dataset.step === name));
}
function showAuthStep(name) {
  $$('.modal-step', $('#authModal')).forEach(step => step.classList.toggle('active', step.dataset.authStep === name));
}
function openPay() {
  state.selectedNetwork = null;
  state.quote = null;
  state.recipient = null;
  $('#payRecipient').value = '';
  renderRecipientProof();
  showPayStep('choose');
  openModal('payModal');
}
function renderRecipientProof(message) {
  const proof = $('#recipientProof');
  const recipient = state.recipient;
  if (recipient) {
    proof.innerHTML = `<span class="avatar gradient-avatar">${initial(recipient.displayName || recipient.username)}</span><span><b>${recipient.displayName || recipient.username} · @${recipient.username}</b><small>Registered Handoff username · receives USDC on Monad</small></span>`;
    return;
  }
  proof.innerHTML = `<span class="avatar gradient-avatar">@</span><span><b>${message || 'Enter a Handoff username'}</b><small>We will resolve its active Monad wallet on the server.</small></span>`;
}
async function resolveRecipient() {
  const handle = $('#payRecipient').value.trim();
  if (!handle) throw new Error('Enter a recipient Handoff username.');
  $('#toNetworks').disabled = true;
  $('#toNetworks').textContent = 'Verifying recipient…';
  try {
    const response = await fetch(`/api/public/resolve?handle=${encodeURIComponent(handle)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Unable to resolve this username.');
    state.recipient = data;
    renderRecipientProof();
    $('#networkLabel').textContent = `PAY @${data.username.toUpperCase()}`;
    return data;
  } catch (error) {
    state.recipient = null;
    renderRecipientProof(error.message);
    throw error;
  } finally {
    $('#toNetworks').disabled = false;
    $('#toNetworks').innerHTML = 'Verify recipient &amp; choose source <span>→</span>';
  }
}
function selectNetwork(key) {
  const network = networks.find(item => item.key === key);
  if (!network || !state.recipient) return;
  state.selectedNetwork = network;
  prepareQuote(network);
  showPayStep('quote');
}
function prepareQuote(network) {
  const amount = Number($('#payAmount').value || 25).toFixed(2);
  $('#quoteSend').textContent = network.key === 'ton' ? `${amount} TON` : `${amount} USDC`;
  $('#quoteSource').textContent = `on ${network.name}`;
  $('#quoteReceive').textContent = '— USDC';
  $('#quoteRoute').textContent = `Relay · ${network.name} → Monad`;
  $('#quoteRecipientName').textContent = `${state.recipient?.displayName || state.recipient?.username || 'Recipient'} receives`;
  $('#quoteRecipientWallet').textContent = shortAddress(state.recipient?.recipient);
  $('#paymentId').textContent = makeId();
  $('#quoteState').textContent = network.type === 'evm'
    ? 'Connect your EVM wallet to request a live mainnet quote. No payment will be sent until you review it.'
    : `${network.name} uses its own wallet adapter. Add the official Relay adapter and a supported wallet connector to execute this route.`;
  $('#getQuote').textContent = network.type === 'evm' ? 'Connect wallet & get live quote ↗' : `Connect ${network.key === 'solana' ? 'Solana wallet' : 'TON wallet'} ↗`;
}
async function ethereumAccount() {
  if (!window.ethereum) throw new Error('No EVM wallet found. Open Handoff in MetaMask, Rabby, or another EVM wallet browser.');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0]) throw new Error('No wallet account selected.');
  return accounts[0];
}
function fromAmount(amount, decimals) {
  const clean = String(amount).trim();
  if (!/^\d+(\.\d{0,6})?$/.test(clean)) throw new Error('Enter a valid payment amount.');
  const [whole, fraction = ''] = clean.split('.');
  return (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals))).toString();
}
async function requestQuote() {
  const network = state.selectedNetwork;
  const recipient = state.recipient;
  if (!network || !recipient?.recipient) return toast('Verify a recipient before requesting a quote.');
  if (network.type !== 'evm') {
    toast(`${network.name} route UI is ready; add the official Relay ${network.key === 'solana' ? 'SVM' : 'TON'} adapter and wallet connector to execute it.`);
    return;
  }
  const button = $('#getQuote');
  button.disabled = true;
  button.textContent = 'Connecting wallet…';
  try {
    const user = await ethereumAccount();
    const origin = liveChain(network.id);
    const destination = liveChain(143);
    if (!origin || !destination) throw new Error('Live Relay chain data is not loaded yet. Refresh payment rails and try again.');
    const originUsdc = origin.erc20Currencies?.find(currency => currency.symbol === 'USDC' && currency.supportsBridging);
    const destinationUsdc = destination.erc20Currencies?.find(currency => currency.symbol === 'USDC' && currency.supportsBridging);
    if (!originUsdc || !destinationUsdc) throw new Error(`USDC routing is unavailable for ${network.name} right now.`);
    button.textContent = 'Getting live quote…';
    const response = await fetch('/api/relay/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        user,
        originChainId: network.id,
        originCurrency: originUsdc.address,
        destinationChainId: 143,
        destinationCurrency: destinationUsdc.address,
        recipientHandle: recipient.username,
        amount: fromAmount($('#payAmount').value || '25', 6),
        tradeType: 'EXACT_INPUT'
      })
    });
    const quote = await response.json();
    if (!response.ok) throw new Error(quote.message || 'Unable to get a route.');
    state.quote = quote;
    const out = quote.details?.currencyOut;
    $('#quoteReceive').textContent = out ? `${Number(out.amountFormatted).toFixed(2)} USDC` : 'Live quote ready';
    $('#quoteState').innerHTML = `<strong>Live quote ready.</strong> ${quote.details?.timeEstimate ? `Estimated route time: ${quote.details.timeEstimate}s.` : ''} Review the final wallet steps before executing. This preview intentionally does not broadcast a mainnet transaction.`;
    button.textContent = 'Live quote ready — review in wallet';
    toast('Live mainnet quote received. No transaction has been sent.');
  } catch (error) {
    $('#quoteState').textContent = error.message;
    toast(error.message);
  } finally {
    button.disabled = false;
    if (!state.quote && button.textContent !== 'Connect wallet & get live quote ↗') button.textContent = 'Connect wallet & get live quote ↗';
  }
}

function updateRequestPreview() {
  const amount = $('#requestAmount').value || '0.00';
  const note = $('#requestNote').value.trim() || 'Payment request';
  $('#previewAmount').innerHTML = `${state.requestType === 'fixed' ? `$${Number(amount || 0).toFixed(2)}` : 'Any amount'} <small>${state.requestType === 'fixed' ? 'USDC' : ''}</small>`;
  $('#previewNote').textContent = note;
  $('#requestAmountLabel').style.opacity = state.requestType === 'fixed' ? '1' : '.45';
  $('#requestAmount').disabled = state.requestType !== 'fixed';
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.HandoffDynamic) return resolve();
    const existing = document.querySelector(`script[data-handoff-sdk="${src}"]`);
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('Unable to load secure sign-in.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.handoffSdk = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Unable to load secure sign-in.'));
    document.head.appendChild(script);
  });
}
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function setAuthStatus(message) {
  $('#authStatus').textContent = message;
}
function showAuthStep(name) {
  $$('.modal-step', $('#authModal')).forEach(step => step.classList.toggle('active', step.dataset.authStep === name));
}

// Every call to /api/me* carries the Dynamic access token. The server verifies it; the browser
// never supplies a recipient wallet. Errors are our own server messages or friendly fallbacks.
async function apiFetch(path, { method = 'GET', body } = {}) {
  const token = window.HandoffDynamic?.getToken?.();
  if (!token) {
    const error = new Error('Sign in to continue.');
    error.status = 401;
    throw error;
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    const error = new Error(FRIENDLY_NETWORK);
    error.status = 0;
    throw error;
  }
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.message || FRIENDLY_SETUP_FAILED);
    error.status = response.status;
    error.code = data.code || null;
    throw error;
  }
  return data;
}

function resetLocalSession() {
  state.auth.flowToken += 1;
  state.auth.signedIn = false;
  state.auth.awaitingSignIn = false;
  state.auth.profile = null;
  renderIdentity();
}

async function expireSession() {
  try { await window.HandoffDynamic?.signOut?.(); } catch { /* Local state still resets below. */ }
  resetLocalSession();
  showAuthStep('start');
  setAuthStatus('Your session ended. Continue with email to sign in again.');
  openModal('authModal');
}

function setProvisioningState({ slow = false, message = '' } = {}) {
  $('#provisioningTitle').textContent = 'Setting up your secure payment account…';
  $('#provisioningText').textContent = slow
    ? 'This is taking longer than usual. Retry setup if it does not finish.'
    : 'This only takes a few seconds.';
  $('#provisioningStatus').textContent = message;
  const retry = $('#retryWalletSetup');
  retry.hidden = !slow && !message;
  retry.disabled = false;
  retry.innerHTML = 'Retry setup <span>↻</span>';
}

function showClaimStep(flow) {
  if (flow !== state.auth.flowToken) return;
  showAuthStep('claim');
  $('#claimStatus').textContent = '';
}

// Polls the server until Dynamic has provisioned one verified embedded EVM wallet.
// Returns a boolean only. The browser never sees an address during onboarding.
async function waitForEmbeddedWallet(flow) {
  const startedAt = Date.now();
  while (flow === state.auth.flowToken) {
    try {
      const status = await apiFetch('/api/me/wallet-status');
      if (status.ready) return showClaimStep(flow);
    } catch (error) {
      if (error.status === 401) return expireSession();
      // Transient failures keep polling until the timeout.
    }
    if (flow !== state.auth.flowToken) return;
    if (Date.now() - startedAt >= ONBOARDING.timeoutMs) {
      return setProvisioningState({ slow: true });
    }
    await delay(ONBOARDING.pollMs);
  }
}

async function resumeOnboarding() {
  const flow = ++state.auth.flowToken;
  showAuthStep('provisioning');
  setProvisioningState();
  openModal('authModal');
  try {
    const data = await apiFetch('/api/me');
    state.auth.profile = data.profile || null;
    renderIdentity();
    if (state.auth.profile) {
      state.auth.awaitingSignIn = false;
      closeModals();
      toast(`Signed in as @${state.auth.profile.username}.`);
      return;
    }
  } catch (error) {
    if (error.status === 401) return expireSession();
    // Fall through: provisioning polling reports problems in friendly terms.
  }
  await waitForEmbeddedWallet(flow);
}

async function retryWalletSetup() {
  const flow = ++state.auth.flowToken;
  setProvisioningState();
  const button = $('#retryWalletSetup');
  button.hidden = true;
  try {
    await window.HandoffDynamic.retryWalletSetup();
  } catch (error) {
    // Raw provider errors stay in the console; the user sees friendly copy only.
    console.warn('Handoff: wallet setup retry failed.', error);
    setProvisioningState({ slow: true, message: FRIENDLY_SETUP_FAILED });
    return;
  }
  await waitForEmbeddedWallet(flow);
}

// Dynamic's hosted widget takes over for email code and passkey. Our modal steps aside.
function continueWithEmail() {
  if (!state.auth.ready || !window.HandoffDynamic) return toast('Secure sign-in is still loading. Try again in a moment.');
  state.auth.awaitingSignIn = true;
  closeModals();
  try {
    window.HandoffDynamic.openAuth();
  } catch (error) {
    console.warn('Handoff: could not open Dynamic sign-in.', error);
    state.auth.awaitingSignIn = false;
    showAuthStep('start');
    setAuthStatus(FRIENDLY_SIGN_IN_UNAVAILABLE);
    openModal('authModal');
  }
}

// Called by the Dynamic bundle whenever its session changes.
async function handleAuthChange({ signedIn }) {
  if (!signedIn) {
    if (state.auth.signedIn) resetLocalSession();
    return;
  }
  state.auth.signedIn = true;
  renderIdentity();
  if (state.auth.awaitingSignIn) {
    state.auth.awaitingSignIn = false;
    return resumeOnboarding();
  }
  // Silent session restore on page load: show the signed-in identity without opening onboarding.
  try {
    const data = await apiFetch('/api/me');
    state.auth.profile = data.profile || null;
    renderIdentity();
  } catch (error) {
    if (error.status === 401) await expireSession();
  }
}

// /@username: a payer-facing page for one recipient. The recipient is the server-injected handle;
// the payment flow below resolves that handle's wallet on the server, exactly as before.
function openPublicPay() {
  const handle = document.body.dataset.publicHandle;
  openPay();
  $('#payRecipient').value = `@${handle}`;
}

async function initPublicPage(handle) {
  document.body.classList.add('public-mode');
  $('#publicHandle').textContent = `@${handle}`;
  $('#publicAvatar').textContent = initial(handle);
  $('#publicPayButton').addEventListener('click', openPublicPay);
  try {
    const response = await fetch(`/api/public/profile?handle=${encodeURIComponent(handle)}`);
    if (!response.ok) return;
    const profile = await response.json();
    if (profile.displayName) {
      $('#publicName').textContent = profile.displayName;
      $('#publicAvatar').textContent = initial(profile.displayName);
    }
  } catch {
    // The handle and the Pay button still work with the server-verified handle alone.
  }
}

function openAuthFlow() {
  if (state.auth.profile) return goTo('identity');
  if (state.auth.signedIn) return resumeOnboarding();
  showAuthStep('start');
  openModal('authModal');
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.HandoffDynamic) return resolve();
    const existing = document.querySelector(`script[data-handoff-sdk="${src}"]`);
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('Unable to load secure sign-in.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.handoffSdk = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Unable to load secure sign-in.'));
    document.head.appendChild(script);
  });
}

async function initialiseDynamic() {
  try {
    const response = await fetch('/api/public-config');
    if (!response.ok) throw new Error('Unable to load public sign-in configuration.');
    const runtime = await response.json();
    if (!runtime.dynamic?.enabled) {
      setAuthStatus('Secure sign-in is not configured for this deployment yet.');
      return;
    }
    await loadScript('/dynamic-client.js');
    await window.HandoffDynamic.initialize({
      environmentId: runtime.dynamic.environmentId,
      onChange: handleAuthChange
    });
    state.auth.ready = true;
  } catch (error) {
    console.warn('Dynamic initialization unavailable:', error);
    setAuthStatus(FRIENDLY_SIGN_IN_UNAVAILABLE);
  }
}

async function claimUsername() {
  const username = $('#claimUsername').value.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return toast('Use 3–24 lowercase letters, numbers, or underscores.');
  const button = $('#claimUsernameButton');
  button.disabled = true;
  button.textContent = 'Claiming…';
  try {
    // Only the username is sent. The server derives the recipient from the verified session.
    const data = await apiFetch('/api/me/claim', { method: 'POST', body: { username } });
    state.auth.profile = data.profile;
    renderIdentity();
    closeModals();
    toast(`@${data.profile.username} is ready to receive USDC on Monad.`);
  } catch (error) {
    if (error.status === 401) return expireSession();
    if (WALLET_PENDING_CODES.has(error.code)) {
      showAuthStep('provisioning');
      setProvisioningState({ slow: true, message: error.message });
    } else {
      $('#claimStatus').textContent = error.message;
      toast(error.message);
    }
  } finally {
    button.disabled = false;
    button.innerHTML = 'Claim username <span>→</span>';
  }
}

async function signOut() {
  try {
    await window.HandoffDynamic?.signOut?.();
  } catch { /* Local UI is still reset. */ }
  resetLocalSession();
  toast('Signed out of Handoff.');
}

function bindEvents() {
  $$('.nav-item').forEach(item => item.addEventListener('click', () => goTo(item.dataset.page)));
  $$('[data-go]').forEach(item => item.addEventListener('click', () => goTo(item.dataset.go)));
  $('#quickRequest').addEventListener('click', () => state.auth.profile ? goTo('get-paid') : openAuthFlow());
  $('#requestFromBalance').addEventListener('click', () => state.auth.profile ? goTo('get-paid') : openAuthFlow());
  $('#createRequest').addEventListener('click', () => state.auth.profile ? goTo('get-paid') : openAuthFlow());
  $('#sendFromBalance').addEventListener('click', openPay);
  $('#openIdentity').addEventListener('click', () => state.auth.profile ? goTo('identity') : openAuthFlow());
  $('#routeRefresh').addEventListener('click', () => refreshRoutes());
  $('#toggleBalance').addEventListener('click', () => { state.balanceVisible = !state.balanceVisible; renderIdentity(); });
  $('#copyHandle').addEventListener('click', () => state.auth.profile ? copyText(`@${state.auth.profile.username}`, 'Handoff username copied') : openAuthFlow());
  $('#copyPublicLink').addEventListener('click', () => state.auth.profile ? copyText(canonicalPaymentUrl(state.auth.profile.username), 'Payment page copied') : openAuthFlow());
  $('#copyWallet').addEventListener('click', () => state.auth.profile ? copyText(state.auth.profile.wallet, 'Monad recipient wallet copied') : openAuthFlow());
  $('#shareProfile').addEventListener('click', () => state.auth.profile ? copyText(canonicalPaymentUrl(state.auth.profile.username), 'Payment page copied') : openAuthFlow());
  $('#profileButton').addEventListener('click', () => state.auth.profile ? goTo('identity') : openAuthFlow());
  $('#authButton').addEventListener('click', () => state.auth.signedIn ? signOut() : openAuthFlow());
  $('#openSecurity').addEventListener('click', () => toast('Handoff is non-custodial: Relay routes directly to a verified Monad recipient wallet.'));
  $('#openNotifications').addEventListener('click', () => toast('Settlement and request updates appear after they are stored server-side.'));
  $('#mobileMenu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
  $('#modalBackdrop').addEventListener('click', closeModals);
  $$('[data-close]').forEach(button => button.addEventListener('click', closeModals));
  $('#toNetworks').addEventListener('click', async () => {
    try { await resolveRecipient(); renderNetworkPicker(); showPayStep('network'); }
    catch (error) { toast(error.message); }
  });
  $('#backToChoose').addEventListener('click', () => showPayStep('choose'));
  $('#backToNetworks').addEventListener('click', () => showPayStep('network'));
  $('#getQuote').addEventListener('click', requestQuote);
  $('#payAmount').addEventListener('input', () => { if (state.selectedNetwork) prepareQuote(state.selectedNetwork); });
  $$('.segmented button').forEach(button => button.addEventListener('click', () => {
    $$('.segmented button').forEach(item => item.classList.toggle('active', item === button));
    state.requestType = button.dataset.requestType;
    updateRequestPreview();
  }));
  $('#requestAmount').addEventListener('input', updateRequestPreview);
  $('#requestNote').addEventListener('input', updateRequestPreview);
  $('#previewEdit').addEventListener('click', () => $('#requestAmount').focus());
  $$('.filter').forEach(button => button.addEventListener('click', () => {
    $$('.filter').forEach(item => item.classList.toggle('active', item === button));
    toast('Activity filters apply once confirmed payments are stored.');
  }));
  $('#continueWithEmail').addEventListener('click', continueWithEmail);
  $('#retryWalletSetup').addEventListener('click', retryWalletSetup);
  $('#claimUsernameButton').addEventListener('click', claimUsername);
}

function init() {
  const publicHandle = document.body?.dataset.publicHandle;
  if (publicHandle) {
    renderRecipientProof();
    renderRails();
    renderNetworkPicker();
    refreshRoutes(true);
    bindEvents();
    initPublicPage(publicHandle);
    return;
  }
  renderActivity();
  renderIdentity();
  renderRecipientProof();
  renderRails();
  renderNetworkPicker();
  updateRequestPreview();
  bindEvents();
  refreshRoutes(true);
  initialiseDynamic();
}
init();
