#!/usr/bin/env bash
# Prepare a name-claim release of anchor-ai-sdk in a TEMP COPY — never publish
# from the monorepo (its exports point at src/ on purpose; the temp copy gets
# the dist flip). Prints the final `npm publish` step for you to run (it asks
# for the 2FA one-time password).
#
#   ./scripts/publish-claim.sh [/tmp/anchor-publish]
set -euo pipefail

MONOREPO="$(git rev-parse --show-toplevel)"
DEST="${1:-/tmp/anchor-publish}"

echo "==> copying packages/core → $DEST"
rm -rf "$DEST"
cp -r "$MONOREPO/packages/core" "$DEST"

cd "$DEST"
echo "==> flipping entry points to dist"
node scripts/prepare-publish.mjs

echo "==> installing + building"
npm install --silent
npm run --silent build

echo "==> contents that would ship:"
npm pack --dry-run

echo
echo "To claim the name as anchor-ai-sdk@0.0.1, run:"
echo
echo "    cd $DEST && npm publish"
echo
echo "(2FA prompt; unscoped packages publish public by default.)"
echo "Verify with:  npm view anchor-ai-sdk"
