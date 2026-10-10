require('./env');

function required(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
  limits: {
    maxMainnetUsdcMinor: BigInt(required('MAX_MAINNET_USDC_MINOR') || '25000000'),
    maxDailyMainnetUsdcMinor: BigInt(required('MAX_DAILY_MAINNET_USDC_MINOR') || '100000000')
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
