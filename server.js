const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { status: configurationStatus, publicRuntimeConfig } = require('./src/config');
const { resolveUsername } = require('./src/usernameService');
const { requireDynamicUser, requireEmbeddedWallet, hasEmbeddedWallet } = require('./src/dynamicAuth');
const { getProfileForSubject, claimProfile } = require('./src/profileService');
const { getPublicProfile } = require('./src/publicProfile');

const root = path.join(__dirname, 'public');
const PAYMENT_PAGE_PATH = /^\/@([^/]+)\/?$/;
const port = Number(process.env.PORT || 3000);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  res.end(body);
}

function sendError(res, error) {
  let status = error.status || 400;
  let message = error.message || 'Request failed.';
  if (error.code === 'DATABASE_NOT_CONFIGURED' || error.code === 'DATABASE_UNAVAILABLE') status = 503;
  if (error.details?.code === 'PGRST202') {
    status = 503;
    message = 'The profile-claim database migration has not been applied yet.';
  }
  if (error.details?.code === '23505') status = 409;
  if (error.details?.code === 'P0001') status = 409;
  const body = { message };
  // Stable machine-readable code for our own errors (never a raw provider message).
  if (error.code && /^[A-Z_]+$/.test(error.code)) body.code = error.code;
  return send(res, status, JSON.stringify(body));
}

// Canonical payment page: GET /@username. The shell is the same app; the server only injects
// the public handle, and the page itself fetches display-safe data from /api/public/profile.
let shellTemplate = null;
async function readShell() {
  if (!shellTemplate) shellTemplate = await fs.promises.readFile(path.join(root, 'index.html'), 'utf8');
  return shellTemplate;
}

function notFoundPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <title>Handoff — Payment page not found</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body class="public-mode">
  <main id="publicNotFound" class="public-notfound">
    <span class="label">HANDOFF</span>
    <h1>No payment page here.</h1>
    <p>This Handoff username is not registered, or it is not ready to receive USDC on Monad yet.</p>
    <a class="button button-dark" href="/">Go to Handoff <span>→</span></a>
  </main>
