# Handoff mainnet build order

## Milestone 1 — identity and one real payment

1. Configure Dynamic Live email and passkey login. Social account providers stay off for the MVP.
2. Create Supabase and apply `supabase/migrations/0001_handoff_mainnet_schema.sql`, then `0002_claim_handoff_profile.sql`.
3. Add `DYNAMIC_ENVIRONMENT_ID`, `SUPABASE_URL`, and a server-only Supabase secret/service key to the deployment environment. Never place the key in browser code.
4. Use Handoff’s Dynamic email/passkey UI to establish a session. The server verifies Dynamic’s signed token, its Live environment ID, and the `user:basic` scope.
5. Claim one canonical `@username`. The server chooses only an EVM wallet contained in the verified Dynamic token and registers it as the active Monad recipient wallet.
6. Resolve Handoff `@username` values server-side to one active verified Monad recipient wallet. The browser cannot choose a post-resolution recipient address.
7. Execute one controlled **Base USDC → Monad USDC** payment using Relay with a low mainnet amount.
8. Persist the Relay request ID and both source/destination hashes; mark `settled` only after destination confirmation.

## Milestone 2 — payment requests

- Create, expire, cancel, and resolve server-persisted payment request links.
- Bind each request to the recipient wallet selected at creation time.
- Use a short quote expiry; never execute an expired quote.
- Handle Relay failed/refunded status and show a receipt.

## Milestone 3 — omnichain sources

Add and validate in this order: Solana, TON, Celo, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Ethereum.

## Non-negotiable live safeguards

- Handoff does not custody, pool, bridge, or escrow customer funds.
- Only registered Handoff usernames are payable in the MVP. Social aliases are deferred.
- The server, never the browser, resolves a username to its recipient wallet.
- First launch cap: USDC 25 per transaction and USDC 100 per day per authenticated user.
- Display recipient name, complete network, input asset, output minimum, fees, route expiry, and recipient before a signature.
- Log sensitive actions: wallet changes, request creation/cancellation, and payment-state transitions.
- Require an explicit, reviewed wallet-change flow before a public payment page changes recipient.
