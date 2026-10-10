const { config } = require('./config');

function assertConfigured() {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    const error = new Error('Database is not configured. Add Supabase server credentials in the deployment environment.');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  assertConfigured();
  let response;
  try {
    response = await fetch(`${config.supabase.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: config.supabase.serviceRoleKey,
        Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    // Fail closed with 503 rather than a generic 400 or a leaked transport error.
    const error = new Error('The Handoff database is temporarily unreachable. Try again shortly.');
    error.code = 'DATABASE_UNAVAILABLE';
    error.status = 503;
    throw error;
  }
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = raw; }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.hint || 'Supabase request failed.');
    error.status = response.status;
    error.details = payload;
    throw error;
  }
  return payload;
}

module.exports = { request };
