# @anchor/evals — the harness benchmark

Scores **Anchor as a harness** on SWE-bench. This is not a product feature and
not part of the package: it is a repo-level app that imports `@anchor/core`
directly — no worker, no queue, no webhook, no database — which makes it the
framework's second consumer. The system under test is the framework's own
`codingAgent` plus benchmark context added here; the only product import left
is the config loader (the same knobs the product reads).

## Layout

```
src/runner.ts       the generic runner: tasks → sandbox → arm → git diff (the
                    future Anchor lift; one isolated module, by design)
src/arms/anchor.ts  system under test #1: codingAgent + benchmark context
                    (#2 planned: mini-swe-agent, in the SAME container)
src/tasks.ts        SWE-bench row → EvalTask, incl. the task's Docker image
                    (arms never see gold patches)
src/main.ts         CLI: predictions.jsonl + results.jsonl + run.json + traces/
scripts/            fetch-tasks · grade · prepull-images · run-mini-baseline
data/               the committed task subset (deterministic, one per repo)
```

## Setup (once)

```bash
# grader venv
/opt/homebrew/bin/python3.12 -m venv apps/evals/.venv
apps/evals/.venv/bin/pip install swebench

# baseline-arm venv (isolated: mini pulls its own litellm stack)
/opt/homebrew/bin/python3.12 -m venv apps/evals/.venv-mini
apps/evals/.venv-mini/bin/pip install mini-swe-agent
```

Docker Desktop must be installed and running. **The eval images are
amd64-only** — the scripts force `DOCKER_DEFAULT_PLATFORM=linux/amd64`, and
the platform runs them under emulation on Apple Silicon (slower, but exactly
the images the SWE-bench numbers come from). The scripts also point
`DOCKER_CONFIG` at an empty config so public pulls never ask for the macOS
keychain helper.

## Run it

```bash
# 1. fetch a subset (or use the committed data/swebench-lite-10.jsonl)
node apps/evals/scripts/fetch-tasks.mjs --limit 10 --out apps/evals/data/swebench-lite-10.jsonl

# 2. the real thing: the official task image (repo at /testbed, deps installed)
DOCKER_BIN=/Applications/Docker.app/Contents/Resources/bin/docker \
  npm run eval -w apps/evals -- --tasks data/swebench-lite-10.jsonl \
  --provider docker --model z-ai/glm-5.3 --max-steps 60

# 3. bigger sets: Verified (500) or the full benchmark (2294) — fetch on demand
node apps/evals/scripts/fetch-tasks.mjs --dataset SWE-bench/SWE-bench_Verified \
  --limit 500 --out apps/evals/data/swebench-verified.jsonl

# dev smoke stays cheap: same command with --provider local
```

Outputs land in `.eval-runs/<timestamp>/`: `predictions.jsonl` is the official
grader's input, `results.jsonl` keeps status/steps/usage/cost, `traces/` holds
every engine event per task.

## Grade

```bash
apps/evals/scripts/grade.sh <predictions.jsonl> <run_id> [instance_ids...]
# e.g. apps/evals/scripts/grade.sh .eval-runs/smoke/predictions.jsonl smoke1 psf__requests-1963
```

Runs the **official `swebench` harness** locally in Docker (it pulls its own
per-instance images and matches `instance_id`s) and writes
`<model>.<run_id>.json` under `.eval-runs/grading/<run_id>/`. Patch production
is fully decoupled from grading — Docker quirks can never corrupt a run.

## Baseline arm

```bash
apps/evals/scripts/run-mini-baseline.sh [filter-regex]
```

Runs **mini-swe-agent's own harness** (`mini-extra swebench`) in its own Docker
environments, on the same instances and the same model — the "minimal harness
A%" number. Predictions land in `.eval-runs/mini/`.

## Read the numbers with this caveat

DeepSeek V4.1 Flash has SWE-bench Lite memorized for popular instances: the
first smoke task (`psf__requests-1963`) returned the verbatim gold patch and
the hidden gold test, from the problem statement alone. Runs default to
less-memorized models (GLM 5.3; Claude Opus 5.5 for comparison), and the
report flags exact/near gold-patch matches. The A/B still measures the
harnesses head-to-head (same instances, same model), but absolute Lite scores
overstate real capability — the seeded-bug track (repos we control, post-cutoff
commits) is the contamination-free complement.
