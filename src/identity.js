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

function assertEvmAddress(address) {
  if (!EVM_ADDRESS_RE.test(String(address || ''))) throw new Error('Invalid Monad recipient wallet.');
  return address;
}

module.exports = { normaliseHandle, validateHandoffHandle, assertEvmAddress };
