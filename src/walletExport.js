/**
 * Owner wallet-key export: authorization first, then Dynamic's secure reveal.
 *
 * This module is pure. It takes the Dynamic SDK functions as arguments, so it has no SDK or React
 * import and can be exercised directly in Node. It is bundled into public/dynamic-client.js.
 *
 * Order for every export:
 *   1. Step-up for the wallet:export scope when the session requires one (Dynamic's prompt).
 *      Otherwise, the wallet export MFA action (wallet.waas.export) when Dynamic requires it.
 *   2. Only after that, the reveal:
 *      - WaaS (V3) wallet: Dynamic's embedded-wallet reveal (initExportProcess).
 *      - Legacy (V1/V2, Turnkey-backed) wallet: the official legacy reveal from
 *        @dynamic-labs/legacy-embedded-wallet-migration (revealWalletKey), rendered in Handoff's
 *        export dialog.
 *
 * A refused or cancelled authorization rejects with EXPORT_AUTHORIZATION_DENIED and the reveal
 * never starts. Key material is never returned, logged, stored, or sent anywhere by this module.
 */

// Dynamic's TokenScope.Walletexport. Written as a literal so the bundle does not depend on the
// internal sdk-api-core package.
const WALLET_EXPORT_SCOPE = 'wallet:export';
// Dynamic's MFAAction.WalletWaasExport.
const WALLET_WAAS_EXPORT_MFA_ACTION = 'wallet.waas.export';
const EXPORT_DENIED_CODE = 'EXPORT_AUTHORIZATION_DENIED';
const EXPORT_DENIED_MESSAGE = 'Secure export authorization was denied';
// Where a legacy (V1/V2) key reveal is rendered: inside the Handoff export dialog.
const LEGACY_EXPORT_FRAME_ID = 'legacyExportFrame';

function exportDenied() {
  const error = new Error(EXPORT_DENIED_MESSAGE);
  error.code = EXPORT_DENIED_CODE;
  return error;
}

// Legacy Dynamic embedded wallets (V1/V2) are Turnkey-backed. Dynamic's WaaS reveal does not
// support them, so they reveal through the migration package's legacy reveal instead.
function isLegacyWallet(user, wallet) {
  if (!wallet) return false;
  if (String(wallet.connector?.key || '').startsWith('turnkey')) return true;
  const credentials = Array.isArray(user?.verifiedCredentials) ? user.verifiedCredentials : [];
  const credential = credentials.find(item => item && item.id && item.id === wallet.id);
  const version = credential?.walletProperties?.version;
  return version === 'V1' || version === 'V2';
}

// Mirrors Dynamic's own embedded-wallet export: a wallet:export step-up when the session needs
// one, otherwise the wallet export MFA action. The state is re-checked after each prompt, so a
// prompt that resolves without satisfying Dynamic still counts as denied.
async function authorizeWalletExport({ isStepUpRequired, promptStepUpAuth, promptMfa, isMfaRequiredForAction }) {
  if (await isStepUpRequired({ scope: WALLET_EXPORT_SCOPE })) {
    try {
      await promptStepUpAuth({ requestedScopes: [WALLET_EXPORT_SCOPE] });
    } catch {
      throw exportDenied();
    }
    if (await isStepUpRequired({ scope: WALLET_EXPORT_SCOPE })) throw exportDenied();
    return;
  }
  if (await isMfaRequiredForAction({ mfaAction: WALLET_WAAS_EXPORT_MFA_ACTION })) {
    try {
      await promptMfa({ createMfaToken: true });
    } catch {
      throw exportDenied();
    }
    if (await isMfaRequiredForAction({ mfaAction: WALLET_WAAS_EXPORT_MFA_ACTION })) throw exportDenied();
  }
}

// deps: { user, primaryWallet, isStepUpRequired, promptStepUpAuth, promptMfa, isMfaRequiredForAction,
//         initExportProcess, revealLegacyWalletKey }
// Resolves to { mode: 'waas' | 'legacy' } and never the revealed key.
async function runWalletExport(deps) {
  await authorizeWalletExport(deps);
  if (isLegacyWallet(deps.user, deps.primaryWallet)) {
    await deps.revealLegacyWalletKey({
      type: 'privateKey',
      wallet: deps.primaryWallet,
      htmlContainerId: LEGACY_EXPORT_FRAME_ID
    });
    return { mode: 'legacy' };
  }
  // recoveryPhrase=false asks for the private key. isPromptForExport=true keeps Dynamic's own
  // confirmation. The resolved wallet from Dynamic is discarded.
  await deps.initExportProcess(false, true);
  return { mode: 'waas' };
}

module.exports = {
  WALLET_EXPORT_SCOPE,
  WALLET_WAAS_EXPORT_MFA_ACTION,
  EXPORT_DENIED_CODE,
  EXPORT_DENIED_MESSAGE,
  LEGACY_EXPORT_FRAME_ID,
  isLegacyWallet,
  authorizeWalletExport,
  runWalletExport
};
