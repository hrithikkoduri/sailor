#!/usr/bin/env bash
# Build and publish the sandbox toolchain image (step 16).
#
#   ./image/build.sh             # build the rootfs only
#   ./image/build.sh --push      # build, then push to the artifact store
#
# What this produces is a Firecracker ext4 rootfs, which is what
# `heyctl artifact push` accepts (`--image`/file, never a docker tag). The
# docker image is only an intermediate: it is exported and re-materialized as
# ext4 in a Linux container, because fs ownership must be root's and macOS
# cannot do that natively.
#
# Push needs `heyctl` (cargo install hws) logged in to the namespace:
#   heyctl login --server "https://admin.us5.heyo.work" --token-stdin
# After a push, point .env at the tag:
#   HEYO_IMAGE=harness/sailor-toolchain:latest
#   HEYO_IMAGE_KIND=artifact
set -euo pipefail

TAG="${TAG:-harness/sailor-toolchain:latest}"
SIZE_MB="${SIZE_MB:-4096}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/image/.build"
EXT4="$BUILD/rootfs.ext4"

# Docker Desktop's CLI (and its credential helpers) is not always on PATH in
# non-login shells.
if [ -d /Applications/Docker.app/Contents/Resources/bin ]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
DOCKER="${DOCKER:-docker}"

mkdir -p "$BUILD"

echo "building sailor-toolchain:latest (linux/amd64)"
"$DOCKER" build --platform linux/amd64 \
  -f "$ROOT/image/Dockerfile" -t sailor-toolchain:latest "$ROOT/image"

echo "exporting the image filesystem"
cid="$("$DOCKER" create sailor-toolchain:latest)"
"$DOCKER" export "$cid" -o "$BUILD/rootfs.tar"
"$DOCKER" rm "$cid" >/dev/null

echo "materializing ext4 (${SIZE_MB} MB)"
"$DOCKER" run --rm --platform linux/amd64 -v "$BUILD:/out" ubuntu:24.04 bash -c "
set -e
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq e2fsprogs >/dev/null 2>&1
rm -rf /rootfs && mkdir -p /rootfs
tar -xf /out/rootfs.tar -C /rootfs
find /rootfs -type s -delete 2>/dev/null || true
find /rootfs -type p -delete 2>/dev/null || true
rm -f /out/rootfs.ext4
mke2fs -q -t ext4 -d /rootfs -F /out/rootfs.ext4 ${SIZE_MB}M
"
echo "built $EXT4"

if [ "${1:-}" = "--push" ]; then
  if ! command -v heyctl >/dev/null 2>&1; then
    echo "heyctl not found — install it with: cargo install hws" >&2
    exit 1
  fi
  heyctl artifact push "$EXT4" --tag "$TAG" --public
  echo "pushed $TAG — set HEYO_IMAGE=$TAG and HEYO_IMAGE_KIND=artifact in .env"
else
  echo "built $EXT4 (pass --push to publish)"
fi
