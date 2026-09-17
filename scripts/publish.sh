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
set -a
source .env
set +a
npx wrangler pages deploy dist --project-name=ai-upskill-learning-site

echo "==> Verifying the live site"
sleep 2
# The site sits behind Cloudflare Access, so an anonymous request is expected
# to be redirected to the Access login page. That redirect, or a plain 200 if
# the gate is ever removed, means the site is up. Anything else does not.
read -r CODE LOCATION < <(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" https://ai-upskill-learning-site.pages.dev/)
if [ "$CODE" = "302" ] && [[ "$LOCATION" == https://*.cloudflareaccess.com/* ]]; then
  echo "==> Live, behind Cloudflare Access: https://ai-upskill-learning-site.pages.dev (HTTP 302 to the login page)"
elif [ "$CODE" = "200" ]; then
  echo "WARNING: live site returned HTTP 200 without a login. Is the Cloudflare Access gate still on?"
  exit 1
else
  echo "WARNING: live site returned HTTP $CODE, not the Access login redirect. Check manually before reporting success"
  exit 1
fi
