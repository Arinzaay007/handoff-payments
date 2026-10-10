# Handoff

**One handle. Any supported chain. Settled on Monad.**

Handoff is a non-custodial omnichain payment identity. A payer uses a canonical Handoff `@username`; Relay quotes the route; the recipient receives USDC directly in one verified Monad wallet. External social aliases are deferred beyond the MVP.

## What this build includes

- Dynamic-powered **email and passkey** onboarding in a custom Handoff UI. No phone, SMS, WhatsApp, X, or Instagram flow is included.
- A server-only Dynamic session boundary: the server validates a signed access token, the Dynamic Live environment ID, and `user:basic` before reading or writing a profile.
- A secure profile-claim design: a username can be bound only to an EVM address contained in the user’s verified Dynamic credentials. The browser cannot supply an arbitrary recipient wallet.
- A Supabase data model plus an atomic profile-claim migration.
- Ten planned payment sources: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Solana, TON, and Celo → USDC on Monad.
- A small Node server that proxies Relay’s live `GET /chains` and `POST /quote/v2` APIs. The UI syncs availability from the real API.
- A mainnet-oriented checkout that fixes settlement to Monad (`143`) and USDC, resolves the recipient server-side, and does **not** broadcast a transaction from this build.
- A minimal non-custodial `UsernameRegistry.sol` reference contract. It is not deployed or audited.

## Run locally

```bash
npm install
npm run build
npm start
# http://localhost:3000
```

Configure public and server-only values as described in [`docs/ENV_SETUP.md`](docs/ENV_SETUP.md). The checked-in UI works without a secret, but public username resolution and username claims deliberately fail closed until the server has Supabase credentials.

## What is still required before accepting real payments

1. Add the Supabase secret/service key directly to the deployment host; never to the browser or chat.
2. Apply `supabase/migrations/0002_claim_handoff_profile.sql`.
3. Add the exact deployed HTTPS origin to Dynamic CORS settings and test email + passkey sign-in.
4. Build the first controlled route: **Base USDC → Relay → USDC on Monad**. Add official Relay execution/approval handling; a quote is not a transfer.
5. Persist payment requests, quote IDs, source/destination transaction hashes, status transitions, rate limits, and receipts.
6. Add monitoring, support flows, security review, and applicable legal/compliance checks before public launch.

## Core safety rules

- Handoff never takes custody, creates a pool, escrows funds, or operates a bridge.
- Only registered Handoff usernames resolve during the MVP.
- Unknown/unverified handles never receive or hold funds.
- Every checkout resolves the final Monad recipient before a wallet action.
- USDC on Monad is the sole MVP output.
- No transaction settlement is claimed until destination confirmation is observed.
