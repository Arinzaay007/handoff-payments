// Starts server.js as a child process with the test preload, on a free port.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer({ environmentId, jwks, monadRpc }) {
  const port = await freePort();
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-')), 'outbound.log');
  const preload = pathToFileURL(path.join(__dirname, 'preload.mjs')).href;
  const child = spawn(process.execPath, ['--import', preload, 'server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      DYNAMIC_ENVIRONMENT_ID: environmentId,
      SUPABASE_URL: 'https://supabase.test',
      SUPABASE_SECRET_KEY: 'test-secret-not-real',
      HANDOFF_TEST_JWKS: JSON.stringify(jwks),
      HANDOFF_TEST_LOG: logFile,
      // Optional Monad RPC mock for balance-read tests. Without it, the server keeps its default
      // RPC URL and the preload blocks it, exactly like any other unmocked host.
      ...(monadRpc ? {
        MONAD_RPC_URL: monadRpc.url || 'https://monad-rpc.test',
        HANDOFF_TEST_MONAD_RPC_URL: monadRpc.url || 'https://monad-rpc.test',
        HANDOFF_TEST_MONAD_RPC_MODE: monadRpc.mode || 'ok',
        ...(monadRpc.balanceHex ? { HANDOFF_TEST_MONAD_BALANCE_HEX: monadRpc.balanceHex } : {})
      } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) break;
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (attempt === 99) throw new Error(`Server did not start: ${output}`);
  }

  return {
    baseUrl,
    outboundLog() {
      if (!fs.existsSync(logFile)) return [];
      return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    stop() {
      return new Promise(resolve => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
      });
    }
  };
}

module.exports = { startServer };
