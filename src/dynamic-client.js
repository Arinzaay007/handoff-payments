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
 *   exportWalletKey()   authorizes the owner (wallet:export step-up, then wallet export MFA), then
 *                       opens Dynamic's embedded-wallet key reveal. Refusal rejects with
 *                       code EXPORT_AUTHORIZATION_DENIED and never reaches the reveal.
 *   clearExportFrame()  clears Dynamic's export frame and any legacy export frame (called when the
 *                       Handoff modal closes)
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
  useIsLoggedIn,
  useIsMfaRequiredForAction,
  useStepUpAuthentication
} from '@dynamic-labs/sdk-react-core';
import {
  LegacyWalletMigrationProvider,
  useLegacyWalletExport
} from '@dynamic-labs/legacy-embedded-wallet-migration';
import { DynamicWaasEVMConnectors } from '@dynamic-labs/waas-evm';
import { buildDynamicSettings } from './dynamicSettings.js';
import { LEGACY_EXPORT_FRAME_ID, runWalletExport } from './walletExport.js';

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
  const { setShowAuthFlow, sdkHasLoaded, handleLogOut, primaryWallet, user } = useDynamicContext();
  const isLoggedIn = useIsLoggedIn();
  const { createWalletAccount } = useDynamicWaas();
  const { initExportProcess } = useEmbeddedReveal();
  const { revealWalletKey } = useLegacyWalletExport();
  const { isStepUpRequired, promptStepUpAuth, promptMfa } = useStepUpAuthentication();
  const isMfaRequiredForAction = useIsMfaRequiredForAction();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Latest SDK functions for the export. Read at click time, so the api object stays stable.
  const exportDepsRef = useRef(null);
  exportDepsRef.current = {
    isStepUpRequired,
    promptStepUpAuth,
    promptMfa,
    isMfaRequiredForAction,
    initExportProcess,
    revealLegacyWalletKey: revealWalletKey,
    primaryWallet,
    user
  };

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
      // Owner-only key export. Authorization (wallet:export step-up, then MFA) runs first. Only
      // then does Dynamic's embedded-wallet reveal start (recoveryPhrase=false asks for the key,
      // isPromptForExport=true keeps Dynamic's own confirmation). The key is rendered only inside
      // Dynamic's isolated secure iframe. The resolved value is discarded, so Handoff never gets it.
      exportWalletKey: () => runWalletExport(exportDepsRef.current),
      // Clears Dynamic's export frame and the legacy frame when the Handoff modal closes. It only
      // clears. It never reads anything from either frame.
      clearExportFrame: () => {
        try {
          primaryWallet?.connector?.getExportHandler?.()?.clear?.();
        } catch { /* nothing to clear */ }
        try {
          document.getElementById(LEGACY_EXPORT_FRAME_ID)?.replaceChildren();
        } catch { /* nothing to clear */ }
      }
    };
    const waiters = apiWaiters;
    apiWaiters = [];
    waiters.forEach(callback => callback(api));
  }, [createWalletAccount, handleLogOut, setShowAuthFlow, primaryWallet]);

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
  // LegacyWalletMigrationProvider is required by the SDK when a legacy V1/V2 wallet is present.
  // autoOpen={false} keeps Dynamic's migration modal closed: nothing here upgrades or recreates a
  // wallet unless the owner starts it from a visible control (none exists in Handoff).
  createRoot(container).render(
    h(DynamicContextProvider, { settings },
      h(LegacyWalletMigrationProvider, { autoOpen: false },
        h(DynamicBridge, { onChange: onChange || (() => {}) })))
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
