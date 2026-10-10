/**
 * Browser bundle: Dynamic hosted (widget) auth for Handoff recipient onboarding, plus the
 * owner-only secure key export.
 *
 * Built by `npm run build` into public/dynamic-client.js (never committed).
 *
 * Exposes window.HandoffDynamic:
 *   initialize({ environmentId, onChange })  -> Promise, resolves when the SDK has loaded
 *   openAuth()          opens Dynamic's hosted sign-in widget (email code or passkey)
 *   getToken()          current Dynamic access token, or null (sent to the server as a Bearer)
 *   retryWalletSetup()  asks Dynamic to provision the embedded EVM account again
 *   signOut()           ends the Dynamic session
 *   exportWalletKey()   opens Dynamic's embedded-wallet key reveal for the signed-in owner
 *   clearExportFrame()  clears Dynamic's export frame (called when the Handoff modal closes)
 *
 * Handoff never receives, stores, exports, imports, encrypts, or recovers a private key.
 * Key material stays inside Dynamic's embedded-wallet infrastructure: the export flow is
 * Dynamic's own embedded-wallet reveal (initExportProcess), which renders the key only inside
 * Dynamic's isolated secure iframe. This bundle never receives the revealed value, never logs
 * it, and never sends it anywhere — the reveal promise is deliberately discarded.
 */
import { createElement as h, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ChainEnum,
  DynamicContextProvider,
  getAuthToken,
  useDynamicContext,
  useDynamicWaas,
  useEmbeddedReveal,
  useIsLoggedIn
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
  const { setShowAuthFlow, sdkHasLoaded, handleLogOut, primaryWallet } = useDynamicContext();
  const isLoggedIn = useIsLoggedIn();
  const { createWalletAccount } = useDynamicWaas();
  const { initExportProcess } = useEmbeddedReveal();
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
      signOut: () => handleLogOut(),
      // Owner-only key export, delegated entirely to Dynamic's embedded-wallet reveal flow.
      // recoveryPhrase=false asks for the private key, isPromptForExport=true shows Dynamic's
      // own confirmation first. The key is rendered only inside Dynamic's isolated secure
      // iframe; the resolved value is discarded so Handoff code never receives it.
      exportWalletKey: () => initExportProcess(false, true).then(() => undefined),
      // Clears Dynamic's export frame/handler when the Handoff modal closes. It only clears;
      // it never reads anything from the frame.
      clearExportFrame: () => {
        try {
          primaryWallet?.connector?.getExportHandler?.()?.clear?.();
        } catch { /* nothing to clear */ }
      }
    };
    const waiters = apiWaiters;
    apiWaiters = [];
    waiters.forEach(callback => callback(api));
  }, [createWalletAccount, handleLogOut, setShowAuthFlow, initExportProcess, primaryWallet]);

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

  // The provider mounts Dynamic's hosted auth modal itself, so no visible widget is needed here.
  createRoot(container).render(
    h(DynamicContextProvider, { settings },
      h(DynamicBridge, { onChange: onChange || (() => {}) }))
  );

  mounted = new Promise(resolve => onApiReady(resolve));
  return mounted;
}

window.HandoffDynamic = {
  initialize,
  openAuth: () => requireApi().openAuth(),
  getToken: () => (api ? api.getToken() : null),
  retryWalletSetup: () => requireApi().retryWalletSetup(),
  signOut: () => (api ? api.signOut() : undefined),
  exportWalletKey: () => requireApi().exportWalletKey(),
  clearExportFrame: () => (api ? api.clearExportFrame() : undefined)
};
