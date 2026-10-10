const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { status: configurationStatus, publicRuntimeConfig } = require('./config');
const { resolveUsername } = require('./usernameService');
const { requireDynamicUser, selectVerifiedWallet } = require('./dynamicAuth');
const { getProfileForSubject, claimProfile } = require('./profileService');

const root = __dirname;
const publicFiles = new Set(['index.html', 'app.js', 'styles.css', 'dynamic-client.bundle.js']);
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
  if (error.code === 'DATABASE_NOT_CONFIGURED') status = 503;
  if (error.details?.code === 'PGRST202') {
    status = 503;
    message = 'The profile-claim database migration has not been applied yet.';
  }
  if (error.details?.code === '23505') status = 409;
  if (error.details?.code === 'P0001') status = 409;
  return send(res, status, JSON.stringify({ message }));
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
      return send(res, 200, JSON.stringify({
        profile,
        verifiedWallets: user.verifiedWallets,
        email: user.email
      }));
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/me/claim') {
    try {
      const user = await requireDynamicUser(req.headers.authorization);
      const body = await readJson(req);
      const walletAddress = selectVerifiedWallet(user, body.walletAddress);
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

  const requestedFile = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  if (!publicFiles.has(requestedFile)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const filePath = path.join(root, requestedFile);
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const type = contentTypes[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Handoff running on http://0.0.0.0:${port}`);
});
