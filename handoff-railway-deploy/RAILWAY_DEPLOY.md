# Handoff → Railway deployment

This package contains no production secret. Keep `.env.local` out of GitHub and Railway source uploads.

## 1. Put this project on GitHub

1. Create a new **private** GitHub repository, for example `handoff-payments`.
2. Upload this package's contents to the repository root (the folder containing `package.json`).
3. Confirm GitHub does **not** show `.env.local` or any key file.

## 2. Create the Railway deployment

1. Sign in at https://railway.app with GitHub.
2. Choose **New Project** → **Deploy from GitHub repo**.
3. Select the `handoff-payments` repository and click **Deploy**.
4. Open the new service → **Settings** → **Deploy** and set:
   - Build command: `npm run build`
   - Start command: `npm start`
   - Healthcheck path: `/api/config`

## 3. Add service variables

Open the service → **Variables**. Add the values directly; never commit or share the secret key.

```env
NODE_ENV=production
DYNAMIC_ENVIRONMENT_ID=your Dynamic Live Environment ID
SUPABASE_URL=your Supabase project URL
SUPABASE_SECRET_KEY=your newly rotated Supabase sb_secret value
MAX_MAINNET_USDC_MINOR=25000000
MAX_DAILY_MAINNET_USDC_MINOR=100000000
```

If your project has only a legacy key while you are migrating, Railway can use `SUPABASE_SERVICE_ROLE_KEY` instead. Use only a **newly rotated** value; do not use a key exposed in chat.

Click **Deploy** after adding variables.

## 4. Get your public URL

In the service → **Settings** → **Networking**, click **Generate Domain**.

Then add that exact HTTPS origin to Dynamic Live → **Security** → **CORS Origins**. Keep `http://localhost:3000` for local work.

## 5. Verify safely

- `https://your-railway-domain/api/config` should report `dynamicConfigured: true` and `databaseConfigured: true`.
- Open the root domain, sign in with email, and claim a Handoff username.
- Verify `https://your-railway-domain/api/public/resolve?handle=your_username` returns your registered Monad recipient wallet.

Do not test payments or send funds until the Base USDC → Monad execution path, request persistence, and transaction status handling are implemented.
