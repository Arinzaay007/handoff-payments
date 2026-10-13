const state = {
  selectedNetwork: null,
  balanceVisible: true,
  routeStatus: null,
  payment: { quote: null, payer: null, paymentId: null, receipt: null, pendingHash: null, busy: false, flow: 0 },
  publicRequest: null,
  paymentRequests: { requests: [], loaded: false, loading: false },
  recipient: null,
  // Signed-in owner portfolio from /api/me/portfolio: the verified on-chain Monad USDC balance
  // and verified recipient receipt activity. Balance status: idle | syncing | available | unavailable.
  // "unavailable" is never shown as a zero balance.
  portfolio: { balance: { status: 'idle', amount: null }, activity: [], loaded: false },
  // USD is the real settlement unit. Other currencies are a clearly labelled reference display
  // preference and never influence funds, quotes, authorizations, or withdrawals.
  displayCurrency: 'USD',
  displayRates: { status: 'idle', rates: { USD: 1 }, checkedAt: null },
  features: { handoffTransfers: { available: false, maximumPerTransferUsdc: 25 } },
  handoffSend: { intent: null, busy: false, polling: null },
  auth: {
    ready: false,
    // True while Dynamic holds a signed-in session for this browser.
    signedIn: false,
    // Set when the visitor starts secure access, so a fresh sign-in opens onboarding.
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

// Display styling only. The network list itself comes from the server (/api/public-config) and the
// built-in list below mirrors src/paymentNetworks.js for the case where that config is not loaded.
const NETWORK_STYLE = {
  ethereum: { short: 'ETH', color: '#dfe7ff' },
  base: { short: 'B', color: '#cee6ff' },
  arbitrum: { short: 'A', color: '#d9e8ff' },
  optimism: { short: 'OP', color: '#ffd9dd' },
  polygon: { short: 'P', color: '#e8ddff' },
  bnb: { short: 'BNB', color: '#fff0b7' },
  avalanche: { short: 'AV', color: '#ffe0df' },
  celo: { short: 'CE', color: '#eaffbd' },
  solana: { short: 'S', color: '#dff9e6' },
  ton: { short: 'T', color: '#d9edff' }
};
const FALLBACK_SOURCE_NETWORKS = [
  { key: 'ethereum', name: 'Ethereum', chainId: 1, type: 'evm', nativeCurrency: 'ETH', status: 'live' },
  { key: 'base', name: 'Base', chainId: 8453, type: 'evm', nativeCurrency: 'ETH', status: 'live' },
  { key: 'arbitrum', name: 'Arbitrum', chainId: 42161, type: 'evm', nativeCurrency: 'ETH', status: 'live' },
  { key: 'optimism', name: 'Optimism', chainId: 10, type: 'evm', nativeCurrency: 'ETH', status: 'live' },
  { key: 'polygon', name: 'Polygon', chainId: 137, type: 'evm', nativeCurrency: 'POL', status: 'live' },
  { key: 'bnb', name: 'BNB Chain', chainId: 56, type: 'evm', nativeCurrency: 'BNB', status: 'live' },
  { key: 'avalanche', name: 'Avalanche', chainId: 43114, type: 'evm', nativeCurrency: 'AVAX', status: 'live' },
  { key: 'celo', name: 'Celo', chainId: 42220, type: 'evm', nativeCurrency: 'CELO', status: 'live' },
  { key: 'solana', name: 'Solana', chainId: 792703809, type: 'svm', nativeCurrency: 'SOL', status: 'not_available' },
  { key: 'ton', name: 'TON', chainId: 224235520, type: 'tonvm', nativeCurrency: 'TON', status: 'not_available' }
];
let networks = FALLBACK_SOURCE_NETWORKS.map(item => ({ ...item, ...NETWORK_STYLE[item.key] }));

const PAYMENT_POLL_MS = 3000;
const PAYMENT_POLL_LIMIT_MS = 20 * 60 * 1000;
const RECEIPT_TIMEOUT_MS = 3 * 60 * 1000;
// Display-only values for the clearly marked withdrawal preview. They are never sent to an API,
// used to alter balances, or described as a quote.
const WITHDRAW_DEMO_NGN_PER_USD = 1500;
const WITHDRAW_DEMO_FEE_RATE = 0.01;
let currentPaymentQr = null;


const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const initial = value => String(value || 'H').trim().charAt(0).toUpperCase() || 'H';

// Canonical public payment page for a username, derived from the origin the page was served from.
function canonicalPaymentUrl(username) {
  return new URL(`/@${username}`, window.location.origin).toString();
}
function shareableReceiptUrl(paymentId) {
  return new URL(`/receipts/${encodeURIComponent(paymentId)}`, window.location.origin).toString();
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
  stopHandoffSendPolling?.();
}
function closeMobileDrawer() {
  $('.sidebar')?.classList.remove('open');
  $('#mobileDrawerBackdrop')?.classList.remove('visible');
}
function toggleMobileDrawer() {
  const drawer = $('.sidebar');
  const backdrop = $('#mobileDrawerBackdrop');
  if (!drawer || !backdrop) return;
  const opening = !drawer.classList.contains('open');
  drawer.classList.toggle('open', opening);
  backdrop.classList.toggle('visible', opening);
}
function goTo(page) {
  $$('.page').forEach(el => el.classList.remove('active'));
  $(`#${page}Page`).classList.add('active');
  $$('.nav-item, .mobile-nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  // Bottom navigation is touch-first; close the optional side drawer after a mobile selection.
  closeMobileDrawer();
  const labels = {
    overview: ['PAYMENTS', 'Get paid, simply.'],
    'get-paid': ['GET PAID', 'Share your payment page'],
    activity: ['PAYMENT ACTIVITY', 'Your payment activity'],
    identity: ['YOUR PAYMENT NAME', 'Your name is how you get paid']
  };
  $('#pageEyebrow').textContent = labels[page][0];
  $('#pageTitle').textContent = labels[page][1];
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (page === 'overview' || page === 'activity') refreshPortfolio();
  if (page === 'get-paid') refreshPaymentRequests();
}

const DISPLAY_CURRENCIES = new Set(['USD', 'NGN', 'GBP', 'INR']);
const DISPLAY_LOCALES = Object.freeze({ USD: 'en-US', NGN: 'en-NG', GBP: 'en-GB', INR: 'en-IN' });

function savedDisplayCurrency() {
  try {
    const value = window.localStorage?.getItem('handoff-display-currency');
    return DISPLAY_CURRENCIES.has(value) ? value : 'USD';
  } catch {
    return 'USD';
  }
}

function displayRateFor(currency = state.displayCurrency) {
  return currency === 'USD' ? 1 : state.displayRates.rates?.[currency];
}

function displayCurrencyReady(currency = state.displayCurrency) {
  return currency === 'USD' || (state.displayRates.status === 'available' && Number.isFinite(displayRateFor(currency)) && displayRateFor(currency) > 0);
}

function formatDisplayMoney(value, { signed = false } = {}) {
  const amount = Number(value);
  const currency = displayCurrencyReady() ? state.displayCurrency : 'USD';
  const rate = displayRateFor(currency);
  if (!Number.isFinite(amount) || !Number.isFinite(rate)) return '—';
  if (currency === 'USD') return `${signed && amount < 0 ? '−' : ''}$${Math.abs(amount).toFixed(2)}`;
  const converted = Math.abs(amount) * rate;
  const formatted = new Intl.NumberFormat(DISPLAY_LOCALES[currency], {
    style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(converted);
  return `${signed && amount < 0 ? '−' : ''}${formatted}`;
}

function displayCurrencyIndicator() {
  return { USD: '$', NGN: '₦', GBP: '£', INR: '₹' }[state.displayCurrency] || '$';
}

async function loadDisplayRates() {
  if (state.displayCurrency === 'USD' || state.displayRates.status === 'loading') return;
  state.displayRates.status = 'loading';
  renderBalance();
  try {
    const data = await apiFetch('/api/display-rates');
    const rates = data?.rates;
    if (!rates || !['NGN', 'GBP', 'INR'].every(code => Number.isFinite(rates[code]) && rates[code] > 0)) throw new Error('Exchange display is unavailable.');
    state.displayRates = { status: 'available', rates: { USD: 1, NGN: rates.NGN, GBP: rates.GBP, INR: rates.INR }, checkedAt: data.checkedAt || null };
  } catch {
    // The account balance remains USD; never guess a rate or imply that an FX conversion happened.
    state.displayRates.status = 'unavailable';
  }
  renderBalance();
  renderActivity();
}

function setDisplayCurrency(currency) {
  const next = DISPLAY_CURRENCIES.has(currency) ? currency : 'USD';
  state.displayCurrency = next;
  try { window.localStorage?.setItem('handoff-display-currency', next); } catch { /* Preference remains for this page. */ }
  $('#displayCurrency').value = next;
  renderBalance();
  renderActivity();
  if (next !== 'USD' && !displayCurrencyReady(next)) loadDisplayRates();
}

function renderActivity() {
  const blank = `<div class="activity-item"><div class="activity-icon in">⌁</div><div class="activity-main"><b>No payments yet</b><span>Completed payments will appear here.</span></div></div>`;
  const syncing = `<div class="activity-item"><div class="activity-icon in">⌁</div><div class="activity-main"><b>Checking for payments…</b><span>Your activity is loading securely.</span></div></div>`;
  const markup = state.portfolio.activity.length
    ? state.portfolio.activity.map(activityItemMarkup).join('')
    : (state.auth.profile && !state.portfolio.loaded ? syncing : blank);
  $('#activityList').innerHTML = markup;
  $('#activityFullList').innerHTML = markup;
}

// Keep recipient activity in payment language. Server-side receipts retain all route and settlement
// detail for verification, but the merchant-facing dashboard exposes only an honest payment state.
function activityItemMarkup(item) {
  const complete = Boolean(item.settlementVerified && item.status === 'settled');
  const amount = item.receive?.amount || item.receive?.requested;
  const internalSend = item.kind === 'handoff_transfer' && item.direction === 'out';
  const amountValue = Number(amount);
  const amountText = Number.isFinite(amountValue)
    ? `${internalSend ? '−' : '+'}${formatDisplayMoney(amountValue)}`
    : 'Payment';
  const title = item.kind === 'handoff_transfer'
    ? (internalSend ? 'Money sent' : 'Money received')
    : (complete ? 'Payment received' : item.final ? 'Payment update' : 'Payment in progress');
  const detail = complete ? 'Payment confirmed' : item.final ? 'Payment could not be completed' : 'We are confirming this payment';
  const progress = complete ? 'Complete' : item.final ? 'Complete' : 'Confirming';
  return `<div class="activity-item"><div class="activity-icon ${internalSend ? 'out' : 'in'}">${internalSend ? '↗' : '↙'}</div><div class="activity-main"><b>${title}</b><span>${detail}</span></div><div class="activity-right"><b>${amountText}</b><span>${progress}</span></div></div>`;
}

// The server reads the real payment balance in USD. A selected NGN, GBP, or INR view is only a
// reference display; it never changes the balance, a payment amount, a quote, or a withdrawal.
function renderBalance() {
  const profile = state.auth.profile;
  const balance = state.portfolio.balance;
  const amount = $('#balanceAmount');
  const sub = $('#balanceSub');
  const indicator = `<span class="stable-dot">${displayCurrencyIndicator()}</span>`;
  if (!profile) {
    amount.innerHTML = state.balanceVisible ? '—' : '•••';
    sub.innerHTML = `${indicator} Sign in to view your confirmed balance`;
    return;
  }
  if (!state.balanceVisible) {
    amount.innerHTML = '•••';
    sub.innerHTML = `${indicator} Balance hidden`;
    return;
  }
  if (balance.status === 'available') {
    amount.textContent = formatDisplayMoney(balance.amount);
    if (state.displayCurrency === 'USD') sub.innerHTML = `${indicator} Confirmed balance`;
    else if (displayCurrencyReady()) sub.innerHTML = `${indicator} Reference display in ${state.displayCurrency} · your balance remains in USD`;
    else if (state.displayRates.status === 'loading') sub.innerHTML = `${indicator} Loading your ${state.displayCurrency} display`;
    else sub.innerHTML = '<span class="stable-dot">$</span> Exchange display is unavailable · showing your USD balance';
    return;
  }
  amount.innerHTML = '—';
  sub.innerHTML = balance.status === 'unavailable'
    ? `${indicator} We could not refresh your balance — this is not a zero balance`
    : `${indicator} Checking your confirmed balance`;
}

// Loads the signed-in owner's portfolio. Failures keep the last honest state: an unreadable RPC
// is "syncing/unavailable", never a fabricated zero.
async function refreshPortfolio() {
  if (!state.auth.profile) return;
  if (!state.portfolio.loaded) {
    state.portfolio.balance = { status: 'syncing', amount: null };
    renderBalance();
    renderActivity();
  }
  try {
    const data = await apiFetch('/api/me/portfolio');
    state.portfolio.balance = data.balance || { status: 'unavailable', amount: null };
    state.portfolio.activity = Array.isArray(data.activity) ? data.activity : [];
    state.portfolio.loaded = true;
    renderBalance();
    renderActivity();
  } catch (error) {
    if (error.status === 401) return expireSession();
    state.portfolio.balance = { status: 'unavailable', amount: null };
    state.portfolio.loaded = true;
    renderBalance();
    renderActivity();
  }
}

function paymentRequestUrl(request) {
  return `${canonicalPaymentUrl(state.auth.profile.username)}?request=${encodeURIComponent(request.id)}`;
}
function paymentRequestDetail(request) {
  if (request.status === 'paid') return `Paid${request.paidAt ? ` · ${new Date(request.paidAt).toLocaleDateString()}` : ''}`;
  if (request.status === 'expired') return 'Expired';
  if (request.status === 'cancelled') return 'Cancelled';
  return `Expires ${new Date(request.expiresAt).toLocaleDateString()}`;
}
function renderPaymentRequests() {
  const list = $('#paymentRequestsList');
  if (!list) return;
  list.textContent = '';
  if (!state.auth.profile) {
    list.innerHTML = '<p class="request-empty">Sign in to create and track exact payment requests.</p>';
    return;
  }
  if (!state.paymentRequests.loaded) {
    list.innerHTML = '<p class="request-empty">Checking your requests…</p>';
    return;
  }
  if (!state.paymentRequests.requests.length) {
    list.innerHTML = '<p class="request-empty">No requests yet. Create one when you need a fixed amount.</p>';
    return;
  }
  for (const request of state.paymentRequests.requests) {
    const item = document.createElement('article');
    item.className = 'payment-request-item';
    const copy = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = `$${request.amount} requested`;
    const detail = document.createElement('span');
    detail.textContent = request.note || 'Exact payment request';
    copy.append(title, detail);
    const meta = document.createElement('div');
    meta.className = 'payment-request-meta';
    const status = document.createElement('span');
    status.className = `request-status ${request.status}`;
    status.textContent = paymentRequestDetail(request);
    const actions = document.createElement('div');
    actions.className = 'request-item-actions';
    if (request.status === 'active') {
      const share = document.createElement('button');
      share.type = 'button'; share.textContent = 'Copy link';
      share.addEventListener('click', () => copyText(paymentRequestUrl(request), 'Payment request copied'));
      actions.appendChild(share);
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => cancelPaymentRequest(request, cancel));
      actions.appendChild(cancel);
    }
    meta.append(status, actions);
    item.append(copy, meta);
    list.appendChild(item);
  }
}
async function refreshPaymentRequests({ force = false } = {}) {
  if (!state.auth.profile || state.paymentRequests.loading || (state.paymentRequests.loaded && !force)) return;
  state.paymentRequests.loading = true;
  renderPaymentRequests();
  try {
    const data = await apiFetch('/api/me/payment-requests');
    state.paymentRequests.requests = Array.isArray(data.requests) ? data.requests : [];
    state.paymentRequests.loaded = true;
  } catch (error) {
    if (error.status === 401) return expireSession();
    state.paymentRequests.requests = [];
    state.paymentRequests.loaded = true;
  } finally {
    state.paymentRequests.loading = false;
    renderPaymentRequests();
  }
}
async function cancelPaymentRequest(request, button) {
  if (!window.confirm(`Cancel the $${request.amount} request? People will no longer be able to use its link.`)) return;
  button.disabled = true; button.textContent = 'Cancelling…';
  try {
    await apiFetch(`/api/me/payment-requests/${encodeURIComponent(request.id)}/cancel`, { method: 'POST', body: {} });
    await refreshPaymentRequests({ force: true });
  } catch (error) {
    if (error.status === 401) return expireSession();
    toast(error.message || 'We could not cancel this request.');
    button.disabled = false; button.textContent = 'Cancel';
  }
}

function renderIdentity() {
  const profile = state.auth.profile;
  const handle = profile ? `@${profile.username}` : 'Get started to claim your @username';
  const name = profile?.displayName || 'Get started with Handoff';
  const link = profile ? canonicalPaymentUrl(profile.username).replace(/^https?:\/\//, '') : 'Create a simple page for people to pay you.';
  const avatar = initial(profile?.displayName || profile?.username);

  $('#identityHandle').textContent = handle;
  $('#identityLink').textContent = link;
  $('#identityAvatar').textContent = avatar;
  $('#profileName').textContent = name;
  $('#profileHandle').textContent = profile ? `${handle} · Ready to get paid.` : 'Get started with email, then use a passkey for quicker access.';
  $('#profileAvatar').textContent = avatar;
  $('#profileMiniAvatar').textContent = avatar;
  $('#profileMiniName').textContent = profile ? name : 'Get started with Handoff';
  $('#profileMiniHandle').textContent = profile ? handle : 'Create your payment name';
  $('#authButton').innerHTML = state.auth.signedIn ? 'Sign out <span>↗</span>' : 'Get started <span>↗</span>';
  $('#sharePageTitle').textContent = profile ? `Share ${handle}` : 'Get started to create your payment page.';
  $('#sharePageCopy').textContent = profile ? 'Copy or show this page to anyone who needs to pay you.' : 'New here? Start with email, then set up a passkey.';
  $('#sharePageLink').textContent = profile ? canonicalPaymentUrl(profile.username).replace(/^https?:\/\//, '') : '—';
  $('#createFixedRequest').disabled = !profile;
  $('#sharePaidPage').disabled = !profile;
  $('#showPaymentQr').disabled = !profile;
  $('#editProfile').disabled = !profile;
  if (!profile) currentPaymentQr = null;
  renderBalance();
  renderPaymentRequests();

  $('#aliasList').innerHTML = profile
    ? `<div class="alias-entry"><div class="alias-platform">@</div><div class="alias-data"><b>Handoff username</b><span>@${profile.username}</span></div><div class="alias-status">✓ Active</div></div>`
    : '<div class="alias-entry"><div class="alias-platform">@</div><div class="alias-data"><b>One canonical username</b><span>Sign in to claim your payment name.</span></div></div>';
}

function renderRails() {
  const grid = $('#routesGrid');
  if (!grid) return;
  grid.innerHTML = networks.map(network => {
    if (network.status !== 'live') {
      return `<div class="rail unavailable" title="${network.name} is not available yet"><span class="rail-icon" style="background:${network.color}">${network.short}</span><span>${network.name}</span><em class="rail-status">Not available yet</em></div>`;
    }
    const selectable = networkSelectable(network);
    return `<div class="rail ${selectable ? '' : 'unavailable'}" title="${network.name}"><span class="rail-icon" style="background:${network.color}">${network.short}</span><span>${network.name}</span>${selectable ? '<i class="route-live"></i>' : '<em class="rail-status">Route unavailable now</em>'}</div>`;
  }).join('');
}
function renderNetworkPicker() {
  $('#networkPicker').innerHTML = networks.map(network => {
    const selectable = networkSelectable(network);
    const detail = network.status !== 'live' ? 'Not available yet' : selectable ? 'Pay in USDC' : 'Route unavailable now';
    return `
    <button class="network-option ${selectable ? '' : 'unavailable'}" data-network="${network.key}" ${selectable ? '' : 'disabled'}>
      <span class="rail-icon" style="background:${network.color}">${network.short}</span>
      <span><b>${network.name}</b><small>${detail}</small></span>
    </button>`;
  }).join('');
  $$('.network-option').forEach(button => button.addEventListener('click', () => selectNetwork(button.dataset.network)));
}
// Replaces the built-in network list with the server's list. Solana and TON stay "Not available yet".
function applyPaymentConfig(payments) {
  const list = Array.isArray(payments?.sourceNetworks) ? payments.sourceNetworks : null;
  if (!list || list.length === 0) return;
  networks = list.map(item => ({ ...item, ...(NETWORK_STYLE[item.key] || { short: String(item.name || '?').slice(0, 3).toUpperCase(), color: '#eeeeee' }) }));
  renderRails();
  renderNetworkPicker();
}
async function refreshRoutes(silent = false) {
  const status = $('#routeSyncText');
  if (status) status.textContent = 'Syncing routes…';
  const live = networks.filter(network => network.status === 'live');
  try {
    const response = await fetch('/api/relay/routes');
    if (!response.ok) throw new Error('Route status did not respond');
    const data = await response.json();
    state.routeStatus = Object.fromEntries((data.routes || []).map(route => [route.key, route.status]));
    renderRails();
    renderNetworkPicker();
    const available = live.filter(networkSelectable).length;
    const railStatus = $('#railStatus');
    if (railStatus) railStatus.textContent = `${available} of ${live.length} live source networks are open right now. Solana and TON are not available yet.`;
    if (status) status.textContent = `${available}/${live.length} routes checked live`;
    if (!silent) toast(`Live Relay data checked: ${available} of ${live.length} source routes open.`);
  } catch {
    if (status) status.textContent = 'Route check unavailable';
    const railStatus = $('#railStatus');
    if (railStatus) railStatus.textContent = 'Route status is checked again when you request a quote. A live quote is required before anything can be signed.';
    if (!silent) toast('Could not reach Relay. Check again before paying.');
  }
}

function freshPaymentState() {
  return { quote: null, payer: null, paymentId: null, receipt: null, pendingHash: null, busy: false, flow: (state.payment?.flow || 0) + 1 };
}
// True while a wallet prompt or a non-final receipt is still being tracked. Such a payment is not interrupted.
function paymentInProgress() {
  const receipt = state.payment?.receipt;
  return Boolean(state.payment?.busy || state.payment?.pendingHash || (receipt && !TERMINAL_RECEIPT_STATES.has(receipt.status)));
}
function resetPaymentFlow() {
  state.payment = freshPaymentState();
  $('#shareReceipt').hidden = true;
}
function setQuoteBadge(text, tone) {
  const badge = $('#quoteBadge');
  badge.textContent = text;
  badge.dataset.tone = tone;
}
// mode: quote | preview | sign | busy | none. The submit button is the only way to reach a wallet prompt.
function setQuoteButtons(mode, label = '') {
  const quoteButton = $('#getQuote');
  const signButton = $('#signPay');
  quoteButton.hidden = mode === 'sign' || mode === 'busy' || mode === 'none';
  quoteButton.disabled = mode === 'preview' || mode === 'busy';
  if (!quoteButton.hidden && label) quoteButton.textContent = label;
  signButton.hidden = !(mode === 'sign' || mode === 'busy');
  signButton.disabled = mode === 'busy';
  if (!signButton.hidden && label) signButton.textContent = label;
}
function amountInput() {
  return String($('#payAmount').value || '').replace(/,/g, '').trim();
}
function shortId(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase() || '—';
}
function shortHash(hash) {
  return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : '—';
}
function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Receipt steps, in the order the payment can move. The final label is shown only from the server's state.
const RECEIPT_STEPS = [
  ['quote_created', 'Quote received'],
  ['awaiting_sender', 'Awaiting payer signature'],
  ['transaction_submitted', 'Transaction submitted'],
  ['source_confirmed', 'Source confirmed'],
  ['routing', 'Routing'],
  ['settled', 'Settlement on Monad']
];
const TERMINAL_RECEIPT_STATES = new Set(['settled', 'failed', 'refunded']);

function renderReceipt(status) {
  const list = $('#receiptSteps');
  if (!status) {
    list.hidden = true;
    list.innerHTML = '';
    return;
  }
  list.hidden = false;
  const failed = status === 'failed' || status === 'refunded';
  const index = RECEIPT_STEPS.findIndex(([key]) => key === status);
  const steps = RECEIPT_STEPS.map(([key, label], position) => {
    let cls = 'pending';
    if (!failed && position < index) cls = 'done';
    if (!failed && position === index) cls = status === 'settled' ? 'done' : 'active';
    const text = key === 'settled' && status === 'settled' ? 'Settled as USDC on Monad' : label;
    return `<li class="${cls}" data-receipt="${key}"><span></span>${text}</li>`;
  });
  if (failed) {
    steps.push(`<li class="failed" data-receipt="${status}"><span></span>${status === 'failed' ? 'Failed' : 'Refunded to payer'}</li>`);
  }
  list.innerHTML = steps.join('');
}

function receiptMessage(receipt) {
  switch (receipt.status) {
    case 'quote_created': return 'Quote received. Review the route, then approve the transaction in your wallet. Nothing is submitted without your approval.';
    case 'awaiting_sender': return 'Waiting for your wallet approval. Nothing has been submitted yet.';
    case 'transaction_submitted': return `Transaction submitted from your wallet (${shortHash(receipt.sourceTxHash)}). Waiting for the source chain to confirm.`;
    case 'source_confirmed': return 'Source transaction confirmed. Routing to Monad.';
    case 'routing': return 'Routing to Monad. Handoff shows “Settled” only after Monad confirms the USDC transfer.';
    case 'settled': return `Recipient received exactly ${receipt.receive?.amount || receipt.receive?.requested || 'the requested'} USDC on Monad, verified on-chain (${shortHash(receipt.destinationTxHash)}).`;
    case 'failed': return receipt.failure?.message || 'This payment could not be completed.';
    case 'refunded': return 'Relay refunded this payment. Check your source wallet.';
    default: return '';
  }
}

function networkSelectable(network) {
  if (!network || network.status !== 'live') return false;
  // Until the server has checked routes, a live network stays selectable; the quote itself is the real check.
  if (!state.routeStatus) return true;
  return state.routeStatus[network.key] !== 'unavailable';
}

function renderPaymentReceipt(receipt) {
  state.payment.receipt = receipt;
  renderReceipt(receipt.status);
  const tone = receipt.status === 'settled' ? 'settled' : (receipt.status === 'failed' || receipt.status === 'refunded') ? 'failed' : 'live';
  setQuoteBadge(receipt.label, tone);
  $('#quoteState').textContent = receiptMessage(receipt);
  const canShare = TERMINAL_RECEIPT_STATES.has(receipt.status) && /^[0-9a-f-]{36}$/i.test(String(receipt.paymentId || ''));
  $('#shareReceipt').hidden = !canShare;
  if (TERMINAL_RECEIPT_STATES.has(receipt.status)) setQuoteButtons('none');
  else setQuoteButtons('busy', receipt.status === 'awaiting_sender' ? 'Waiting for wallet approval…' : 'Payment in progress…');
}

function showPayStep(name) {
  $$('.modal-step', $('#payModal')).forEach(step => step.classList.toggle('active', step.dataset.step === name));
}
function openPay() {
  state.selectedNetwork = null;
  resetPaymentFlow();
  state.recipient = null;
  $('#payRecipient').value = '';
  $('#payAmount').readOnly = false;
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
  proof.innerHTML = `<span class="avatar gradient-avatar">@</span><span><b>${message || 'Enter a Handoff username'}</b><small>Handoff resolves the recipient securely on the server.</small></span>`;
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
  if (network.status !== 'live') return toast(`${network.name} is not available yet.`);
  if (!networkSelectable(network)) return toast(`${network.name} has no live USDC route right now.`);
  resetPaymentFlow();
  state.selectedNetwork = network;
  prepareQuote(network);
  showPayStep('quote');
}
function prepareQuote(network) {
  const amount = Number(amountInput() || 25);
  const requested = Number.isFinite(amount) ? amount.toFixed(2) : '—';
  $('#quoteSend').textContent = '— USDC';
  $('#quoteSource').textContent = `live USDC quote on ${network.name}`;
  $('#quoteReceive').textContent = `${requested} USDC`;
  $('#quoteReceiveMeta').textContent = 'on Monad · pending route validation';
  $('#quoteGas').textContent = `${network.nativeCurrency || 'native gas'} — paid by you`;
  $('#quoteRouteCost').textContent = 'Included in live quote';
  $('#quoteRoute').textContent = `Relay · ${network.name} → Monad`;
  $('#quoteRecipientName').textContent = `${state.recipient?.displayName || state.recipient?.username || 'Recipient'} receives`;
  $('#quoteRecipientHandle').textContent = state.recipient ? `@${state.recipient.username}` : '—';
  $('#paymentId').textContent = '—';
  renderReceipt(null);
  setQuoteBadge('Quote not requested yet', 'neutral');
  $('#quoteState').textContent = 'Connect your wallet to request a live exact-output quote. Recipient output is fixed; the live quote determines your source-USDC amount.';
  setQuoteButtons('quote', 'Connect wallet & get live quote ↗');
}
async function ethereumAccount() {
  if (!window.ethereum) throw new Error('No EVM wallet found. Open Handoff in MetaMask, Rabby, or another EVM wallet browser.');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0]) throw new Error('No wallet account selected.');
  return accounts[0];
}

// Step 1 of checkout. The server validates the route and, if Relay returns an executable transaction
// plan, reserves the attempt. Nothing is signed here.
function applyQuote(data) {
  const quote = data.quote || {};
  const receive = quote.receive || {};
  const pay = quote.pay || {};
  const eta = quote.timeEstimateSeconds ? ` Estimated route time: ${quote.timeEstimateSeconds}s.` : '';
  const requested = receive.requested ? `${receive.requested} USDC${receive.guaranteed ? ' — guaranteed' : ''}` : '— USDC';
  $('#quoteReceive').textContent = requested;
  $('#quoteReceiveMeta').textContent = receive.guaranteed ? 'on Monad · guaranteed' : 'on Monad · not guaranteed';
  $('#quoteSend').textContent = pay.amount ? `${pay.amount} ${pay.asset || 'USDC'}` : '— USDC';
  $('#quoteSource').textContent = pay.amount ? `live quote on ${quote.sourceNetwork?.name || 'source network'}` : 'no executable source quote';
  $('#quoteGas').textContent = `${quote.networkGas?.asset || 'Native gas'} — paid by you`;
  $('#quoteRouteCost').textContent = pay.routeCost !== null && pay.routeCost !== undefined
    ? `${pay.routeCost} USDC included in your quote`
    : 'Not available without an executable quote';
  if (!data.executable) {
    state.payment.quote = null;
    $('#paymentId').textContent = '—';
    setQuoteBadge('Quote preview only', 'preview');
    $('#quoteState').textContent = `${data.message || 'Quote preview only.'}${eta} Nothing can be signed because Handoff could not verify an exact recipient output.`;
    renderReceipt(null);
    setQuoteButtons('preview', 'Quote preview only — no transaction to sign');
    return;
  }
  state.payment.quote = data;
  state.payment.paymentId = data.paymentId;
  $('#paymentId').textContent = shortId(data.paymentId);
  setQuoteBadge('Quote received', 'live');
  $('#quoteState').textContent = `Recipient receives ${receive.requested} USDC on Monad — guaranteed. You pay ${pay.amount} USDC, including ${pay.routeCost} USDC in route costs, plus ${quote.networkGas?.asset || 'native'} network gas from your wallet.${eta} Quote expires at ${formatTime(data.expiresAt)}. Review the route, then sign in your wallet.`;
  renderReceipt('quote_created');
  setQuoteButtons('sign', 'Sign & pay in wallet ↗');
}

async function requestQuote() {
  const network = state.selectedNetwork;
  const recipient = state.recipient;
  if (!network || !recipient) return toast('Verify a recipient before requesting a quote.');
  if (!networkSelectable(network)) return toast(`${network.name} is not available right now.`);
  const flow = state.payment.flow;
  setQuoteButtons('busy', 'Connecting wallet…');
  try {
    const payer = await ethereumAccount();
    if (flow !== state.payment.flow) return;
    setQuoteButtons('busy', 'Getting live quote…');
    const response = await fetch('/api/payments/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payer, sourceNetwork: network.key, recipientHandle: recipient.username, amount: amountInput(),
        ...(state.publicRequest?.status === 'active' ? { paymentRequestId: state.publicRequest.id } : {})
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Unable to get a route.');
    if (flow !== state.payment.flow) return;
    state.payment.payer = String(payer).toLowerCase();
    applyQuote(data);
    toast(data.executable ? 'Live quote received. Nothing has been signed yet.' : 'Quote preview only. No transaction is available for this route.');
  } catch (error) {
    if (flow !== state.payment.flow) return;
    $('#quoteState').textContent = error.message;
    setQuoteButtons('quote', 'Connect wallet & get live quote ↗');
    toast(error.message);
  }
}

// --- Step 2: the payer signs and broadcasts through their own wallet -----------------------------

async function postPayment(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || 'Handoff could not record this payment step.');
    error.code = data.code || null;
    throw error;
  }
  return data;
}

async function switchToChain(provider, chainId, networkName) {
  const hexChain = `0x${Number(chainId).toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain }] });
  } catch (error) {
    if (error?.code === 4902) throw new Error(`Add ${networkName} to your wallet, then try again.`);
    throw error;
  }
  const current = await provider.request({ method: 'eth_chainId' });
  if (String(current).toLowerCase() !== hexChain) throw new Error(`Switch your wallet to ${networkName}, then try again.`);
}

async function waitForApprovalReceipt(provider, hash, flow) {
  const startedAt = Date.now();
  while (flow === state.payment.flow) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (receipt.status === '0x1') return;
      throw new Error('The token approval failed on-chain. Nothing was deposited.');
    }
    if (Date.now() - startedAt > RECEIPT_TIMEOUT_MS) throw new Error('The token approval is still pending. Check your wallet, then try again.');
    await delay(3000);
  }
}

async function pollPayment(paymentId, flow) {
  const startedAt = Date.now();
  while (flow === state.payment.flow && Date.now() - startedAt < PAYMENT_POLL_LIMIT_MS) {
    try {
      const response = await fetch(`/api/payments/${encodeURIComponent(paymentId)}`);
      const receipt = await response.json();
      if (response.ok && flow === state.payment.flow) {
        renderPaymentReceipt(receipt);
        if (TERMINAL_RECEIPT_STATES.has(receipt.status)) return;
      }
    } catch {
      // Transient network errors keep polling. The last confirmed state stays on screen.
    }
    await delay(PAYMENT_POLL_MS);
  }
}

async function recordPendingHash(flow) {
  const hash = state.payment.pendingHash;
  const paymentId = state.payment.paymentId;
  const receipt = await postPayment(`/api/payments/${paymentId}/source-transaction`, { txHash: hash });
  if (flow !== state.payment.flow) return;
  state.payment.pendingHash = null;
  renderPaymentReceipt(receipt);
  pollPayment(paymentId, flow);
}

function expireQuote(message) {
  state.payment.quote = null;
  renderReceipt(null);
  setQuoteBadge('Quote expired', 'failed');
  $('#quoteState').textContent = message;
  setQuoteButtons('quote', 'Get a new quote ↗');
}

async function signAndPay() {
  const data = state.payment.quote;
  if (!data?.executable || !data.paymentId) return toast('Get a live quote before signing.');
  if (state.payment.busy) return;
  const flow = state.payment.flow;
  const network = networks.find(item => item.chainId === data.steps[0]?.chainId);
  const networkName = network?.name || 'the source network';

  if (state.payment.pendingHash) {
    // The wallet already submitted a transaction. Record that hash before doing anything else.
    state.payment.busy = true;
    setQuoteButtons('busy', 'Recording transaction…');
    try {
      await recordPendingHash(flow);
    } catch (error) {
      if (flow === state.payment.flow) {
        $('#quoteState').textContent = `Your wallet submitted transaction ${shortHash(state.payment.pendingHash)}, but Handoff could not record it yet. Try again.`;
        setQuoteButtons('sign', 'Record submitted transaction ↗');
        toast(error.message);
      }
    } finally {
      if (flow === state.payment.flow) state.payment.busy = false;
    }
    return;
  }

  if (Date.parse(data.expiresAt) <= Date.now()) {
    return expireQuote('This quote has expired. Get a new quote to continue.');
  }

  state.payment.busy = true;
  setQuoteButtons('busy', 'Waiting for your wallet…');
  let submitted = false;
  try {
    const provider = window.ethereum;
    if (!provider) throw new Error('No EVM wallet found. Open Handoff in an EVM wallet browser.');
    const accounts = await provider.request({ method: 'eth_accounts' });
    const payer = String(accounts?.[0] || '').toLowerCase();
    if (!payer || payer !== state.payment.payer) {
      throw new Error('Switch your wallet to the account that requested this quote, then try again.');
    }
    await switchToChain(provider, data.steps[0].chainId, networkName);
    const awaiting = await postPayment(`/api/payments/${data.paymentId}/awaiting-signature`);
    if (flow !== state.payment.flow) return;
    renderPaymentReceipt(awaiting);

    for (const step of data.steps) {
      if (flow !== state.payment.flow) return;
      if (String(step.from).toLowerCase() !== payer) throw new Error('The wallet account changed. Get a new quote.');
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: step.from, to: step.to, data: step.data, value: step.value, chainId: `0x${Number(step.chainId).toString(16)}` }]
      });
      if (step.role === 'approve') {
        setQuoteButtons('busy', 'Confirming token approval…');
        await waitForApprovalReceipt(provider, hash, flow);
        continue;
      }
      // The source (deposit) transaction. Record its hash on the server before showing anything further.
      state.payment.pendingHash = hash;
      submitted = true;
      await recordPendingHash(flow);
    }
  } catch (error) {
    if (flow !== state.payment.flow) return;
    if (error?.code === 4001) {
      // The payer declined. Nothing was broadcast by this step.
      $('#quoteState').textContent = 'Signature declined in your wallet. Nothing was submitted.';
      setQuoteButtons('sign', 'Sign & pay in wallet ↗');
      return;
    }
    const message = error?.message || 'The wallet could not submit this transaction.';
    if (state.payment.pendingHash) {
      $('#quoteState').textContent = `Your wallet submitted transaction ${shortHash(state.payment.pendingHash)}, but Handoff could not record it yet. Try again.`;
      setQuoteButtons('sign', 'Record submitted transaction ↗');
    } else {
      $('#quoteState').textContent = message;
      setQuoteButtons(submitted ? 'busy' : 'sign', 'Sign & pay in wallet ↗');
    }
    toast(message);
  } finally {
    if (flow === state.payment.flow) state.payment.busy = false;
  }
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
  stopHandoffSendPolling();
  state.handoffSend = { intent: null, signature: null, busy: false, polling: null };
  state.auth.flowToken += 1;
  state.auth.signedIn = false;
  state.auth.awaitingSignIn = false;
  state.auth.profile = null;
  state.portfolio = { balance: { status: 'idle', amount: null }, activity: [], loaded: false };
  state.paymentRequests = { requests: [], loaded: false, loading: false };
  renderIdentity();
  renderActivity();
  renderPaymentRequests();
}

async function expireSession() {
  try { await window.HandoffDynamic?.signOut?.(); } catch { /* Local state still resets below. */ }
  resetLocalSession();
  showAuthStep('start');
  setAuthStatus('Your session ended. Get started securely to access your payment page again.');
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

function showPasskeyStep(flow) {
  if (flow !== state.auth.flowToken) return;
  const button = $('#registerPasskey');
  button.disabled = false;
  button.innerHTML = 'Set up passkey <span>→</span>';
  $('#passkeyStatus').textContent = '';
  showAuthStep('passkey');
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

async function startPaymentAccountSetup(flow) {
  if (flow !== state.auth.flowToken) return;
  showAuthStep('provisioning');
  setProvisioningState();
  await waitForEmbeddedWallet(flow);
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
      refreshPortfolio();
      return;
    }
    // A passkey can only be enrolled after the first verified email session exists. Existing
    // recipients who already enrolled one continue directly; new recipients get the normal
    // device prompt before their payment name is created.
    const hasPasskey = await window.HandoffDynamic?.hasPasskey?.();
    if (hasPasskey === false) return showPasskeyStep(flow);
  } catch (error) {
    if (error.status === 401) return expireSession();
    // If the provider cannot report passkey status, keep access available and let its hosted
    // experience handle the next step rather than fabricating a claim about account security.
  }
  await startPaymentAccountSetup(flow);
}

async function registerPasskey() {
  const button = $('#registerPasskey');
  const flow = state.auth.flowToken;
  if (!window.HandoffDynamic?.registerPasskey) return startPaymentAccountSetup(flow);
  button.disabled = true;
  button.textContent = 'Opening your device prompt…';
  $('#passkeyStatus').textContent = '';
  try {
    await window.HandoffDynamic.registerPasskey();
    if (flow !== state.auth.flowToken) return;
    $('#passkeyStatus').textContent = 'Passkey ready. Setting up your payment account…';
    await startPaymentAccountSetup(flow);
  } catch (error) {
    console.warn('Handoff: passkey setup failed.', error);
    if (flow !== state.auth.flowToken) return;
    button.disabled = false;
    button.innerHTML = 'Try passkey setup again <span>↻</span>';
    $('#passkeyStatus').textContent = 'We could not set up your passkey. Try again or use another device.';
  }
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

// Dynamic's hosted widget takes over for first-time email setup and returning-passkey access. Our modal steps aside.
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
    if (state.auth.profile) refreshPortfolio();
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
  if (state.publicRequest?.status === 'active') {
    $('#payAmount').value = state.publicRequest.amount;
    $('#payAmount').readOnly = true;
  }
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
  const requestId = new URLSearchParams(window.location.search).get('request');
  if (!requestId) return;
  // A shared request must never briefly fall back to a generic, editable checkout while its fixed
  // terms load. It is unavailable rather than guessed if the request cannot be verified.
  $('#publicPayButton').disabled = true;
  $('#publicPayButton').textContent = 'Checking request…';
  try {
    const response = await fetch(`/api/public/payment-requests?id=${encodeURIComponent(requestId)}`);
    const paymentRequest = await response.json();
    if (!response.ok || paymentRequest?.recipient?.username?.toLowerCase() !== handle.toLowerCase()) throw new Error('REQUEST_NOT_AVAILABLE');
    state.publicRequest = paymentRequest;
    $('#publicCopy').textContent = paymentRequest.status === 'active'
      ? `${paymentRequest.note ? `${paymentRequest.note} · ` : ''}Pay exactly $${paymentRequest.amount} before this request expires.`
      : `This payment request is ${paymentRequest.status}.`;
    $('#publicPayButton').disabled = paymentRequest.status !== 'active';
    $('#publicPayButton').innerHTML = paymentRequest.status === 'active' ? `Pay $${paymentRequest.amount} <span>→</span>` : 'Request unavailable';
  } catch {
    $('#publicCopy').textContent = 'This payment request is unavailable.';
    $('#publicPayButton').disabled = true;
    $('#publicPayButton').textContent = 'Request unavailable';
  }
}

function showWithdrawDemoStep(name) {
  $$('[data-withdraw-step]').forEach(step => step.classList.toggle('active', step.dataset.withdrawStep === name));
}

function withdrawalDemoAmount() {
  const amount = Number($('#withdrawDemoAmount').value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    throw new Error('Enter a demo amount between $0.01 and $100,000.');
  }
  return Math.round(amount * 100) / 100;
}

function formatDemoNaira(amount) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0
  }).format(amount);
}

function renderWithdrawDemoReview() {
  const amount = withdrawalDemoAmount();
  const converted = Math.round(amount * WITHDRAW_DEMO_NGN_PER_USD);
  const fee = Math.round(converted * WITHDRAW_DEMO_FEE_RATE);
  $('#withdrawDemoUsd').textContent = `$${amount.toFixed(2)}`;
  $('#withdrawDemoRate').textContent = `$1 ≈ ${formatDemoNaira(WITHDRAW_DEMO_NGN_PER_USD)}`;
  $('#withdrawDemoFee').textContent = formatDemoNaira(fee);
  $('#withdrawDemoNgn').textContent = formatDemoNaira(converted - fee);
}

function openWithdrawDemo() {
  if (!state.auth.profile) return openAuthFlow();
  const available = state.portfolio.balance.status === 'available' ? Number(state.portfolio.balance.amount) : NaN;
  const suggested = Number.isFinite(available) && available > 0 ? Math.min(available, 25) : 25;
  $('#withdrawDemoAmount').value = suggested.toFixed(2);
  showWithdrawDemoStep('amount');
  openModal('withdrawDemoModal');
}

function proceedWithdrawDemoToBank() {
  try {
    withdrawalDemoAmount();
    showWithdrawDemoStep('bank');
  } catch (error) {
    toast(error.message);
  }
}

function proceedWithdrawDemoToReview() {
  try {
    renderWithdrawDemoReview();
    showWithdrawDemoStep('review');
  } catch (error) {
    toast(error.message);
  }
}

function openAuthFlow() {
  if (state.auth.profile) return goTo('identity');
  if (state.auth.signedIn) return resumeOnboarding();
  showAuthStep('start');
  openModal('authModal');
}

function paymentQrUrl() {
  const username = state.auth.profile?.username;
  return username ? canonicalPaymentUrl(username) : null;
}

async function openPaymentQr() {
  const url = paymentQrUrl();
  if (!url) return openAuthFlow();
  const profile = state.auth.profile;
  $('#qrHandle').textContent = `@${profile.username}`;
  $('#qrPaymentUrl').textContent = url.replace(/^https?:\/\//, '');
  $('#qrPaymentStatus').textContent = '';
  $('#paymentQrImage').hidden = true;
  $('#paymentQrImage').removeAttribute('src');
  $('#paymentQrLoading').hidden = false;
  openModal('qrModal');

  try {
    if (!window.HandoffQr?.paymentPageDataUrl) throw new Error('QR code generator unavailable.');
    const dataUrl = await window.HandoffQr.paymentPageDataUrl(url);
    // A profile can change while the browser is producing the local image. Never reuse a stale QR.
    if (url !== paymentQrUrl()) return;
    currentPaymentQr = {
      dataUrl,
      url,
      username: profile.username,
      displayName: profile.displayName || profile.username
    };
    $('#paymentQrImage').src = dataUrl;
    $('#paymentQrImage').hidden = false;
    $('#paymentQrLoading').hidden = true;
  } catch (error) {
    console.warn('Handoff: QR code could not be created.', error);
    currentPaymentQr = null;
    $('#paymentQrLoading').hidden = true;
    $('#qrPaymentStatus').textContent = 'We could not create your QR code. Try again in a moment.';
  }
}

function copyPaymentQrLink() {
  const url = currentPaymentQr?.url || paymentQrUrl();
  if (!url) return openAuthFlow();
  copyText(url, 'Payment page copied');
}

function downloadPaymentQr() {
  if (!currentPaymentQr?.dataUrl || !currentPaymentQr?.username) return toast('Create your QR code first.');
  const link = document.createElement('a');
  link.href = currentPaymentQr.dataUrl;
  link.download = `handoff-${currentPaymentQr.username}-payment-qr.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function drawRoundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function loadCanvasImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The QR image could not be used.'));
    image.src = source;
  });
}

function fitPosterText(context, text, maxWidth, startSize, minSize = 44) {
  for (let size = startSize; size >= minSize; size -= 2) {
    context.font = `800 ${size}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
    if (context.measureText(text).width <= maxWidth) return size;
  }
  return minSize;
}

async function downloadPaymentPoster() {
  if (!currentPaymentQr?.dataUrl || !currentPaymentQr?.username) return toast('Create your QR code first.');
  const button = $('#downloadPaymentPoster');
  const qr = currentPaymentQr;
  button.disabled = true;
  button.textContent = 'Preparing poster…';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1440;
    canvas.height = 1800;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Poster graphics are unavailable in this browser.');

    // This is intentionally a local rendering: the QR payload remains only the canonical /@username URL.
    context.fillStyle = '#f5f5ee';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#cdf96d';
    context.beginPath();
    context.arc(1260, 150, 400, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#d9eeff';
    context.beginPath();
    context.arc(120, 1620, 330, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = '#101713';
    context.font = '800 66px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText('handoff', 116, 148);
    context.fillStyle = '#66705f';
    context.font = '700 28px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText('A SIMPLE WAY TO PAY', 120, 214);

    const name = String(qr.displayName || qr.username);
    const nameSize = fitPosterText(context, name, 1200, 124);
    context.fillStyle = '#101713';
    context.font = `800 ${nameSize}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
    context.fillText(name, 120, 430);
    context.fillStyle = '#60705a';
    context.font = '600 48px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillText(`@${qr.username}`, 124, 505);
    context.fillStyle = '#4e584b';
    context.font = '500 42px system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText('Scan to open my payment page', 124, 620);

    drawRoundedRect(context, 120, 725, 1200, 820, 58);
    context.fillStyle = '#ffffff';
    context.fill();
    context.strokeStyle = 'rgba(16, 23, 19, .08)';
    context.lineWidth = 3;
    context.stroke();

    const image = await loadCanvasImage(qr.dataUrl);
    context.drawImage(image, 285, 810, 870, 870);
    context.fillStyle = '#64705f';
    context.font = '600 29px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textAlign = 'center';
    context.fillText(qr.url.replace(/^https?:\/\//, ''), 720, 1702);
    context.textAlign = 'left';

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The poster could not be created.');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `handoff-${qr.username}-payment-poster.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Payment poster downloaded');
  } catch (error) {
    console.warn('Handoff: payment poster could not be created.', error);
    toast('We could not create your poster. Try again in a moment.');
  } finally {
    button.disabled = false;
    button.innerHTML = 'Download poster <span>✦</span>';
  }
}

function openProfileEditor() {
  const profile = state.auth.profile;
  if (!profile) return openAuthFlow();
  $('#displayNameInput').value = profile.displayName || profile.username;
  $('#profileEditorStatus').textContent = '';
  openModal('profileModal');
  $('#displayNameInput').focus();
}

async function saveProfileName() {
  const displayName = $('#displayNameInput').value;
  const button = $('#saveProfileName');
  button.disabled = true;
  button.textContent = 'Saving…';
  $('#profileEditorStatus').textContent = '';
  try {
    const data = await apiFetch('/api/me/profile', { method: 'PATCH', body: { displayName } });
    state.auth.profile = data.profile;
    // The QR payload itself cannot change, but its downloaded poster should always use the new name.
    currentPaymentQr = null;
    renderIdentity();
    closeModals();
    toast('Your public payment profile is updated.');
  } catch (error) {
    if (error.status === 401) return expireSession();
    $('#profileEditorStatus').textContent = error.message || 'We could not save your display name.';
    toast(error.message || 'We could not save your display name.');
  } finally {
    button.disabled = false;
    button.innerHTML = 'Save display name <span>→</span>';
  }
}

function showHandoffSendStep(name) {
  $$('.modal-step', $('#handoffSendModal')).forEach(step => step.classList.toggle('active', step.dataset.handoffSendStep === name));
}

function stopHandoffSendPolling() {
  if (state.handoffSend.polling) clearTimeout(state.handoffSend.polling);
  state.handoffSend.polling = null;
}

function renderHandoffSendAvailability() {
  const button = $('#sendFromBalance');
  if (!button) return;
  button.disabled = false;
  button.removeAttribute('aria-disabled');
  button.innerHTML = 'Send money <span>→</span>';
  button.title = state.features.handoffTransfers.available
    ? 'Send money to another Handoff username'
    : 'Send money is being prepared';
}

function openHandoffSend() {
  if (!state.auth.profile) return openAuthFlow();
  if (!state.features.handoffTransfers.available) {
    return toast('Send money will open once Handoff’s sending-fee account is ready.');
  }
  stopHandoffSendPolling();
  state.handoffSend = { intent: null, signature: null, busy: false, polling: null };
  $('#handoffSendRecipient').value = '';
  $('#handoffSendAmount').value = '10.00';
  $('#handoffSendChooseStatus').textContent = '';
  $('#handoffSendReviewStatus').textContent = '';
  $('#handoffSendLimit').textContent = `Maximum $${Number(state.features.handoffTransfers.maximumPerTransferUsdc || 25).toFixed(2)} per transfer.`;
  showHandoffSendStep('choose');
  openModal('handoffSendModal');
  $('#handoffSendRecipient').focus();
}

function setHandoffSendBusy(button, busy, label) {
  state.handoffSend.busy = busy;
  button.disabled = busy;
  if (label) button.innerHTML = label;
}

async function prepareHandoffSend() {
  const recipientHandle = $('#handoffSendRecipient').value.trim();
  const amount = $('#handoffSendAmount').value.trim();
  const button = $('#prepareHandoffSend');
  setHandoffSendBusy(button, true, 'Preparing…');
  $('#handoffSendChooseStatus').textContent = '';
  try {
    const intent = await apiFetch('/api/handoff-transfers/intent', {
      method: 'POST', body: { recipientHandle, amount }
    });
    state.handoffSend.intent = intent;
    state.handoffSend.signature = null;
    $('#handoffSendReviewAmount').textContent = `$${intent.amount}`;
    $('#handoffSendReviewRecipient').textContent = `${intent.recipient.displayName} · @${intent.recipient.username}`;
    $('#handoffSendReviewStatus').textContent = '';
    showHandoffSendStep('review');
  } catch (error) {
    if (error.status === 401) return expireSession();
    $('#handoffSendChooseStatus').textContent = error.message || 'We could not prepare this transfer.';
  } finally {
    setHandoffSendBusy(button, false, 'Review payment <span>→</span>');
  }
}

function showHandoffSendProgress(copy = 'We are checking that the exact amount arrives.') {
  $('#handoffSendProgressTitle').textContent = 'Completing your payment…';
  $('#handoffSendProgressCopy').textContent = copy;
  $('#retryHandoffSend').hidden = true;
  showHandoffSendStep('progress');
}

function showHandoffSendRetry(message) {
  $('#handoffSendProgressTitle').textContent = 'Your payment needs another try.';
  $('#handoffSendProgressCopy').textContent = message || 'No money has been marked as sent.';
  $('#retryHandoffSend').hidden = false;
  showHandoffSendStep('progress');
}

function applyHandoffSendStatus(transfer) {
  if (!transfer) return;
  if (transfer.status === 'settled') {
    stopHandoffSendPolling();
    $('#handoffSendDoneCopy').textContent = `$${transfer.amount} was sent to @${transfer.recipient.username} and confirmed.`;
    showHandoffSendStep('done');
    refreshPortfolio();
    return;
  }
  if (transfer.final) {
    stopHandoffSendPolling();
    showHandoffSendRetry(transfer.message || 'This transfer could not be completed.');
    return;
  }
  showHandoffSendProgress(transfer.message || 'We are checking that the exact amount arrives.');
  pollHandoffSendStatus();
}

function pollHandoffSendStatus() {
  stopHandoffSendPolling();
  const transferId = state.handoffSend.intent?.transferId;
  if (!transferId) return;
  state.handoffSend.polling = setTimeout(async () => {
    try {
      const transfer = await apiFetch(`/api/handoff-transfers/${encodeURIComponent(transferId)}`);
      applyHandoffSendStatus(transfer);
    } catch (error) {
      if (error.status === 401) return expireSession();
      // A temporary connection issue must not turn a still-broadcast transfer into a false failure.
      showHandoffSendProgress('Still confirming your transfer. Keep this page open and we will update it.');
      pollHandoffSendStatus();
    }
  }, 2500);
}

async function confirmHandoffSend() {
  const intent = state.handoffSend.intent;
  if (!intent?.transferId || !intent.authorization) return showHandoffSendStep('choose');
  const button = $('#confirmHandoffSend');
  setHandoffSendBusy(button, true, 'Checking approval…');
  $('#handoffSendReviewStatus').textContent = '';
  try {
    // The exact, server-generated typed message is signed by Dynamic. No amount, recipient, or
    // account detail from the page is accepted by the server when it receives the signature.
    const signature = state.handoffSend.signature || await window.HandoffDynamic?.signTransferAuthorization?.(intent.authorization);
    if (!signature) throw new Error('We could not approve this payment.');
    state.handoffSend.signature = signature;
    showHandoffSendProgress('Completing your approved payment…');
    const transfer = await apiFetch(`/api/handoff-transfers/${encodeURIComponent(intent.transferId)}/authorization`, {
      method: 'POST', body: { signature }
    });
    applyHandoffSendStatus(transfer);
  } catch (error) {
    if (error.status === 401) return expireSession();
    if (error?.code === 4001 || /rejected|declined/i.test(error?.message || '')) {
      $('#handoffSendReviewStatus').textContent = 'You did not confirm this transfer. Nothing was sent.';
      showHandoffSendStep('review');
    } else {
      showHandoffSendRetry(error.message || 'We could not send this transfer yet.');
    }
  } finally {
    setHandoffSendBusy(button, false, 'Approve payment <span>→</span>');
  }
}

async function initialiseDynamic() {
  try {
    const response = await fetch('/api/public-config');
    if (!response.ok) throw new Error('Unable to load public sign-in configuration.');
    const runtime = await response.json();
    applyPaymentConfig(runtime.payments);
    state.features.handoffTransfers = {
      available: Boolean(runtime.handoffTransfers?.available),
      maximumPerTransferUsdc: Number(runtime.handoffTransfers?.maximumPerTransferUsdc || 25)
    };
    renderHandoffSendAvailability();
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
    toast(`@${data.profile.username} is ready to get paid.`);
    refreshPortfolio();
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

function showPaymentRequestStep(name) {
  $$('[data-request-step]').forEach(step => step.classList.toggle('active', step.dataset.requestStep === name));
}
function openPaymentRequest() {
  if (!state.auth.profile) return openAuthFlow();
  $('#paymentRequestAmount').value = '10.00';
  $('#paymentRequestNote').value = '';
  $('#paymentRequestExpiry').value = '7';
  $('#paymentRequestStatus').textContent = '';
  showPaymentRequestStep('form');
  openModal('paymentRequestModal');
}
async function createPaymentRequest() {
  const button = $('#createPaymentRequest');
  button.disabled = true; button.textContent = 'Creating…';
  $('#paymentRequestStatus').textContent = '';
  try {
    const created = await apiFetch('/api/me/payment-requests', { method: 'POST', body: {
      amount: $('#paymentRequestAmount').value.trim(), note: $('#paymentRequestNote').value.trim(), expiresInDays: Number($('#paymentRequestExpiry').value)
    } });
    const link = `${canonicalPaymentUrl(state.auth.profile.username)}?request=${encodeURIComponent(created.id)}`;
    state.paymentRequests.loaded = false;
    refreshPaymentRequests({ force: true });
    $('#paymentRequestSummary').textContent = `$${created.amount} requested${created.note ? ` · ${created.note}` : ''}. Expires ${new Date(created.expiresAt).toLocaleDateString()}.`;
    $('#paymentRequestLink').textContent = link;
    $('#paymentRequestQrImage').hidden = true;
    $('#paymentRequestQrImage').removeAttribute('src');
    $('#paymentRequestQrStatus').textContent = 'Preparing a QR code…';
    showPaymentRequestStep('ready');
    try {
      if (!window.HandoffQr?.paymentPageDataUrl) throw new Error('QR code generator unavailable.');
      const dataUrl = await window.HandoffQr.paymentPageDataUrl(link);
      if ($('#paymentRequestLink').textContent !== link) return;
      $('#paymentRequestQrImage').src = dataUrl;
      $('#paymentRequestQrImage').hidden = false;
      $('#paymentRequestQrStatus').textContent = '';
    } catch {
      $('#paymentRequestQrStatus').textContent = 'Your link is ready to share. The QR code could not be created just now.';
    }
  } catch (error) {
    if (error.status === 401) return expireSession();
    $('#paymentRequestStatus').textContent = error.message || 'We could not create this request.';
  } finally {
    button.disabled = false; button.innerHTML = 'Create request <span>→</span>';
  }
}

function bindEvents() {
  $$('.nav-item, .mobile-nav-item').forEach(item => item.addEventListener('click', () => goTo(item.dataset.page)));
  $$('[data-go]').forEach(item => item.addEventListener('click', () => goTo(item.dataset.go)));
  const sharePaymentPage = () => state.auth.profile ? copyText(canonicalPaymentUrl(state.auth.profile.username), 'Payment page copied') : openAuthFlow();
  $('#quickRequest').addEventListener('click', openPaymentRequest);
  $('#requestFromBalance').addEventListener('click', openPaymentRequest);
  $('#withdrawFromBalance').addEventListener('click', openWithdrawDemo);
  $('#withdrawDemoToBank').addEventListener('click', proceedWithdrawDemoToBank);
  $('#withdrawDemoBackToAmount').addEventListener('click', () => showWithdrawDemoStep('amount'));
  $('#withdrawDemoReview').addEventListener('click', proceedWithdrawDemoToReview);
  $('#withdrawDemoBackToBank').addEventListener('click', () => showWithdrawDemoStep('bank'));
  $('#completeWithdrawDemo').addEventListener('click', () => showWithdrawDemoStep('done'));
  $('#createRequest').addEventListener('click', openPaymentRequest);
  $('#createFixedRequest').addEventListener('click', openPaymentRequest);
  $('#refreshPaymentRequests').addEventListener('click', () => refreshPaymentRequests({ force: true }));
  $('#createPaymentRequest').addEventListener('click', createPaymentRequest);
  $('#copyPaymentRequest').addEventListener('click', () => copyText($('#paymentRequestLink').textContent, 'Payment request copied'));
  $('#sharePaidPage').addEventListener('click', sharePaymentPage);
  $('#showPaymentQr').addEventListener('click', openPaymentQr);
  $('#copyPaymentQrLink').addEventListener('click', copyPaymentQrLink);
  $('#downloadPaymentQr').addEventListener('click', downloadPaymentQr);
  $('#downloadPaymentPoster').addEventListener('click', downloadPaymentPoster);
  // A signed-in Handoff recipient can send an exact amount to another canonical Handoff username.
  // External-wallet checkout remains available only from public /@username pages.
  $('#sendFromBalance').addEventListener('click', openHandoffSend);
  $('#prepareHandoffSend').addEventListener('click', prepareHandoffSend);
  $('#handoffSendBack').addEventListener('click', () => showHandoffSendStep('choose'));
  $('#confirmHandoffSend').addEventListener('click', confirmHandoffSend);
  $('#retryHandoffSend').addEventListener('click', confirmHandoffSend);
  $('#openIdentity').addEventListener('click', () => state.auth.profile ? goTo('identity') : openAuthFlow());
  $('#toggleBalance').addEventListener('click', () => { state.balanceVisible = !state.balanceVisible; renderBalance(); });
  $('#displayCurrency').addEventListener('change', event => setDisplayCurrency(event.target.value));
  $('#copyHandle').addEventListener('click', () => state.auth.profile ? copyText(`@${state.auth.profile.username}`, 'Handoff username copied') : openAuthFlow());
  $('#copyPublicLink').addEventListener('click', () => state.auth.profile ? copyText(canonicalPaymentUrl(state.auth.profile.username), 'Payment page copied') : openAuthFlow());
  $('#shareProfile').addEventListener('click', () => state.auth.profile ? copyText(canonicalPaymentUrl(state.auth.profile.username), 'Payment page copied') : openAuthFlow());
  $('#editProfile').addEventListener('click', openProfileEditor);
  $('#saveProfileName').addEventListener('click', saveProfileName);
  $('#displayNameInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveProfileName();
    }
  });
  $('#profileButton').addEventListener('click', () => state.auth.profile ? goTo('identity') : openAuthFlow());
  $('#authButton').addEventListener('click', () => state.auth.signedIn ? signOut() : openAuthFlow());
  $('#openSecurity').addEventListener('click', () => toast('Handoff keeps getting paid simple: sign in securely and share your username.'));
  $('#openNotifications').addEventListener('click', () => toast('Payment updates appear here after they are confirmed.'));
  $('#mobileMenu').addEventListener('click', toggleMobileDrawer);
  $('#closeMobileMenu').addEventListener('click', closeMobileDrawer);
  $('#mobileDrawerBackdrop').addEventListener('click', closeMobileDrawer);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMobileDrawer();
  });
  $('#modalBackdrop').addEventListener('click', closeModals);
  $$('[data-close]').forEach(button => button.addEventListener('click', closeModals));
  $('#toNetworks').addEventListener('click', async () => {
    try { await resolveRecipient(); renderNetworkPicker(); showPayStep('network'); }
    catch (error) { toast(error.message); }
  });
  $('#backToChoose').addEventListener('click', () => showPayStep('choose'));
  $('#backToNetworks').addEventListener('click', () => {
    if (paymentInProgress()) return toast('This payment is still in progress. Its receipt updates here.');
    resetPaymentFlow();
    showPayStep('network');
  });
  $('#getQuote').addEventListener('click', requestQuote);
  $('#signPay').addEventListener('click', signAndPay);
  $('#shareReceipt').addEventListener('click', () => {
    const paymentId = state.payment.receipt?.paymentId;
    if (paymentId) copyText(shareableReceiptUrl(paymentId), 'Receipt link copied');
  });
  $('#payAmount').addEventListener('input', () => {
    if (!state.selectedNetwork || paymentInProgress()) return;
    resetPaymentFlow();
    prepareQuote(state.selectedNetwork);
  });
  $('#continueWithEmail').addEventListener('click', continueWithEmail);
  $('#retryWalletSetup').addEventListener('click', retryWalletSetup);
  $('#registerPasskey').addEventListener('click', registerPasskey);
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
  state.displayCurrency = savedDisplayCurrency();
  $('#displayCurrency').value = state.displayCurrency;
  renderActivity();
  renderBalance();
  renderIdentity();
  renderHandoffSendAvailability();
  renderRecipientProof();
  renderRails();
  renderNetworkPicker();
  bindEvents();
  refreshRoutes(true);
  initialiseDynamic();
  if (state.displayCurrency !== 'USD') loadDisplayRates();
}
init();
