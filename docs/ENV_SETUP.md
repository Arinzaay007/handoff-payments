# Handoff environment setup

Handoff’s browser receives **only** the Dynamic Environment ID. Username resolution, username claims, and all Supabase writes stay on the server.

## Required deployment variables

```env
# Public by design: identifies the Dynamic Live environment for the browser SDK.
DYNAMIC_ENVIRONMENT_ID=

# Server-only Supabase access. Use exactly one key name below.
SUPABASE_URL=
# Preferred on current Supabase projects.
SUPABASE_SECRET_KEY=
# Legacy projects only; the server accepts either, but prefer SUPABASE_SECRET_KEY.
# SUPABASE_SERVICE_ROLE_KEY=

# Conservative mainnet controls, in USDC six-decimal smallest units.
MAX_MAINNET_USDC_MINOR=25000000
MAX_DAILY_MAINNET_USDC_MINOR=100000000
```

`SUPABASE_SECRET_KEY` is the current Supabase name; `SUPABASE_SERVICE_ROLE_KEY`
is supported for legacy projects. The server accepts either, but never exposes
either one.

## Render

On Render these five variables are declared in [`render.yaml`](../render.yaml)
with `sync: false`, so the dashboard prompts for each value. See
[`docs/RENDER_DEPLOY.md`](RENDER_DEPLOY.md) for the full walkthrough.

| Variable | Where it goes |
| --- | --- |
| `DYNAMIC_ENVIRONMENT_ID` | Render Variables (public by design) |
| `SUPABASE_URL` | Render Variables (public) |
| `SUPABASE_SECRET_KEY` | Render Variables — **server-only secret** |
| `MAX_MAINNET_USDC_MINOR` | Render Variables (non-secret cap) |
| `MAX_DAILY_MAINNET_USDC_MINOR` | Render Variables (non-secret cap) |

Rotate the previously exposed Supabase key before you paste the replacement.
Never paste a key into a chat, a commit, or a browser.


## Local development

1. Copy `.env.example` to `.env.local`.
2. Add **only public values** when you need to test the browser sign-in flow locally.
3. Put the Supabase secret/service key in your local uncommitted `.env.local` or hosting-provider environment settings. Never paste it in chat or commit it.
4. Run `npm install`, `npm run build`, and `npm start`.

The tiny local environment loader fills only unset values, so real host environment variables override `.env.local`. `.env.local` is ignored by Git.

## Dynamic configuration

- The Dynamic client is initialized with `DYNAMIC_ENVIRONMENT_ID` from `GET /api/public-config`.
- Add every exact browser origin you will use to Dynamic **CORS origins**: `http://localhost:3000` for local development and the exact deployed HTTPS domain for production. Do not use a wildcard for a payment app.
- Handoff verifies the Dynamic access-token signature against Dynamic’s public JWKS and requires the Live environment ID plus the `user:basic` scope before it accepts an authenticated request.
- Handoff takes the Monad recipient only from a Dynamic **embedded** EVM wallet credential (`wallet_provider: embeddedWallet`) in the token’s verified credentials. A browser cannot submit an arbitrary recipient wallet.
- The browser SDK registers only embedded EVM wallet connectors. Injected, WalletConnect, and MetaMask connectors and social providers are not registered for recipient onboarding.
- In the Dynamic dashboard, keep phone, SMS, WhatsApp, and social sign-in disabled. Enable **passkeys** and **email OTP only**, and place passkeys before email in the hosted-widget sign-in order. Dashboard settings control the hosted widget; the app opens that widget without implementing its own credential form.
- Do not enable a wallet-management, seed, recovery-key, or private-key export surface for the Handoff recipient journey. Handoff has no application route or UI for those controls.

## Supabase migration order

Run these files, in order, in the Supabase SQL Editor:

1. `supabase/migrations/0001_handoff_mainnet_schema.sql` — initial schema.
2. `supabase/migrations/0002_claim_handoff_profile.sql` — atomic, server-only profile and destination claim.
3. `supabase/migrations/0003_payment_requests_and_ledger.sql` — payment execution ledger and public profile support.
4. `supabase/migrations/0004_exact_output_merchant_settlement.sql` — exact-output merchant settlement fields and policies.

## Deployment checks

- `GET /api/config` returns only readiness booleans and mainnet caps.
- `GET /api/public-config` returns only the Dynamic Environment ID and mainnet caps.
- `GET /api/me` requires a verified Dynamic access token.
- `GET /api/me/wallet-status` returns only `{ ready: boolean }` for the verified Dynamic session. It never returns an address.
- `GET /api/me/portfolio` requires a verified Dynamic access token and is scoped to that user's own recipient profile. It returns the real on-chain Monad USDC balance (chain ID 143 verified, ERC-20 `balanceOf` on Monad USDC) with `status: "available" | "unavailable"` — never a database total and never a fake zero — plus receipt activity shown only after the source transaction was submitted. It never returns a payer address, key material, or a recipient wallet. There is no endpoint that exports or accepts a key.
- `POST /api/me/claim` accepts only `{ "username" }`. It requires a verified Dynamic passkey/email session with exactly one embedded EVM credential. The browser never submits or receives a recipient address.
- `GET /api/public/resolve?handle=ada` resolves only a registered Handoff username to its single active Monad recipient wallet.
- `GET /@ada` serves the public payment page for a registered username. The page URL is derived from the request origin, so the same build works on any host. Unknown or unfunded handles get a not-found page with `noindex`.
- `GET /api/public/profile?handle=ada` returns only `username`, `displayName`, and `settlement`. It never returns a wallet address, a Dynamic subject, or an email.

## Never expose

- Dynamic API/bearer tokens (`dyn_...`)
- Supabase secret keys (`sb_secret_...`) or legacy service-role keys
- Database passwords
- Wallet recovery phrases or private keys

## Payment execution

| Variable | Where | Purpose |
| --- | --- | --- |
| `RELAY_API_KEY` | Server only (Render Variables, `.env.local`) | Sent as `x-api-key` on Relay requests. Required on `POST /quote/v2` from 2 October 2026. Without it, payments show a clear "not configured" state. |
| `MONAD_RPC_URL` | Server only, optional | Monad JSON-RPC used to verify USDC settlement and to read the owner's verified Monad USDC balance. Default `https://rpc.monad.xyz` (chain 143). When it cannot be read, the dashboard shows "syncing/unavailable", never a fake zero. |
| `MAX_MAINNET_USDC_MINOR` | Server | Per-payment cap. Default and ceiling `25000000` (25 USDC). Lower values are honoured; higher values are clamped. |
| `MAX_DAILY_MAINNET_USDC_MINOR` | Server | Rolling 24-hour cap per payer. Default and ceiling `100000000` (100 USDC). |

Never place `RELAY_API_KEY` or any Supabase key in a browser-visible file, `render.yaml`, or Git.

## Exact-output merchant payments

Handoff treats a checkout amount as the recipient’s required **Monad USDC output**. The server requests Relay `EXACT_OUTPUT` quotes with `enableTrueExactOutput: true` and no fee sponsorship. The sender pays the live quoted source-USDC debit and separately pays source-chain native gas in their wallet.

Before enabling payments, apply migrations `0001` → `0004` in order. Migration `0004_exact_output_merchant_settlement.sql` is required: it persists the requested output, quoted/confirmed payer debit, route cost, and final destination amount separately, and rejects an exact-output settlement unless Monad received exactly the requested USDC amount. Per-payment and daily caps apply to Relay’s quoted payer source amount.
