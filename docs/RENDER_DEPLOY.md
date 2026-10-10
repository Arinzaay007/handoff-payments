# Deploy Handoff to Render (free plan)

Render replaces the earlier Railway plan: Railway now requires a paid upgrade,
while Render's free web-service tier is enough for this app.

The deployment target is defined in [`render.yaml`](../render.yaml) at the
repository root. That file contains **no secrets and no environment values** —
every variable is declared `sync: false`, so Render asks you for each one.

---

## 0. Before you start (do this first)

A Supabase service-role key and a GitHub personal access token were exposed in a
previous conversation. Treat both as compromised:

1. **Revoke and rotate the Supabase key** in the Supabase dashboard
   (*Project Settings → API keys*). Generate a **new** `sb_secret_...` key.
2. **Revoke the GitHub PAT** in *GitHub → Settings → Developer settings →
   Personal access tokens*.
3. Never reuse, paste, or commit either old value. The new Supabase key is typed
   **only** into Render's encrypted Variables panel.

Also make sure the second database migration is applied. In the Supabase SQL
editor, run, in order:

1. `supabase/migrations/0001_handoff_mainnet_schema.sql` (already applied)
2. `supabase/migrations/0002_claim_handoff_profile.sql` (**still to do**)

Until 0002 is applied, `POST /api/me/claim` returns **503** with a message that
the profile-claim migration has not been applied yet.

---

## 1. Push the repository

The branch `arena/a14c14ae-handoff-payments` (or `main` after merge) must contain
`render.yaml`, `server.js`, `package.json`, and `package-lock.json` at the
repository **root**. Render reads the Blueprint from the repository root.

---

## 2. Create the Blueprint

1. Sign in at <https://dashboard.render.com>.
2. Click **New → Blueprint**.
3. Connect and select the `Arinzaay007/handoff-payments` repository, then choose
   the branch you pushed.
4. Render detects `render.yaml` and shows the `handoff-payments` web service.
5. Click **Apply** / **Create**.

Render will prompt for the five variables listed below. Fill each one in; leave
nothing to chance, and leave no secret in the repo.

| Variable | Value | Secret? |
| --- | --- | --- |
| `DYNAMIC_ENVIRONMENT_ID` | Dynamic **Live** Environment ID | No (public by design) |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | No |
| `SUPABASE_SECRET_KEY` | the **newly rotated** `sb_secret_...` value | **Yes** |
| `MAX_MAINNET_USDC_MINOR` | `25000000` (25.00 USDC) | No |
| `MAX_DAILY_MAINNET_USDC_MINOR` | `100000000` (100.00 USDC) | No |

Notes:

- `SUPABASE_SECRET_KEY` is the current Supabase name. `SUPABASE_SERVICE_ROLE_KEY`
  is still accepted by the server for legacy projects, but prefer the new name.
  Use only a newly rotated value — never a key that appeared in a chat.
- No Supabase anon/publishable key is needed for this server-first flow.
- The two `MAX_*` values are non-secret caps in USDC's six-decimal minor units.
  The server also falls back to exactly these defaults if you leave them unset.

The Blueprint already sets the required build and start commands:

```
Build:  npm ci && npm run build
Start:  npm start
Health: /api/config
Plan:   free
```

`npm run build` runs esbuild and regenerates `public/dynamic-client.js`, so the
Dynamic SDK bundle is never committed to Git.

---

## 3. Wait for the deploy

Render runs `npm ci && npm run build`, then `npm start`. The Node server binds
to `0.0.0.0` and reads the `PORT` that Render injects, so no port configuration
is needed.

The health check hits `GET /api/config`, which returns readiness booleans and
the mainnet caps only:

```bash
curl https://<your-service>.onrender.com/api/config
```

Expect:

```json
{"dynamicConfigured":true,"databaseConfigured":true,
 "mainnetGuards":{"maximumPaymentUsdc":25,"maximumDailyUsdc":100}}
```

If `databaseConfigured` is `false`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are
missing or wrong. The app is intentionally **fail-closed**: the public resolver
and username claims return **503** rather than falling back to any wallet data.

---

## 4. Finish the Dynamic CORS setup

Recipient sign-in is limited to **email OTP and passkeys**, with **embedded EVM
wallets** provisioned for the recipient. In the Dynamic Live dashboard, confirm
that phone, SMS, WhatsApp, and social sign-in are disabled, and that embedded
EVM wallets are enabled. Confirm the environment's chain settings as well.
`http://localhost:3000` may already be an allowed origin. You must add the exact
deployed origin:

1. Copy the Render domain, e.g. `https://handoff-payments.onrender.com`.
2. In Dynamic dashboard → **Security** → **CORS Origins**, add that exact
   origin, e.g. `https://handoff-payments.onrender.com`.
3. Do **not** use a wildcard such as `https://*.onrender.com` for a payments app.

Until the origin is added, the browser cannot initialise the Dynamic SDK and the
UI reports that secure sign-in is unavailable on this origin.

---

## 5. Verify safely

```bash
# Readiness (health check)
curl https://<your-service>.onrender.com/api/config

# Public config the browser receives — Dynamic ID only, never a key
curl https://<your-service>.onrender.com/api/public-config

# Fail-closed check before a profile exists (should be 503 without Supabase config)
curl "https://<your-service>.onrender.com/api/public/resolve?handle=someone"

# After claiming a username, resolution returns the active Monad wallet
curl "https://<your-service>.onrender.com/api/public/resolve?handle=your_username"
```

Then in a browser: open the domain, sign in with email OTP or a passkey, wait for
the wallet setup step to finish, claim a username, and confirm the handle resolves
to your Monad wallet. The app shows only a shortened wallet address after
activation. It never asks for a wallet address.

**Do not send funds yet.** No Relay execution, approval/permit handling, Solana
or TON adapter, persisted payment requests, status tracking, or receipt
reconciliation exists in this build. A quote is not a transfer. Start live
testing only with **Base USDC → Relay → Monad USDC** at a controlled low value,
after secure profile resolution works end to end.

---

## 6. Redeploys

Pushing to the configured branch triggers a new Render deploy automatically.
Changing a variable in Render's dashboard triggers a redeploy as well. Because
`public/dynamic-client.js` is a build artifact, you never need to commit it.
