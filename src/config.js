require('./env');

function required(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Parses a cap from the environment and clamps it to the launch ceiling.
function capMinor(raw, ceiling) {
  if (!raw || !/^\d+$/.test(String(raw).trim())) return ceiling;
  const value = BigInt(String(raw).trim());
  return value > ceiling ? ceiling : value;
}

const config = Object.freeze({
  dynamic: {
    environmentId: required('DYNAMIC_ENVIRONMENT_ID') || required('NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID'),
    // Retained for deployments that pin Dynamic's dashboard public key. JWT verification
    // uses Dynamic's public JWKS endpoint and never needs a bearer token in the browser.
    publicKey: required('DYNAMIC_PUBLIC_CLIENT_KEY') || required('DYNAMIC_PUBLIC_KEY'),
    bearerToken: required('DYNAMIC_BEARER_TOKEN') || required('NEXT_DYNAMIC_BEARER_TOKEN')
  },
  supabase: {
    url: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY') || required('SUPABASE_PUBLISHABLE_KEY'),
    // New Supabase projects call this a secret key; legacy projects call it service_role.
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY') || required('SUPABASE_SECRET_KEY')
  },
  relay: {
    // Server-only. Relay requires this key on quote/v2 from 2 October 2026. Never sent to the browser.
    apiKey: required('RELAY_API_KEY')
  },
  monad: {
    // Read-only JSON-RPC used to verify the Monad USDC Transfer before a payment is shown as settled.
    rpcUrl: required('MONAD_RPC_URL') || 'https://rpc.monad.xyz'
  },
  limits: {
    // Hard launch ceilings: 25 USDC per payment and 100 USDC rolling 24h. Environment values can only
    // lower these, never raise them.
    maxMainnetUsdcMinor: capMinor(required('MAX_MAINNET_USDC_MINOR'), 25_000_000n),
    maxDailyMainnetUsdcMinor: capMinor(required('MAX_DAILY_MAINNET_USDC_MINOR'), 100_000_000n)
  }
});

function mainnetGuards() {
  return {
    maximumPaymentUsdc: Number(config.limits.maxMainnetUsdcMinor) / 1_000_000,
    maximumDailyUsdc: Number(config.limits.maxDailyMainnetUsdcMinor) / 1_000_000
  };
}

function status() {
  return {
    dynamicConfigured: Boolean(config.dynamic.environmentId),
    databaseConfigured: Boolean(config.supabase.url && config.supabase.serviceRoleKey),
    relayConfigured: Boolean(config.relay.apiKey),
    mainnetGuards: mainnetGuards()
  };
}

/** Public-by-design browser configuration. Never add any key or token here. */
function publicRuntimeConfig() {
  return {
    dynamic: {
      enabled: Boolean(config.dynamic.environmentId),
      environmentId: config.dynamic.environmentId
    },
    mainnetGuards: mainnetGuards()
  };
}

module.exports = { config, status, publicRuntimeConfig };