</body>
</html>
`;
}

async function servePaymentPage(req, res, rawHandle) {
  let profile = null;
  try {
    profile = await getPublicProfile(decodeURIComponent(rawHandle));
  } catch (error) {
    if (error.code === 'DATABASE_NOT_CONFIGURED' || error.code === 'DATABASE_UNAVAILABLE' || error.status >= 500) {
      return send(res, 503, 'Handoff payment pages are temporarily unavailable. Try again shortly.', 'text/plain; charset=utf-8');
    }
    // A malformed handle (bad percent-encoding or invalid characters) is simply not registered.
  }
  if (!profile) {
    return send(res, 200, req.method === 'HEAD' ? '' : notFoundPage(), 'text/html; charset=utf-8');
  }
  // profile.username is validated to [a-z0-9_]{3,24}, so it is safe to place in the markup.
  const shell = (await readShell())
    .replace('<title>Handoff — Omnichain payment identity</title>', `<title>Pay @${profile.username} on Handoff</title>`)
    .replace('<body>', `<body class="public-mode" data-public-handle="${profile.username}">`);
  return send(res, 200, req.method === 'HEAD' ? '' : shell, 'text/html; charset=utf-8');
}

function relayRequest(method, relayPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const request = https.request({
      hostname: 'api.relay.link',
      path: relayPath,
      method,
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      } : {}
    }, (response) => {
      let out = '';
      response.on('data', (chunk) => { out += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 502, body: out }));
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('Relay request timed out')));
    if (body) request.write(body);
    request.end();
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 100000) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, JSON.stringify(configurationStatus()));
  }

  if (req.method === 'GET' && url.pathname === '/api/public-config') {
    return send(res, 200, JSON.stringify(publicRuntimeConfig()));
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    try {
      const user = await requireDynamicUser(req.headers.authorization);
      const profile = await getProfileForSubject(user.subject);
      // Never return wallet addresses here: onboarding must not expose the recipient wallet.
      return send(res, 200, JSON.stringify({ profile, email: user.email }));
    } catch (error) {
      return sendError(res, error);
    }
  }

  // Boolean readiness only. The client polls this while Dynamic provisions the embedded wallet.
  if (req.method === 'GET' && url.pathname === '/api/me/wallet-status') {
    try {
      const user = await requireDynamicUser(req.headers.authorization);
      return send(res, 200, JSON.stringify({ ready: hasEmbeddedWallet(user) }));
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/me/claim') {
    try {
      const user = await requireDynamicUser(req.headers.authorization);
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, JSON.stringify({ message: 'Send a Handoff username.' }));
      }
      // The only accepted field is username. Any other field, including walletAddress, is rejected
      // so a browser can never choose the recipient.
      const extraFields = Object.keys(body).filter(key => key !== 'username');
      if (extraFields.length) {
        return send(res, 400, JSON.stringify({ message: 'Only a Handoff username can be submitted.' }));
      }
      if (typeof body.username !== 'string') {
        return send(res, 400, JSON.stringify({ message: 'Choose a Handoff username.' }));
      }
      const walletAddress = requireEmbeddedWallet(user);
      const profile = await claimProfile({
        subject: user.subject,
        username: body.username,
        displayName: user.displayName,
        walletAddress
      });
      return send(res, 201, JSON.stringify({ profile }));
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/public/resolve') {
    try {
      const handle = url.searchParams.get('handle');
      if (!handle) return send(res, 400, JSON.stringify({ message: 'A Handoff handle is required.' }));
      const profile = await resolveUsername(handle);
      if (!profile) return send(res, 404, JSON.stringify({ message: 'This Handoff username is not registered.' }));
      return send(res, 200, JSON.stringify(profile));
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/public/profile') {
    try {
      const handle = url.searchParams.get('handle');
      if (!handle) return send(res, 400, JSON.stringify({ message: 'A Handoff username is required.' }));
      const profile = await getPublicProfile(handle);
      if (!profile) return send(res, 404, JSON.stringify({ message: 'This Handoff username is not registered.' }));
      return send(res, 200, JSON.stringify(profile));
    } catch (error) {
      return sendError(res, error);
    }
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && PAYMENT_PAGE_PATH.test(url.pathname)) {
    const [, rawHandle] = url.pathname.match(PAYMENT_PAGE_PATH);
    return servePaymentPage(req, res, rawHandle);
  }

  if (req.method === 'GET' && url.pathname === '/api/relay/chains') {
    try {
      const result = await relayRequest('GET', '/chains');
      return send(res, result.status, result.body);
    } catch (error) {
      return send(res, 502, JSON.stringify({ message: 'Unable to reach Relay', detail: error.message }));
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/relay/quote') {
    try {
      const quote = await readJson(req);
      const required = ['user', 'originChainId', 'originCurrency', 'destinationChainId', 'destinationCurrency', 'recipientHandle', 'amount', 'tradeType'];
      const missing = required.filter(key => quote[key] === undefined || quote[key] === '');
      if (missing.length) return send(res, 400, JSON.stringify({ message: `Missing: ${missing.join(', ')}` }));
      if (Number(quote.destinationChainId) !== 143) return send(res, 400, JSON.stringify({ message: 'Handoff only settles to Monad (chain 143).' }));

      // The client supplies only a username. The server resolves the active Monad wallet
      // immediately before quote creation so a browser cannot choose an arbitrary recipient.
      const profile = await resolveUsername(quote.recipientHandle);
      if (!profile) return send(res, 404, JSON.stringify({ message: 'This Handoff username is not registered.' }));
      const { recipientHandle, recipient: ignoredRecipient, ...relayQuote } = quote;
      relayQuote.recipient = profile.recipient;
      const result = await relayRequest('POST', '/quote/v2', relayQuote);
      return send(res, result.status, result.body);
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');

  const filePath = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!filePath.startsWith(root)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const extension = path.extname(filePath);
    const type = contentTypes[extension] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding' };
    // The Dynamic SDK bundle is large; compress text assets when the browser accepts gzip.
    const compressible = ['.html', '.css', '.js', '.json', '.svg'].includes(extension);
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    res.writeHead(200, acceptsGzip && compressible ? { ...headers, 'Content-Encoding': 'gzip' } : headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    if (acceptsGzip && compressible) stream.pipe(zlib.createGzip()).pipe(res);
    else stream.pipe(res);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Handoff running on http://0.0.0.0:${port}`);
});
