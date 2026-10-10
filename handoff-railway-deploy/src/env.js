const fs = require('fs');
const path = require('path');

/**
 * Tiny development-only dotenv reader. Production values should be supplied by
 * the hosting provider, which always takes precedence over .env.local.
 */
function loadLocalEnvironment() {
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(name) || process.env[name] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

loadLocalEnvironment();
