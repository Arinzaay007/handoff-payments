# Handoff — flat GitHub upload edition

This version is specifically arranged for repositories created with GitHub's browser uploader, which can flatten uploaded folders on mobile devices.

## Render deployment

1. Upload every file in this folder to the GitHub repository root.
2. In Render, choose **New → Blueprint** and select the repository.
3. Enter Dynamic Environment ID, Supabase URL, and a newly rotated Supabase secret key when prompted. Never commit or share secrets.
4. Render deploys with `npm ci && npm run build` and starts with `npm start`.
5. Add the generated `https://*.onrender.com` domain to Dynamic Live CORS Origins.

The app serves only its browser assets. Server API routes validate Dynamic sessions and use the secret key only at runtime.
