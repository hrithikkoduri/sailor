# @anchor/evals — the harness benchmark

Scores **Anchor as a harness** on a SWE-bench subset. This is not a product
feature and not part of the package: it is a repo-level app that imports
`@anchor/core` directly — no worker, no queue, no webhook, no database — which
makes it the framework's second consumer. Its only product coupling is the
`sailor` arm's agent configuration.

## Layout

```
src/runner.ts       the generic runner: tasks → fresh sandbox → arm → git diff
                    (the future Anchor lift; one isolated module, by design)
src/arms/sailor.ts  system under test #1: createSailorAgent minus GitHub tools
src/arms/*          #2 (planned): mini-swe-agent — a foreign-harness baseline
src/tasks.ts        SWE-bench row → EvalTask (arms never see gold patches)
src/main.ts         CLI: predictions.jsonl + results.jsonl + run.json + traces/
scripts/fetch-tasks.mjs   the task subset fetcher (HF datasets-server)
```

## Run it

```bash
# 1. fetch a subset (committed subsets are reproducible; keep them small)
node apps/evals/scripts/fetch-tasks.mjs --limit 10 --out apps/evals/data/swebench-lite-10.jsonl

# 2. dev smoke: one task on this machine
npm run eval -w apps/evals -- --tasks data/swebench-lite-10.jsonl --provider local --limit 1

# 3. a real run: toolchain microVMs, generous budgets
npm run eval -w apps/evals -- --tasks data/swebench-lite-10.jsonl --provider heyo --max-steps 100
```

Outputs land in `.eval-runs/<timestamp>/`: `predictions.jsonl` is the official
grader's input, `results.jsonl` keeps status/steps/usage/cost, `traces/` holds
every engine event per task.

## Grading (next)

The patch producer and the grader are deliberately decoupled (and Heyo's
artifact store being flaky can't affect scoring): grading uses the **official
`swebench` harness locally in Docker**, which pulls its own per-instance
images and matches `instance_id`. Producing predictions needs no Docker.
