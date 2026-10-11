#!/usr/bin/env bash
# Safe, credential-free release runner for Handoff.
#
# The script contains no secrets. Provide credentials only through the execution environment's
# secret manager; never paste them into a chat, commit, .env file, or remote URL.
#
# Usage:
#   bash scripts/release-production.sh --check
#   bash scripts/release-production.sh --release
#
# --check validates the clean branch and runs the build/test gate. --release additionally pushes
# the release branch, applies Supabase migrations through the official CLI (or performs an explicit
# guarded skip for a migration already verified as manually applied), merges its PR to main, starts
# a Render deploy, waits for it to become live, and checks /api/config.
set -Eeuo pipefail

BRANCH="arena/exact-output-merchant-settlement"
BASE_BRANCH="main"
MODE="${1:---check}"

if [[ "$MODE" != "--check" && "$MODE" != "--release" ]]; then
  echo "Usage: bash scripts/release-production.sh [--check|--release]" >&2
  exit 64
fi

fail() { echo "Release stopped: $*" >&2; exit 1; }
need() { [[ -n "${!1:-}" ]] || fail "Missing required secret/configuration: $1"; }

[[ "$(git branch --show-current)" == "$BRANCH" ]] || fail "Check out $BRANCH before releasing."
git diff --quiet || fail "Working tree has unstaged changes. Commit or discard them first."
git diff --cached --quiet || fail "Index has staged but uncommitted changes. Commit them first."

echo "==> Building recipient Dynamic bundle"
npm run build

echo "==> Running test suite"
npm test

echo "==> Local release gate passed on $(git rev-parse --short HEAD)"

if [[ "$MODE" == "--check" ]]; then
  cat <<'EOF'

No remote actions were taken.

Before --release, securely inject these values into the execution environment:
  GH_TOKEN                 Fine-grained GitHub token: contents + pull-request write access
  SUPABASE_DB_URL          Direct Postgres connection string for the production project
                          (not needed only with the guarded manual-migration skip below)
  SUPABASE_MIGRATIONS_ALREADY_APPLIED=yes
                          Only after the production schema has been manually verified as current
                          and Supabase CLI migration history has not yet been reconciled
  RENDER_API_KEY           Render API key with deployment access
  RENDER_SERVICE_ID        Render web-service ID for handoff-payments
  HANDOFF_PUBLIC_URL       Canonical deployed URL, e.g. https://payments.example.com
  DYNAMIC_RECIPIENT_AUTH_VERIFIED=yes

DYNAMIC_RECIPIENT_AUTH_VERIFIED may only be set after a human verifies in the live Dynamic
Dashboard that passkey is first, email OTP is the only fallback, and phone/SMS/WhatsApp/social/
external-wallet/key-management paths are disabled for recipients.

SUPABASE_MIGRATIONS_ALREADY_APPLIED=yes is an explicit one-release escape hatch for a production
schema that was manually applied and verified but is absent from Supabase CLI migration history.
It skips db push; it does not claim to reconcile migration history. Do not set it without that
verification.
EOF
  exit 0
fi

need GH_TOKEN
need RENDER_API_KEY
need RENDER_SERVICE_ID
need HANDOFF_PUBLIC_URL
[[ "${DYNAMIC_RECIPIENT_AUTH_VERIFIED:-}" == "yes" ]] || fail "Dynamic recipient sign-in has not been verified. Do not release yet."
command -v gh >/dev/null || fail "GitHub CLI (gh) is required in the release environment."
command -v curl >/dev/null || fail "curl is required in the release environment."
command -v node >/dev/null || fail "node is required in the release environment."

echo "==> Authenticating GitHub CLI from the injected secret"
printf '%s' "$GH_TOKEN" | gh auth login --hostname github.com --with-token >/dev/null
gh auth setup-git >/dev/null

echo "==> Pushing $BRANCH"
git push -u origin "$BRANCH"

echo "==> Creating or reusing pull request"
PR_NUMBER="$(gh pr list --head "$BRANCH" --base "$BASE_BRANCH" --state open --json number --jq '.[0].number // empty')"
if [[ -z "$PR_NUMBER" ]]; then
  gh pr create --base "$BASE_BRANCH" --head "$BRANCH" \
    --title "Release exact-output and invisible-recipient experience" \
    --body "Deploy Relay exact-output settlement and passkey-first, no-crypto recipient UX." >/dev/null
  PR_NUMBER="$(gh pr list --head "$BRANCH" --base "$BASE_BRANCH" --state open --json number --jq '.[0].number // empty')"
fi
[[ -n "$PR_NUMBER" ]] || fail "Could not locate the release pull request."

if [[ "${SUPABASE_MIGRATIONS_ALREADY_APPLIED:-}" == "yes" ]]; then
  echo "==> Skipping Supabase CLI migration push: manually applied production schema was explicitly verified"
  echo "    Reconcile Supabase CLI migration history before the next automated migration release."
else
  need SUPABASE_DB_URL
  echo "==> Applying tracked Supabase migrations before application deployment"
  # The Supabase CLI tracks remote migration history. It refuses unsafe divergence instead of
  # blindly replaying SQL; resolve any reported history mismatch in the dashboard before continuing.
  npx --yes supabase db push --db-url "$SUPABASE_DB_URL"
fi

echo "==> Merging PR #$PR_NUMBER to $BASE_BRANCH"
gh pr merge "$PR_NUMBER" --merge --delete-branch=false

git fetch origin "$BASE_BRANCH"
MAIN_SHA="$(git rev-parse "origin/$BASE_BRANCH")"
echo "==> $BASE_BRANCH now points to ${MAIN_SHA:0:12}"

echo "==> Starting Render deployment"
DEPLOY_RESPONSE="$(curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $RENDER_API_KEY" \
  --header 'Accept: application/json' \
  "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys")"
DEPLOY_ID="$(node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { const json = JSON.parse(body); if (!json.id) process.exit(2); process.stdout.write(json.id); });' <<<"$DEPLOY_RESPONSE")" || fail "Render did not return a deployment ID."

echo "==> Waiting for Render deployment $DEPLOY_ID"
for _ in $(seq 1 80); do
  STATUS_RESPONSE="$(curl --fail-with-body --silent --show-error \
    --header "Authorization: Bearer $RENDER_API_KEY" \
    --header 'Accept: application/json' \
    "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys/$DEPLOY_ID")"
  DEPLOY_STATUS="$(node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { const json = JSON.parse(body); process.stdout.write(String(json.status || "unknown")); });' <<<"$STATUS_RESPONSE")"
  echo "    Render: $DEPLOY_STATUS"
  case "$DEPLOY_STATUS" in
    live) break ;;
    build_failed|update_failed|canceled|deactivated) fail "Render deployment ended as $DEPLOY_STATUS." ;;
  esac
  sleep 15
done
[[ "${DEPLOY_STATUS:-}" == "live" ]] || fail "Timed out waiting for Render deployment."

BASE_URL="${HANDOFF_PUBLIC_URL%/}"
echo "==> Checking production health at $BASE_URL/api/config"
curl --fail-with-body --silent --show-error "$BASE_URL/api/config" | node -e '
  let body = "";
  process.stdin.on("data", chunk => body += chunk);
  process.stdin.on("end", () => {
    const config = JSON.parse(body);
    if (config.dynamicConfigured !== true || config.databaseConfigured !== true || config.relayConfigured !== true) {
      console.error(JSON.stringify(config));
      process.exit(2);
    }
    console.log("Production health/configuration check passed.");
  });
'

echo "==> Release complete. Do not run a paid mainnet payment without explicit payer approval."
