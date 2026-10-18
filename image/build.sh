#!/usr/bin/env bash
# Build and publish the sandbox toolchain image (step 16).
#
#   ./image/build.sh             # build only
#   ./image/build.sh --push      # build, then push to the Heyo artifact store
#
# Push needs the heyctl CLI (shipped by the `hws` Rust crate) with access to
# your namespace. After a successful push, set HEYO_IMAGE in .env to the tag
# below and re-run `sailor sandbox smoke --toolchain`.
set -euo pipefail

TAG="${TAG:-harness/sailor-toolchain:latest}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Docker Desktop's CLI (and its credential helpers) is not always on PATH in
# non-login shells.
if [ -d /Applications/Docker.app/Contents/Resources/bin ]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
DOCKER="${DOCKER:-docker}"

echo "building $TAG"
"$DOCKER" build -f "$ROOT/image/Dockerfile" -t "$TAG" "$ROOT/image"

if [ "${1:-}" = "--push" ]; then
  if ! command -v heyctl >/dev/null 2>&1; then
    echo "heyctl not found — install it with: cargo install hws" >&2
    echo "then push with: heyctl artifact push $TAG" >&2
    exit 1
  fi
  heyctl artifact push "$TAG"
  echo "pushed $TAG — set HEYO_IMAGE=$TAG in .env"
else
  echo "built $TAG (pass --push to publish)"
fi
