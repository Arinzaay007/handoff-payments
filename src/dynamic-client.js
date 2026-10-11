/**
 * Browser bundle: Dynamic hosted authentication and passkey-backed embedded EVM account setup for
 * Handoff recipients. Recipients use a passkey or email fallback; Handoff never displays, exports,
 * imports, or accepts seed phrases, private keys, or wallet addresses.
 *
 * Built by `npm run build` into public/dynamic-client.js (never committed).
 *
 * Exposes window.HandoffDynamic:
 *   initialize({ environmentId, onChange })  -> Promise, resolves when the SDK has loaded
 *   openAuth()          opens Dynamic's hosted sign-in widget (passkey or email fallback)
 *   getToken()          current Dynamic access token, or null (sent to the server as a Bearer)
 *   retryWalletSetup()  asks Dynamic to provision the embedded EVM account again
 *   hasPasskey()         reports whether the signed-in recipient has enrolled a passkey
 *   registerPasskey()    opens the device's normal passkey enrollment prompt
 *   signOut()            ends the Dynamic session
 */
import { createElement as h, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ChainEnum,
  DynamicContextProvider,
  getAuthToken,
  useDynamicContext,
  useDynamicWaas,
  useGetPasskeys,
  useIsLoggedIn,
  useRegisterPasskey
} from '@dynamic-labs/sdk-react-core';
import { DynamicWaasEVMConnectors } from '@dynamic-labs/waas-evm';
import { buildDynamicSettings } from './dynamicSettings.js';

let api = null;
let apiWaiters = [];

function onApiReady(callback) {
  if (api) callback(api);
  else apiWaiters.push(callback);
}

function requireApi() {
  if (!api) throw new Error('Secure sign-in is still loading. Try again in a moment.');
  return api;
}

// Lives inside DynamicContextProvider so it can use the SDK hooks. It renders nothing.
function DynamicBridge({ onChange }) {
  const { setShowAuthFlow, sdkHasLoaded, handleLogOut } = useDynamicContext();
  const isLoggedIn = useIsLoggedIn();
  const { createWalletAccount } = useDynamicWaas();
  const getPasskeys = useGetPasskeys();
  const registerPasskey = useRegisterPasskey();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    api = {
      openAuth: () => setShowAuthFlow(true),
      getToken: () => getAuthToken() || null,
      retryWalletSetup: () => createWalletAccount(
        [ChainEnum.Evm],
        undefined,
        undefined,
        { skipCloseAuthFlow: true }
      ),
      hasPasskey: async () => {
        const passkeys = await getPasskeys();
        return Array.isArray(passkeys) && passkeys.length > 0;
      },
      registerPasskey: () => registerPasskey(),
      signOut: () => handleLogOut()
    };
    const waiters = apiWaiters;
    apiWaiters = [];
    waiters.forEach(callback => callback(api));
  }, [createWalletAccount, getPasskeys, handleLogOut, registerPasskey, setShowAuthFlow]);

  useEffect(() => {
    if (!sdkHasLoaded) return;
    onChangeRef.current?.({ signedIn: Boolean(isLoggedIn) });
  }, [sdkHasLoaded, isLoggedIn]);

  return null;
}

let mounted = null;

function initialize({ environmentId, onChange } = {}) {
  if (mounted) return mounted;
  const settings = buildDynamicSettings({
    environmentId,
    connectors: [DynamicWaasEVMConnectors]
  });
  const container = document.createElement('div');
  container.id = 'handoff-dynamic-root';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);

  // Dynamic owns hosted passkey/email authentication and the recipient's embedded account. Handoff
  // renders no recovery-key, private-key, or wallet-address surface.
  createRoot(container).render(h(DynamicContextProvider, { settings }, h(DynamicBridge, { onChange: onChange || (() => {}) })));

  mounted = new Promise(resolve => onApiReady(resolve));
  return mounted;
}

window.HandoffDynamic = {
  initialize,
  openAuth: () => requireApi().openAuth(),
  getToken: () => (api ? api.getToken() : null),
  retryWalletSetup: () => requireApi().retryWalletSetup(),
  hasPasskey: () => requireApi().hasPasskey(),
  registerPasskey: () => requireApi().registerPasskey(),
  signOut: () => (api ? api.signOut() : undefined)
};
