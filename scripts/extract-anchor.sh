#!/usr/bin/env bash
# Extract Anchor from the Sailor monorepo with FULL history preserved.
#
#   ./scripts/extract-anchor.sh /tmp/anchor-ai-sdk
#
# The package lived in three places over its life, and the story matters:
#   1. earliest era at the repo root:    src/{llm,sandbox,tools}
#   2. then packages/agent (31 commits: the vertical slice, the original
#      evidence gates, the streaming wire path)
#   3. then packages/core (the Anchor rename and everything after)
# `git subtree split --prefix=packages/core` follows only the last one — it
# would drop the story's first acts. git filter-repo over all three path sets
# keeps them; the renames make every era land on the same repo-root layout
# (src/...), which is exactly the extracted package layout.
set -euo pipefail

TARGET="${1:?usage: extract-anchor.sh <target-dir>}"
MONOREPO="$(git rev-parse --show-toplevel)"
WORKDIR="$(mktemp -d)"
CLONE="$WORKDIR/anchor-extract"

command -v git-filter-repo >/dev/null 2>&1 || {
  echo "git-filter-repo is required: brew install git-filter-repo" >&2
  exit 1
}
[ -z "$(git -C "$MONOREPO" status --porcelain)" ] || {
  echo "working tree is dirty — commit or stash first" >&2
  exit 1
}

echo "==> fresh clone (filter-repo must never touch the monorepo)"
git clone -q "$MONOREPO" "$CLONE"

echo "==> rewriting history over all three path eras"
git -C "$CLONE" filter-repo \
  --path packages/core/ --path-rename packages/core/: \
  --path packages/agent/ --path-rename packages/agent/: \
  --path src/llm --path src/sandbox --path src/tools

echo "==> seeding $TARGET"
rm -rf "$TARGET"
mv "$CLONE" "$TARGET"
git -C "$TARGET" branch -m anchor-main

cat <<NEXT

anchor-main is ready in $TARGET. Finish the extraction (DEFERRED.md → Phase 4):

  1. First commit in the new repo:
       node scripts/prepare-publish.mjs        # flip main/types/exports to dist
       # add "prepare": "npm run build" in the same commit (github: installs)
       # set "version": "0.1.0"
  2. Push:
       git -C $TARGET remote add origin git@github.com:hrithikkoduri/anchor-ai-sdk.git
       git -C $TARGET push -u origin anchor-main:main
     (CI rides the split: .github/workflows/ci.yml is already in the tree.)
  3. Later releases: publish from CI with \`npm publish --provenance\`, so each
     version is linked to the commit that built it.
  4. Sailor switchover in ONE change: dependency → github:hrithikkoduri/
     anchor-ai-sdk#v0.1.0 (or the npm release); imports are already
     \`anchor-ai-sdk\` (renamed pre-split); delete packages/core; move
     apps/evals into the package repo.
NEXT
