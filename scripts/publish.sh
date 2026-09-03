#!/usr/bin/env bash
# The deterministic tail of publishing a content change: build (validates),
# commit whatever is already staged, push, deploy to Cloudflare Pages, and
# verify the live site actually responds. Run this AFTER `git add` for
# exactly what changed — this script doesn't decide what belongs in the
# commit, only what to do once that's decided.
#
# Usage: scripts/publish.sh "commit message"
set -euo pipefail
cd "$(dirname "$0")/.."

MSG="${1:?Usage: scripts/publish.sh \"commit message\"}"

echo "==> Building (validates every deck's data before anything ships)"
npm run build

if git diff --cached --quiet; then
  echo "==> Nothing staged — skipping commit/push, still deploying current dist/"
else
  echo "==> Committing"
  git commit -m "$MSG

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
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
CODE=$(curl -s -o /dev/null -w "%{http_code}" https://ai-upskill-learning-site.pages.dev/)
if [ "$CODE" != "200" ]; then
  echo "WARNING: live site returned HTTP $CODE, not 200 — check manually before reporting success"
  exit 1
fi
echo "==> Live: https://ai-upskill-learning-site.pages.dev (HTTP $CODE)"
