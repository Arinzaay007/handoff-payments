const state = {
  selectedNetwork: null,
  requestType: 'fixed',
  balanceVisible: true,
  liveChains: null,
  quote: null,
  recipient: null,
  auth: {
    runtime: null,
    ready: false,
    otpVerification: null,
    user: null,
    wallets: [],
    token: null,
    profile: null,
    verifiedWallets: []
  }
};

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
  const link = profile ? `handoff.xyz/${profile.username}` : 'A verified Handoff username resolves to Monad USDC.';
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
  $('#authButton').innerHTML = state.auth.user ? 'Sign out <span>↗</span>' : 'Sign in <span>↗</span>';
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
function createRequestPreview() {
  if (!state.auth.profile) {
    toast('Sign in and claim a Handoff username before creating a request.');
    openAuthFlow();
    return;
  }
  $('#generatedLink').textContent = `Profile @${state.auth.profile.username} is verified. Persisted payment links are the next server step.`;
  $('#requestModalDescription').textContent = 'Handoff will only issue public links after the request is signed and stored against your active Monad recipient wallet.';
  openModal('requestModal');
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
function applyDynamicSnapshot(snapshot) {
  state.auth.user = snapshot?.user || null;
  state.auth.wallets = (snapshot?.wallets || []).filter(wallet => isEvmAddress(wallet.address));
  state.auth.token = snapshot?.token || null;
  renderIdentity();
}
async function initialiseDynamic() {
  try {
    const response = await fetch('/api/public-config');
    if (!response.ok) throw new Error('Unable to load public sign-in configuration.');
    state.auth.runtime = await response.json();
    if (!state.auth.runtime.dynamic?.enabled) return;
    await loadScript('/dynamic-client.bundle.js');
    const snapshot = await window.HandoffDynamic.initialize({ environmentId: state.auth.runtime.dynamic.environmentId });
    state.auth.ready = true;
    applyDynamicSnapshot(snapshot);
    if (state.auth.user && state.auth.token) await loadServerProfile();
  } catch (error) {
    console.warn('Dynamic initialization unavailable:', error.message);
    $('#authStatus').textContent = 'Secure sign-in is unavailable on this origin. Check the Dynamic CORS origin configuration.';
  }
}
async function apiMe() {
  const token = window.HandoffDynamic?.getToken?.();
  if (!token) throw new Error('Sign in to continue.');
  const response = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'Unable to load your Handoff profile.');
  return payload;
}
async function loadServerProfile() {
  const data = await apiMe();
  state.auth.profile = data.profile || null;
  state.auth.verifiedWallets = data.verifiedWallets || [];
  renderIdentity();
  return data;
}
function prepareClaim(wallets) {
  const select = $('#claimWallet');
  const options = (wallets || []).filter(isEvmAddress);
  select.innerHTML = options.length
    ? options.map(wallet => `<option value="${wallet}">${shortAddress(wallet)} · verified by Dynamic</option>`).join('')
    : '<option value="">No verified EVM wallet found</option>';
  $('#claimUsernameButton').disabled = !options.length;
}
async function completeAuthentication() {
  const snapshot = await window.HandoffDynamic.snapshot();
  applyDynamicSnapshot(snapshot);
  try {
    const data = await loadServerProfile();
    if (data.profile) {
      closeModals();
      toast(`Signed in as @${data.profile.username}.`);
      return;
    }
    prepareClaim(data.verifiedWallets);
    showAuthStep('claim');
    $('#claimStatus').textContent = 'Choose your username. The server will only accept a wallet verified by this session.';
  } catch (error) {
    prepareClaim(state.auth.wallets.map(wallet => wallet.address));
    showAuthStep('claim');
    $('#claimUsernameButton').disabled = true;
    $('#claimStatus').textContent = `Dynamic sign-in succeeded, but profile activation is unavailable: ${error.message}`;
  }
}
function openAuthFlow() {
  if (state.auth.user) {
    if (state.auth.profile) return goTo('identity');
    prepareClaim(state.auth.verifiedWallets.length ? state.auth.verifiedWallets : state.auth.wallets.map(wallet => wallet.address));
    showAuthStep('claim');
  } else {
    showAuthStep('email');
  }
  openModal('authModal');
}
async function sendEmailCode() {
  const email = $('#authEmail').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Enter a valid email address.');
  if (!state.auth.ready || !window.HandoffDynamic) return toast('Secure sign-in is still loading. Try again in a moment.');
  const button = $('#sendEmailCode');
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    state.auth.otpVerification = await window.HandoffDynamic.sendEmailCode(email);
    $('#codeDestination').textContent = `A secure code was sent to ${email}.`;
    $('#codeStatus').textContent = '';
    showAuthStep('code');
  } catch (error) {
    $('#authStatus').textContent = error.message || 'Unable to send a code.';
    toast(error.message || 'Unable to send a code.');
  } finally {
    button.disabled = false;
    button.innerHTML = 'Send secure code <span>→</span>';
  }
}
async function verifyEmailCode() {
  const code = $('#authCode').value.trim();
  if (!state.auth.otpVerification || !code) return toast('Enter the code from your email.');
  const button = $('#verifyEmailCode');
  button.disabled = true;
  button.textContent = 'Verifying…';
  try {
    await window.HandoffDynamic.verifyEmailCode(state.auth.otpVerification, code);
    state.auth.otpVerification = null;
    await completeAuthentication();
  } catch (error) {
    $('#codeStatus').textContent = error.message || 'That code could not be verified.';
    toast(error.message || 'That code could not be verified.');
  } finally {
    button.disabled = false;
    button.innerHTML = 'Verify &amp; continue <span>→</span>';
  }
}
async function passkeySignIn() {
  if (!state.auth.ready || !window.HandoffDynamic) return toast('Secure sign-in is still loading.');
  const button = $('#passkeySignIn');
  button.disabled = true;
  button.textContent = 'Opening passkey…';
  try {
    await window.HandoffDynamic.usePasskey();
    await completeAuthentication();
  } catch (error) {
    $('#authStatus').textContent = error.message || 'Passkey sign-in was not completed.';
  } finally {
    button.disabled = false;
    button.textContent = 'Use an existing passkey instead';
  }
}
async function claimUsername() {
  const username = $('#claimUsername').value.trim().replace(/^@/, '').toLowerCase();
  const walletAddress = $('#claimWallet').value;
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return toast('Use 3–24 lowercase letters, numbers, or underscores.');
  if (!isEvmAddress(walletAddress)) return toast('A verified EVM wallet is required.');
  const token = window.HandoffDynamic?.getToken?.();
  if (!token) return toast('Sign in again to claim a username.');
  const button = $('#claimUsernameButton');
  button.disabled = true;
  button.textContent = 'Claiming…';
  try {
    const response = await fetch('/api/me/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ username, walletAddress })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Unable to claim this username.');
    state.auth.profile = data.profile;
    renderIdentity();
    closeModals();
    toast(`@${data.profile.username} is ready to receive USDC on Monad.`);
  } catch (error) {
    $('#claimStatus').textContent = error.message;
    toast(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Claim username <span>→</span>';
  }
}
async function registerPasskey() {
  if (!window.HandoffDynamic) return;
  const button = $('#registerPasskey');
  button.disabled = true;
  button.textContent = 'Adding passkey…';
  try {
    await window.HandoffDynamic.addPasskey();
    $('#claimStatus').textContent = 'Passkey added to this device.';
    toast('Passkey added to this device.');
  } catch (error) {
    $('#claimStatus').textContent = error.message || 'Passkey registration was not completed.';
  } finally {
    button.disabled = false;
    button.textContent = 'Add a passkey to this device';
  }
}
async function signOut() {
  try {
    await window.HandoffDynamic?.signOut?.();
  } catch { /* Local UI is still reset. */ }
  state.auth.user = null;
  state.auth.wallets = [];
  state.auth.token = null;
  state.auth.profile = null;
  state.auth.verifiedWallets = [];
  renderIdentity();
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
  $('#copyPublicLink').addEventListener('click', () => state.auth.profile ? copyText(`https://handoff.xyz/${state.auth.profile.username}`, 'Payment page copied') : openAuthFlow());
  $('#copyWallet').addEventListener('click', () => state.auth.profile ? copyText(state.auth.profile.wallet, 'Monad recipient wallet copied') : openAuthFlow());
  $('#shareProfile').addEventListener('click', () => state.auth.profile ? copyText(`https://handoff.xyz/${state.auth.profile.username}`, 'Payment page copied') : openAuthFlow());
  $('#profileButton').addEventListener('click', () => state.auth.profile ? goTo('identity') : openAuthFlow());
  $('#authButton').addEventListener('click', () => state.auth.user ? signOut() : openAuthFlow());
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
  $('#generateRequest').addEventListener('click', createRequestPreview);
  $('#sharePreview').addEventListener('click', createRequestPreview);
  $('#previewEdit').addEventListener('click', () => $('#requestAmount').focus());
  $('#copyGeneratedLink').addEventListener('click', () => toast('Persisted payment links are not enabled yet.'));
  $('#shareGeneratedLink').addEventListener('click', () => toast('Persisted payment links are not enabled yet.'));
  $$('.filter').forEach(button => button.addEventListener('click', () => {
    $$('.filter').forEach(item => item.classList.toggle('active', item === button));
    toast('Activity filters apply once confirmed payments are stored.');
  }));
  $('#sendEmailCode').addEventListener('click', sendEmailCode);
  $('#verifyEmailCode').addEventListener('click', verifyEmailCode);
  $('#passkeySignIn').addEventListener('click', passkeySignIn);
  $('#backToEmail').addEventListener('click', () => showAuthStep('email'));
  $('#claimUsernameButton').addEventListener('click', claimUsername);
  $('#registerPasskey').addEventListener('click', registerPasskey);
}

function init() {
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
