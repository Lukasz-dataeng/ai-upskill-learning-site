#!/usr/bin/env bash
# The deterministic tail of publishing a content change: build (validates),
# commit whatever is already staged, push, deploy to Cloudflare Pages, and
# verify the live site actually responds. Run this AFTER `git add` for
# exactly what changed — this script doesn't decide what belongs in the
# commit, only what to do once that's decided.
#
# Usage: scripts/publish.sh "commit message"
#
# The message is committed exactly as given. Put any attribution trailer
# (e.g. Co-Authored-By for the model doing the work) in the message itself;
# the script does not add one, so it never goes stale when the model changes.
set -euo pipefail
cd "$(dirname "$0")/.."

MSG="${1:?Usage: scripts/publish.sh \"commit message\"}"

# Whose account this deploys to, and which site it then checks, comes from the
# gitignored .env and has no default: a copy of this repo cannot deploy
# anywhere until its own owner fills these in. Checked first, before the build
# and before any commit, so a missing setting costs nothing.
echo "==> Checking deploy settings (.env)"
if [ ! -f .env ]; then
  echo "ERROR: no .env. Copy .env.example to .env and fill in your own values."
  exit 1
fi
set -a
source .env
set +a
MISSING=""
for VAR in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_PROJECT_NAME SITE_URL SITE_BEHIND_LOGIN; do
  [ -n "${!VAR:-}" ] || MISSING="$MISSING $VAR"
done
if [ -n "$MISSING" ]; then
  echo "ERROR: .env is missing:$MISSING"
  echo "       See .env.example. CLOUDFLARE_PROJECT_NAME and SITE_URL are yours, not the"
  echo "       original author's: deploying to someone else's project is not possible anyway."
  exit 1
fi
if [ "$SITE_BEHIND_LOGIN" != "yes" ] && [ "$SITE_BEHIND_LOGIN" != "no" ]; then
  echo "ERROR: SITE_BEHIND_LOGIN must be yes or no, not \"$SITE_BEHIND_LOGIN\"."
  exit 1
fi
echo "    project $CLOUDFLARE_PROJECT_NAME, site $SITE_URL, login required: $SITE_BEHIND_LOGIN"

# dist/ is built from the working tree, not from git. A deck left in data/
# without being staged (say, a generated one turned down at the topic
# pipeline's second stop) would otherwise go live with whatever ships next.
echo "==> Checking data/ for content that is not staged"
UNSTAGED=$(git status --porcelain --untracked-files=all -- data/ | grep -v '^[MADR] ' || true)
if [ -n "$UNSTAGED" ]; then
  echo "ERROR: data/ has changes that are not staged, so they were never approved to ship:"
  echo "$UNSTAGED" | sed 's/^/       /'
  echo "       Stage them if they should go live, or move them out of data/, then run this again."
  exit 1
fi

echo "==> Building (validates every deck's data before anything ships)"
npm run build

# Quiz items can be generated against canned replies (lib/dial-stub.mjs) while
# DIAL access is being sorted. Useful locally, never publishable.
echo "==> Checking for stub content"
if grep -rl "\[stub\]" dist >/dev/null 2>&1; then
  echo "ERROR: dist/ contains [stub] content, generated without a real DIAL call."
  echo "       Regenerate it (npm run quiz -- --deck <id> --force) or remove the"
  echo "       offending data/quiz/<deck>.yaml, then run this again."
  exit 1
fi

if git diff --cached --quiet; then
  echo "==> Nothing staged — skipping commit/push, still deploying current dist/"
else
  echo "==> Committing"
  git commit -m "$MSG"
  echo "==> Pushing"
  git push
fi

echo "==> Deploying to Cloudflare Pages"
npx wrangler pages deploy dist --project-name="$CLOUDFLARE_PROJECT_NAME"

echo "==> Verifying the live site"
sleep 2
# With SITE_BEHIND_LOGIN=yes the site sits behind Cloudflare Access, so an
# anonymous request is expected to be redirected to the Access login page, and
# a plain 200 means the gate is off, which is a failure too. The trailing \n
# matters: without it read returns non-zero and set -e ends the script without
# a word.
read -r CODE LOCATION < <(curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "$SITE_URL")
if [ "$SITE_BEHIND_LOGIN" = "yes" ]; then
  if [ "$CODE" = "302" ] && [[ "$LOCATION" == https://*.cloudflareaccess.com/* ]]; then
    echo "==> Live, behind Cloudflare Access: $SITE_URL (HTTP 302 to the login page)"
  elif [ "$CODE" = "200" ]; then
    echo "WARNING: $SITE_URL returned HTTP 200 without a login. Is the Cloudflare Access gate still on?"
    exit 1
  else
    echo "WARNING: $SITE_URL returned HTTP $CODE, not the Access login redirect. Check manually before reporting success"
    exit 1
  fi
elif [ "$CODE" = "200" ]; then
  echo "==> Live: $SITE_URL (HTTP 200, no login)"
else
  echo "WARNING: $SITE_URL returned HTTP $CODE, not 200. Check manually before reporting success"
  exit 1
fi
