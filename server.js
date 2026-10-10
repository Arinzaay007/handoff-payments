const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { config, status: configurationStatus, publicRuntimeConfig } = require('./src/config');
const { resolvePublicRecipient } = require('./src/usernameService');
const { requireDynamicUser, requireEmbeddedWallet, hasEmbeddedWallet } = require('./src/dynamicAuth');
const { getProfileForSubject, claimProfile } = require('./src/profileService');
const { getPublicProfile } = require('./src/publicProfile');
const { MONAD, publicSourceNetworks } = require('./src/paymentNetworks');
const relay = require('./src/relayClient');
const payments = require('./src/paymentService');
const { formatUsdc } = require('./src/paymentPolicy');

const root = path.join(__dirname, 'public');
const PAYMENT_PAGE_PATH = /^\/@([^/]+)\/?$/;
const PAYMENT_ID_PATH = /^\/api\/payments\/([0-9a-fA-F-]{36})(\/awaiting-signature|\/source-transaction)?$/;
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

function publicCaps() {
  const guards = publicRuntimeConfig().mainnetGuards;
  return {
    perPaymentUsdc: formatUsdc(config.limits.maxMainnetUsdcMinor),
    dailyRollingUsdc: formatUsdc(config.limits.maxDailyMainnetUsdcMinor),
    perPaymentMaximum: guards.maximumPaymentUsdc,
    dailyMaximum: guards.maximumDailyUsdc
  };
}

// Payment routes never forward raw provider or database text. Our own coded errors pass through;
// anything else becomes a generic message, and the detail is logged server-side only.
const PAYMENT_SERVER_CODES = new Set([
  'RELAY_UNAVAILABLE', 'RELAY_NOT_CONFIGURED', 'ROUTE_UNAVAILABLE', 'PAYMENTS_UNAVAILABLE',
  'DATABASE_NOT_CONFIGURED', 'DATABASE_UNAVAILABLE'
]);
function sendPaymentError(res, error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number(error?.status) || 0;
  const ownClientError = /^[A-Z_]+$/.test(code) && status >= 400 && status < 500;
  if (ownClientError || PAYMENT_SERVER_CODES.has(code)) return sendError(res, error);
  console.error('Handoff payment step failed:', code || 'UNCLASSIFIED', error?.details?.code || '');
  return send(res, 500, JSON.stringify({ message: 'Handoff could not complete this step. Try again.', code: 'PAYMENT_ERROR' }));
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
    // Public and display-safe. The network list is the server's source of truth: Solana and TON are
    // listed as not available yet, and the browser cannot promote them on its own.
    return send(res, 200, JSON.stringify({
      ...publicRuntimeConfig(),
      payments: {
        sourceNetworks: publicSourceNetworks(),
        destination: { chainId: MONAD.chainId, name: MONAD.name, asset: MONAD.asset },
        caps: publicCaps()
      }
    }));
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
      // Public projection only: display name, username, settlement. Never the recipient wallet.
      const profile = await resolvePublicRecipient(handle);
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

  if (req.method === 'GET' && url.pathname === '/api/relay/routes') {
    // Display-safe route status only. Relay's raw chain payload is never forwarded to the browser.
    try {
      return send(res, 200, JSON.stringify(await payments.getRouteStatus()));
    } catch (error) {
      return sendError(res, error);
    }
  }

  // Payment quote. The payer sends only their own wallet, a source network, a @username, and an
  // amount. The recipient wallet is resolved on the server; any other field is rejected.
  if (req.method === 'POST' && url.pathname === '/api/payments/quote') {
    try {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return send(res, 400, JSON.stringify({ message: 'Send a quote request.' }));
      }
      const allowed = new Set(['payer', 'sourceNetwork', 'recipientHandle', 'amount']);
      if (Object.keys(body).some(key => !allowed.has(key))) {
        return send(res, 400, JSON.stringify({ message: 'Only payer, sourceNetwork, recipientHandle, and amount can be submitted.', code: 'FIELD_NOT_ALLOWED' }));
      }
      const quote = await payments.createPaymentQuote({
        payer: body.payer,
        sourceNetwork: body.sourceNetwork,
        recipientHandle: body.recipientHandle,
        amount: body.amount
      });
      return send(res, quote.executable ? 201 : 200, JSON.stringify(quote));
    } catch (error) {
      return sendPaymentError(res, error);
    }
  }

  const paymentMatch = url.pathname.match(PAYMENT_ID_PATH);
  if (paymentMatch) {
    const [, paymentId, action] = paymentMatch;
    try {
      if (req.method === 'GET' && !action) {
        return send(res, 200, JSON.stringify(await payments.getPaymentReceipt(paymentId)));
      }
      if (req.method === 'POST' && action === '/awaiting-signature') {
        return send(res, 200, JSON.stringify(await payments.markAwaitingSignature(paymentId)));
      }
      if (req.method === 'POST' && action === '/source-transaction') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'txHash')) {
          return send(res, 400, JSON.stringify({ message: 'Send only the source transaction hash.', code: 'FIELD_NOT_ALLOWED' }));
        }
        return send(res, 200, JSON.stringify(await payments.recordSourceTransaction(paymentId, body.txHash)));
      }
      return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    } catch (error) {
      return sendPaymentError(res, error);
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
