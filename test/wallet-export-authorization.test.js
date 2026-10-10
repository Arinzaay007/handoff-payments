// Owner wallet-key export: Dynamic step-up / MFA authorization runs before any reveal, refusals
// stop the reveal, and legacy V1/V2 wallets use the official legacy reveal. Driven with fake SDK
// functions, so the ordering and denial rules are checked without a live Dynamic environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPORT_DENIED_CODE,
  EXPORT_DENIED_MESSAGE,
  LEGACY_EXPORT_FRAME_ID,
  WALLET_EXPORT_SCOPE,
  WALLET_WAAS_EXPORT_MFA_ACTION,
  isLegacyWallet,
  runWalletExport
} = require('../src/walletExport');

const WAAS_WALLET = { id: 'wallet-waas', address: '0x4444444444444444444444444444444444444444', connector: { key: 'dynamicwaas' } };
const LEGACY_WALLET = { id: 'wallet-v1', address: '0x5555555555555555555555555555555555555555', connector: { key: 'turnkeyevm' } };
const WAAS_USER = { verifiedCredentials: [{ id: 'wallet-waas', walletProperties: { version: 'V3' } }] };
const V2_USER = { verifiedCredentials: [{ id: 'wallet-v2', walletProperties: { version: 'V2' } }] };
const V1_USER = { verifiedCredentials: [{ id: 'wallet-v1', walletProperties: { version: 'V1' } }] };

// Builds deps that record every call in order. Defaults: nothing required, reveals succeed.
function fakeSdk({ user = WAAS_USER, wallet = WAAS_WALLET, stepUp = [false], mfa = [false], promptStepUpResult, promptMfaResult } = {}) {
  const calls = [];
  const queueOf = values => {
    const queue = [...values];
    return () => (queue.length > 1 ? queue.shift() : queue[0]);
  };
  const nextStepUp = queueOf(stepUp);
  const nextMfa = queueOf(mfa);
  const deps = {
    user,
    primaryWallet: wallet,
    isStepUpRequired: async ({ scope }) => { calls.push(`stepUpCheck:${scope}`); return nextStepUp(); },
    promptStepUpAuth: async (params) => {
      calls.push(`promptStepUp:${JSON.stringify(params.requestedScopes)}`);
      if (promptStepUpResult) return promptStepUpResult();
      return 'token';
    },
    isMfaRequiredForAction: async ({ mfaAction }) => { calls.push(`mfaCheck:${mfaAction}`); return nextMfa(); },
    promptMfa: async (params) => {
      calls.push(`promptMfa:${JSON.stringify(params)}`);
      if (promptMfaResult) return promptMfaResult();
      return 'token';
    },
    initExportProcess: async (recoveryPhrase, isPromptForExport) => {
      calls.push(`waasReveal:${recoveryPhrase}:${isPromptForExport}`);
      return { id: 'discarded-by-handoff' };
    },
    revealLegacyWalletKey: async (params) => {
      calls.push(`legacyReveal:${params.type}:${params.htmlContainerId}`);
      return true;
    }
  };
  return { deps, calls };
}

const refuse = () => { throw new Error('User closed the Dynamic prompt'); };

test('a wallet:export step-up is requested before the WaaS reveal, and the reveal then runs', async () => {
  const { deps, calls } = fakeSdk({ stepUp: [true, false] });
  const result = await runWalletExport(deps);
  assert.deepEqual(result, { mode: 'waas' });
  assert.deepEqual(calls, [
    `stepUpCheck:${WALLET_EXPORT_SCOPE}`,
    `promptStepUp:${JSON.stringify([WALLET_EXPORT_SCOPE])}`,
    `stepUpCheck:${WALLET_EXPORT_SCOPE}`,
    'waasReveal:false:true'
  ]);
});

test('when no step-up is required, the wallet export MFA action is checked before the reveal', async () => {
  const { deps, calls } = fakeSdk({ stepUp: [false], mfa: [true, false] });
  await runWalletExport(deps);
  assert.deepEqual(calls, [
    `stepUpCheck:${WALLET_EXPORT_SCOPE}`,
    `mfaCheck:${WALLET_WAAS_EXPORT_MFA_ACTION}`,
    `promptMfa:${JSON.stringify({ createMfaToken: true })}`,
    `mfaCheck:${WALLET_WAAS_EXPORT_MFA_ACTION}`,
    'waasReveal:false:true'
  ]);
});

