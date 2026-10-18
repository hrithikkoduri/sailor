#!/usr/bin/env bash
# Grade a predictions file with the official SWE-bench harness, locally in Docker.
#
#   apps/evals/scripts/grade.sh <predictions.jsonl> <run_id> [instance_ids...]
#
# Hard-won details (learned 2026-10-18):
#   - swebench 5.x wants the CURRENT dataset (SWE-bench/SWE-bench_Lite) — the
#     legacy princeton-nlp path lacks per-row `image` fields and fails with
#     KeyError: 'image'.
#   - DOCKER_CONFIG is pointed at an empty config: otherwise the docker SDK
#     wants docker-credential-osxkeychain on PATH even for public pulls.
#   - amd64 eval images run under Docker Desktop emulation on arm64 Macs —
#     slow, but faithful. The images are amd64-ONLY, so the platform must be
#     forced: without DOCKER_DEFAULT_PLATFORM the pull 404s with "no matching
#     manifest for linux/arm64/v8".
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
preds="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
run_id="$2"
shift 2

out="$root/.eval-runs/grading/$run_id"
mkdir -p "$out/docker-config"
printf '{}' >"$out/docker-config/config.json"

instance_args=()
if [ "$#" -gt 0 ]; then instance_args=(-i "$@"); fi

DOCKER_CONFIG="$out/docker-config" DOCKER_DEFAULT_PLATFORM=linux/amd64 \
  "$root/.venv/bin/python" \
  -m swebench.harness.run_evaluation \
  -d SWE-bench/SWE-bench_Lite \
  -p "$preds" \
  -id "$run_id" \
  --max_workers 1 \
  --report_dir "$out" \
  "${instance_args[@]}"
