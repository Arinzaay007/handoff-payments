// Persisted merchant payment requests. A request is an exact, expiring payment instruction tied to
// its owner's canonical Handoff profile. It is not a stored address, a quote, or a balance change.
const { randomUUID } = require('crypto');
const { request } = require('./supabase');
const { getProfileForSubject } = require('./profileService');
const { parseUsdcAmount, formatUsdc } = require('./paymentPolicy');
const { config } = require('./config');

const PUBLIC_ID_RE = /^rq_[a-z0-9]{16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EXPIRY_DAYS = 30;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function serviceError(message, code, status = 400) {
  const error = new Error(message); error.code = code; error.status = status; return error;
}
function firstRow(value) { return Array.isArray(value) ? value[0] || null : value || null; }
function publicId() { return `rq_${randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function validateMemo(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw serviceError('Enter a short note.', 'REQUEST_NOTE_INVALID');
  const memo = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!memo || Array.from(memo).length > 140) throw serviceError('Notes can be up to 140 characters.', 'REQUEST_NOTE_INVALID');
  return memo;
}
function expiry(value) {
  const days = value === undefined ? 7 : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) throw serviceError(`Choose an expiry between 1 and ${MAX_EXPIRY_DAYS} days.`, 'REQUEST_EXPIRY_INVALID');
  return new Date(Date.now() + days * 86400000).toISOString();
}
function publicRequest(row) {
  return {
    id: row.public_id,
    amount: formatUsdc(row.requested_amount_minor),
    note: row.memo || null,
    status: row.status,
    expiresAt: row.expires_at,
    paidAt: row.paid_at || null,
    createdAt: row.created_at,
    recipient: row.profiles ? { username: row.profiles.username, displayName: row.profiles.display_name || row.profiles.username } : undefined
  };
}
async function owner(user) {
  const profile = await getProfileForSubject(user.subject);
  if (!profile?.walletId) throw serviceError('Claim your Handoff name before creating a request.', 'PROFILE_NOT_READY', 409);
  return profile;
}
async function createPaymentRequest({ user, amount, note, expiresInDays }) {
  const profile = await owner(user);
  const minor = parseUsdcAmount(amount);
  if (minor > config.limits.maxMainnetUsdcMinor) throw serviceError(`A request can be at most ${formatUsdc(config.limits.maxMainnetUsdcMinor)} USD.`, 'REQUEST_AMOUNT_INVALID');
  const row = firstRow(await request('payment_requests', { method: 'POST', body: {
    public_id: publicId(), recipient_profile_id: profile.id, recipient_wallet_id: profile.walletId,
    requested_amount_minor: minor.toString(), memo: validateMemo(note), expires_at: expiry(expiresInDays), status: 'active'
  } }));
  if (!row) throw serviceError('We could not create this request. Try again.', 'REQUEST_CREATE_FAILED', 503);
  return publicRequest(row);
}
async function listPaymentRequests({ user }) {
  const profile = await owner(user);
  const rows = await request(`payment_requests?select=public_id,requested_amount_minor,memo,status,expires_at,paid_at,created_at&recipient_profile_id=eq.${encodeURIComponent(profile.id)}&order=created_at.desc&limit=50`);
  return Array.isArray(rows) ? rows.map(publicRequest) : [];
}
async function findRequest(publicIdValue) {
  if (!PUBLIC_ID_RE.test(String(publicIdValue || ''))) throw serviceError('Payment request not found.', 'REQUEST_NOT_FOUND', 404);
  const row = firstRow(await request(`payment_requests?select=id,public_id,recipient_profile_id,recipient_wallet_id,requested_amount_minor,memo,status,expires_at,paid_at,created_at,profiles!payment_requests_recipient_profile_id_fkey(username,display_name)&public_id=eq.${encodeURIComponent(publicIdValue)}&limit=1`));
  if (!row) throw serviceError('Payment request not found.', 'REQUEST_NOT_FOUND', 404);
  return row;
}
async function getPublicPaymentRequest(publicIdValue) {
  const row = await findRequest(publicIdValue);
  // Presentation expiry is deliberately conservative: a valid pre-expiry payment can still be
  // routing, and the database settlement trigger changes that request to paid once verified.
  if (row.status === 'active' && row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    await request(`payment_requests?public_id=eq.${encodeURIComponent(row.public_id)}&status=eq.active`, { method: 'PATCH', body: { status: 'expired' } });
    row.status = 'expired';
  }
  return publicRequest(row);
}
async function quoteBinding(publicIdValue) {
  const row = await findRequest(publicIdValue);
  if (row.status !== 'active') throw serviceError('This payment request is no longer available.', 'REQUEST_NOT_ACTIVE', 409);
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    throw serviceError('This payment request has expired.', 'REQUEST_EXPIRED', 409);
  }
  if (!row.profiles?.username || !row.recipient_profile_id || !row.recipient_wallet_id || row.requested_amount_minor == null) {
    throw serviceError('This payment request is not ready to pay.', 'REQUEST_INVALID', 409);
  }
  // The request's saved wallet row, rather than browser input or a newer arbitrary name lookup,
  // is the recipient for this exact request. This address remains server-internal.
  const wallet = firstRow(await request(`recipient_wallets?select=wallet_address&id=eq.${encodeURIComponent(row.recipient_wallet_id)}&profile_id=eq.${encodeURIComponent(row.recipient_profile_id)}&chain_id=eq.143&is_active=is.true&limit=1`));
  if (!EVM_ADDRESS_RE.test(String(wallet?.wallet_address || ''))) {
    throw serviceError('This payment request is not ready to pay.', 'REQUEST_INVALID', 409);
  }
  return {
    id: row.public_id,
    amountMinor: String(row.requested_amount_minor),
    recipient: {
      profileId: row.recipient_profile_id,
      walletId: row.recipient_wallet_id,
      recipient: wallet.wallet_address.toLowerCase(),
      username: row.profiles.username,
      displayName: row.profiles.display_name || row.profiles.username
    }
  };
}
async function cancelPaymentRequest({ user, publicId: id }) {
  const profile = await owner(user);
  if (!PUBLIC_ID_RE.test(String(id || ''))) throw serviceError('Payment request not found.', 'REQUEST_NOT_FOUND', 404);
  let row;
  try {
    row = firstRow(await request('rpc/cancel_fixed_payment_request', { method: 'POST', body: { p_payment_request_public_id: id, p_recipient_profile_id: profile.id } }));
  } catch (error) {
    if (String(error?.message || '') === 'REQUEST_PAYMENT_IN_PROGRESS') throw serviceError('This request already has a payment in progress and cannot be cancelled.', 'REQUEST_PAYMENT_IN_PROGRESS', 409);
    if (String(error?.message || '') === 'REQUEST_NOT_ACTIVE') throw serviceError('This payment request is no longer active.', 'REQUEST_NOT_ACTIVE', 409);
    throw error;
  }
  if (!row) throw serviceError('This payment request is no longer active.', 'REQUEST_NOT_ACTIVE', 409);
  return publicRequest(row);
}
module.exports = { createPaymentRequest, listPaymentRequests, getPublicPaymentRequest, quoteBinding, cancelPaymentRequest, publicRequest, validateMemo, expiry };