test('no prompt is shown when Dynamic requires neither step-up nor MFA', async () => {
  const { deps, calls } = fakeSdk();
  assert.deepEqual(await runWalletExport(deps), { mode: 'waas' });
  assert.equal(calls.some(call => call.startsWith('promptStepUp') || call.startsWith('promptMfa')), false);
  assert.equal(calls.at(-1), 'waasReveal:false:true');
});

test('a refused step-up rejects with the denial message and never starts a reveal', async () => {
  const { deps, calls } = fakeSdk({ stepUp: [true], promptStepUpResult: refuse });
  await assert.rejects(runWalletExport(deps), error => {
    assert.equal(error.message, 'Secure export authorization was denied');
    assert.equal(error.code, 'EXPORT_AUTHORIZATION_DENIED');
    return true;
  });
  assert.equal(calls.some(call => call.includes('Reveal')), false, 'no reveal after a refusal');
});

test('a step-up prompt that resolves without satisfying Dynamic still counts as denied', async () => {
  const { deps, calls } = fakeSdk({ stepUp: [true, true] });
  await assert.rejects(runWalletExport(deps), { code: EXPORT_DENIED_CODE, message: EXPORT_DENIED_MESSAGE });
  assert.equal(calls.some(call => call.includes('Reveal')), false);
});

test('a refused MFA prompt rejects with the denial message and never starts a reveal', async () => {
  const { deps, calls } = fakeSdk({ stepUp: [false], mfa: [true], promptMfaResult: refuse });
  await assert.rejects(runWalletExport(deps), { code: EXPORT_DENIED_CODE, message: EXPORT_DENIED_MESSAGE });
  assert.equal(calls.some(call => call.includes('Reveal')), false);
});

test('an MFA prompt that resolves while Dynamic still requires MFA is denied', async () => {
  const { deps, calls } = fakeSdk({ stepUp: [false], mfa: [true, true] });
  await assert.rejects(runWalletExport(deps), { code: EXPORT_DENIED_CODE });
  assert.equal(calls.some(call => call.includes('Reveal')), false);
});

test('a V1 or V2 legacy wallet is revealed only after authorization, through the legacy reveal', async () => {
  for (const user of [V1_USER, V2_USER]) {
    const wallet = { id: user.verifiedCredentials[0].id, connector: { key: 'embeddedWallet' } };
    const { deps, calls } = fakeSdk({ user, wallet, stepUp: [true, false] });
    assert.deepEqual(await runWalletExport(deps), { mode: 'legacy' });
    assert.deepEqual(calls, [
      `stepUpCheck:${WALLET_EXPORT_SCOPE}`,
      `promptStepUp:${JSON.stringify([WALLET_EXPORT_SCOPE])}`,
      `stepUpCheck:${WALLET_EXPORT_SCOPE}`,
      `legacyReveal:privateKey:${LEGACY_EXPORT_FRAME_ID}`
    ]);
  }
});

test('a legacy wallet that is refused authorization is never revealed', async () => {
  const { deps, calls } = fakeSdk({ user: V1_USER, wallet: LEGACY_WALLET, stepUp: [true], promptStepUpResult: refuse });
  await assert.rejects(runWalletExport(deps), { code: EXPORT_DENIED_CODE });
  assert.equal(calls.some(call => call.includes('Reveal')), false);
});

test('a Turnkey connector is treated as legacy even without a version on the credential', async () => {
  assert.equal(isLegacyWallet({ verifiedCredentials: [] }, LEGACY_WALLET), true);
  const { deps, calls } = fakeSdk({ user: { verifiedCredentials: [] }, wallet: LEGACY_WALLET });
  assert.deepEqual(await runWalletExport(deps), { mode: 'legacy' });
  assert.equal(calls.at(-1), `legacyReveal:privateKey:${LEGACY_EXPORT_FRAME_ID}`);
});

test('a V3 WaaS wallet is never routed to the legacy reveal', () => {
  assert.equal(isLegacyWallet(WAAS_USER, WAAS_WALLET), false);
  assert.equal(isLegacyWallet({ verifiedCredentials: [{ id: 'other', walletProperties: { version: 'V1' } }] }, WAAS_WALLET), false,
    'a legacy credential for a different wallet does not change the primary wallet');
  assert.equal(isLegacyWallet(WAAS_USER, null), false);
});

test('the export resolves to a mode only and never returns the revealed wallet or key material', async () => {
  const { deps } = fakeSdk();
  const result = await runWalletExport(deps);
  assert.deepEqual(Object.keys(result), ['mode']);
  assert.equal(JSON.stringify(result).includes('discarded-by-handoff'), false);
});
