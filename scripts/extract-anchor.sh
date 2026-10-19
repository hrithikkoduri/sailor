#!/usr/bin/env bash
# Extract Anchor (@anchor/core) from the Sailor monorepo into its own repo,
# with full history preserved. Run from the monorepo root on a clean tree.
#
#   ./scripts/extract-anchor.sh /tmp/anchor-sdk
#
# `git subtree split` rewrites history so that every commit touching
# packages/core exists on the new branch with the directory's contents at the
# repo root — real commits (authors, dates, messages), not an initial import.
# The decision log rides along (DESIGN entries are curated separately; see
# the extraction checklist in DEFERRED.md).
set -euo pipefail

TARGET="${1:?usage: extract-anchor.sh <target-dir>}"
MONOREPO="$(git rev-parse --show-toplevel)"
BRANCH="extract/anchor-$(date +%Y%m%d-%H%M%S)"

cd "$MONOREPO"
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty — commit or stash first" >&2
  exit 1
fi

echo "==> splitting packages/core into $BRANCH"
git subtree split --prefix=packages/core -b "$BRANCH"

echo "==> seeding $TARGET"
mkdir -p "$TARGET"
if [ ! -d "$TARGET/.git" ]; then
  git init -q "$TARGET"
fi
git -C "$TARGET" fetch "$MONOREPO" "refs/heads/$BRANCH:refs/heads/anchor-main"
git -C "$TARGET" switch anchor-main

cat <<'NEXT'

anchor-main is ready. Finish the extraction (see DEFERRED.md → Extraction):

  1. First commit in the new repo: flip main/types/exports to dist, add the
     "prepare" script (needed for `github:` installs), bump the version to
     0.1.0, curate DECISIONS.md from the monorepo DESIGN.md.
  2. Push:
       git -C <target> remote add origin git@github.com:hrithikkoduri/anchor-sdk.git
       git -C <target> push -u origin anchor-main:main
     (CI runs automatically — packages/core/.github/workflows/ci.yml rode
     the split into .github/workflows/ci.yml.)
  3. npm publish (name: anchor-ai-sdk; claim the name BEFORE pushing publicly).
  4. Switch Sailor over in ONE change: dependency → github:hrithikkoduri/
     anchor-sdk#v0.1.0 (or the npm release), update imports @anchor/core →
     anchor-ai-sdk (find/replace across apps/), delete packages/core, and move
     apps/evals with the package repo.
  5. The eval rounds (Opus 5.5 Lite-10, TerminalBench, METR, ProgramBench)
     resume in the new repo.
NEXT
