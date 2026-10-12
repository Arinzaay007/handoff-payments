const test = require('node:test');
const assert = require('node:assert/strict');
const { DISPLAY_RATE_URL, fetchDisplayRates, normalizeRates } = require('../src/displayRates');

test('display rates include only the supported reference currencies and are based on USD', () => {
  const rates = normalizeRates({ rates: { NGN: 1500, GBP: 0.79, INR: 83, EUR: 0.91 } }, Date.UTC(2026, 9, 13));
  assert.deepEqual(rates.rates, { USD: 1, NGN: 1500, GBP: 0.79, INR: 83 });
  assert.equal(rates.base, 'USD');
  assert.equal(rates.referenceOnly, true);
});

test('display rates fail closed when a currency is absent instead of inventing an exchange value', () => {
  assert.throws(
    () => normalizeRates({ rates: { NGN: 1500, GBP: 0.79 } }, Date.now()),
    error => error.code === 'DISPLAY_RATES_UNAVAILABLE'
  );
});

test('display rates use the fixed server-side provider URL', async () => {
  let requestedUrl = null;
  const rates = await fetchDisplayRates({
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ rates: { NGN: 1500, GBP: 0.79, INR: 83 } }), { status: 200 });
    },
    now: () => Date.UTC(2026, 9, 13)
  });
  assert.equal(requestedUrl, DISPLAY_RATE_URL);
  assert.equal(rates.rates.NGN, 1500);
});
