import {
  createDynamicClient,
  getWalletAccounts,
  initializeClient,
  logout,
  refreshAuth,
  registerPasskey,
  sendEmailOTP,
  signInWithPasskey,
  verifyOTP,
  waitForClientInitialized
} from '@dynamic-labs-sdk/client';
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from '@dynamic-labs-sdk/client/waas';
import { addEvmExtension, isEvmWalletAccount } from '@dynamic-labs-sdk/evm';

let dynamicClient;
let initializedEnvironmentId;

function safeUser(user) {
  if (!user) return null;
  return {
    id: user.id || user.userId || null,
    email: user.email || null,
    displayName: [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.alias || null
  };
}

async function snapshot() {
  const accounts = await getWalletAccounts();
  const evmAccounts = accounts
    .filter(isEvmWalletAccount)
    .map(account => ({ address: account.address, chain: account.chain || 'EVM' }));
  return {
    user: safeUser(dynamicClient?.user),
    wallets: evmAccounts,
    token: dynamicClient?.token || null
  };
}

// Makes sure a signed-in user has an EVM embedded wallet, then rotates the token.
// Never throws: any failure is logged as a warning and the current snapshot is returned.
async function ensureEvmWallet() {
  try {
    if (!dynamicClient?.user) return snapshot();

    const accounts = await getWalletAccounts();
    if (accounts.some(isEvmWalletAccount)) return snapshot();

    const evmChains = getChainsMissingWaasWalletAccounts().filter(chain => chain === 'EVM');
    if (evmChains.length > 0) {
      await createWaasWalletAccounts({ chains: evmChains });
    }
    await refreshAuth();
  } catch (error) {
    console.warn('Handoff: could not ensure EVM wallet for this session.', error);
  }
  return snapshot();
}

async function initialize({ environmentId }) {
  if (!environmentId) throw new Error('Dynamic is not configured for this deployment.');
  if (dynamicClient && initializedEnvironmentId === environmentId) return snapshot();

  dynamicClient = createDynamicClient({
    autoInitialize: false,
    environmentId,
    metadata: {
      name: 'Handoff',
      universalLink: window.location.origin
    }
  });
  initializedEnvironmentId = environmentId;
  addEvmExtension();
  await initializeClient();
  await waitForClientInitialized(dynamicClient);
  return ensureEvmWallet();
}

async function sendEmailCode(email) {
  if (!dynamicClient) throw new Error('Dynamic has not initialized.');
  return sendEmailOTP({ email });
}

async function verifyEmailCode(otpVerification, verificationToken) {
  if (!dynamicClient) throw new Error('Dynamic has not initialized.');
  await verifyOTP({ otpVerification, verificationToken });
  return ensureEvmWallet();
}

async function usePasskey() {
  if (!dynamicClient) throw new Error('Dynamic has not initialized.');
  await signInWithPasskey();
  return ensureEvmWallet();
}

async function addPasskey() {
  if (!dynamicClient) throw new Error('Dynamic has not initialized.');
  await registerPasskey();
}

async function signOut() {
  if (!dynamicClient) return;
  await logout();
  return snapshot();
}

function getToken() {
  return dynamicClient?.token || null;
}

window.HandoffDynamic = {
  initialize,
  sendEmailCode,
  verifyEmailCode,
  usePasskey,
  addPasskey,
  signOut,
  getToken,
  snapshot
};
