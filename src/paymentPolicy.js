// Payment caps and amount rules. These mirror reserve_payment_attempt() in migration 0003.
// The database function is the authority at reservation time; this module gives the same answer
// earlier so the API can refuse an over-cap request before it calls Relay.

const DAY_MS = 24 * 60 * 60 * 1000;
const USDC_DECIMALS = 6;
const SETTLEMENT_OPEN_STATES = new Set(['failed', 'refunded']);

function policyError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// "25", "25.5", "0.000001". Rejects signs, exponents, separators, and more than six decimals.
function parseUsdcAmount(input) {
  const clean = String(input ?? '').trim();
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(clean)) {
    throw policyError('Enter a payment amount in USDC with up to six decimals.', 'AMOUNT_INVALID');
  }
  const [whole, fraction = ''] = clean.split('.');
  const minor = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt((fraction + '000000').slice(0, USDC_DECIMALS));
  if (minor <= 0n) throw policyError('Enter a payment amount greater than zero.', 'AMOUNT_INVALID');
  return minor;
}

function formatUsdc(minor) {
  const value = BigInt(minor);
  const whole = value / 10n ** BigInt(USDC_DECIMALS);
  const fraction = (value % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, '0').slice(0, 2);
  return `${whole.toString()}.${fraction}`;
}

function assertPerPaymentCap(amountMinor, perPaymentMinor) {
  if (BigInt(amountMinor) > BigInt(perPaymentMinor)) {
    throw policyError(`A single payment can be at most ${formatUsdc(perPaymentMinor)} USDC.`, 'PER_PAYMENT_CAP_EXCEEDED');
  }
}

// Same rule as the SQL: an attempt counts for 24 hours if a source transaction was recorded, or if
// its quote is still live and it has not failed or been refunded.
function countsTowardDailyCap(attempt, nowMs = Date.now()) {
  const createdMs = Date.parse(attempt.created_at);
  if (!Number.isFinite(createdMs) || nowMs - createdMs > DAY_MS || createdMs > nowMs + 60_000) return false;
  if (attempt.source_tx_hash) return true;
  const expiresMs = Date.parse(attempt.quote_expires_at || '');
  return !SETTLEMENT_OPEN_STATES.has(attempt.status) && Number.isFinite(expiresMs) && expiresMs > nowMs;
}

function dailyUsageMinor(attempts, nowMs = Date.now()) {
  return attempts
    .filter(attempt => countsTowardDailyCap(attempt, nowMs))
    .reduce((sum, attempt) => sum + toMinor(attempt.source_amount), 0n);
}

function dailyCapError(dailyMinor) {
  return policyError(
    `This wallet has reached the ${formatUsdc(dailyMinor)} USDC rolling daily limit. Try again once earlier payments fall outside the last 24 hours.`,
    'DAILY_CAP_EXCEEDED',
    429
  );
}

function assertWithinDailyCap({ amountMinor, usedMinor, dailyMinor }) {
  if (BigInt(usedMinor) + BigInt(amountMinor) > BigInt(dailyMinor)) throw dailyCapError(dailyMinor);
}

// Source amounts arrive from PostgREST as numeric strings in minor units.
function toMinor(value) {
  if (typeof value === 'bigint') return value;
  const text = String(value ?? '0');
  if (!/^\d+(\.0+)?$/.test(text)) return 0n;
  return BigInt(text.split('.')[0]);
}

module.exports = {
  DAY_MS,
  parseUsdcAmount,
  formatUsdc,
  assertPerPaymentCap,
  countsTowardDailyCap,
  dailyUsageMinor,
  assertWithinDailyCap,
  dailyCapError,
  policyError,
  toMinor
};
