// Reference-only fiat display rates for the owner dashboard. These rates never affect a payment,
// a Send money authorization, a withdrawal, or the actual USDC balance. If the provider is
// unavailable, callers must keep showing the honest USD value rather than inventing a conversion.
const DISPLAY_CURRENCIES = Object.freeze(['USD', 'NGN', 'GBP', 'INR']);
const DISPLAY_RATE_URL = 'https://open.er-api.com/v6/latest/USD';
const CACHE_MS = 30 * 60 * 1000;

let cached = null;
let pending = null;

function validRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeRates(payload, checkedAt) {
  const source = payload?.rates;
  const rates = { USD: 1 };
  for (const currency of DISPLAY_CURRENCIES.slice(1)) {
    if (!validRate(source?.[currency])) {
      const error = new Error('Display-rate provider did not return all requested currencies.');
      error.code = 'DISPLAY_RATES_UNAVAILABLE';
      throw error;
    }
    rates[currency] = source[currency];
  }
  return Object.freeze({
    base: 'USD',
    rates: Object.freeze(rates),
    checkedAt: new Date(checkedAt).toISOString(),
    referenceOnly: true
  });
}

async function fetchDisplayRates({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') {
    const error = new Error('Display-rate provider is unavailable.');
    error.code = 'DISPLAY_RATES_UNAVAILABLE';
    throw error;
  }
  const response = await fetchImpl(DISPLAY_RATE_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response?.ok) {
    const error = new Error('Display-rate provider is unavailable.');
    error.code = 'DISPLAY_RATES_UNAVAILABLE';
    throw error;
  }
  return normalizeRates(await response.json(), now());
}

async function getDisplayRates(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.value;
  if (!pending) {
    pending = fetchDisplayRates({ ...options, now: () => now })
      .then(value => {
        cached = { value, fetchedAt: now };
        return value;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}

function resetDisplayRateCache() {
  cached = null;
  pending = null;
}

module.exports = { DISPLAY_CURRENCIES, DISPLAY_RATE_URL, CACHE_MS, normalizeRates, fetchDisplayRates, getDisplayRates, resetDisplayRateCache };
