const HANDLE_RE = /^[a-z0-9_]{3,24}$/;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function normaliseHandle(input) {
  return String(input || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function validateHandoffHandle(input) {
  const normalized = normaliseHandle(input);
  if (!HANDLE_RE.test(normalized)) {
    throw new Error('Handles must be 3–24 characters: lowercase letters, numbers, or underscores.');
  }
  return normalized;
}

function parsePaymentAlias(input) {
  const value = String(input || '').trim();
  const matched = value.match(/^(x|ig):(.+)$/i);
  if (!matched) return { provider: 'handoff', value: validateHandoffHandle(value) };

  const prefixes = { x: 'x', ig: 'instagram' };
  const provider = prefixes[matched[1].toLowerCase()];
  const raw = matched[2].trim();
  const handle = normaliseHandle(raw);
  const socialHandlePattern = provider === 'instagram' ? /^[a-z0-9._]{1,30}$/ : HANDLE_RE;
  if (!socialHandlePattern.test(handle)) throw new Error('That social handle is not valid.');
  return { provider, value: handle };
}

function assertEvmAddress(address) {
  if (!EVM_ADDRESS_RE.test(String(address || ''))) throw new Error('Invalid Monad recipient wallet.');
  return address;
}

module.exports = { normaliseHandle, validateHandoffHandle, parsePaymentAlias, assertEvmAddress };
