#!/usr/bin/env node
/**
 * Seed LocalStack's Secrets Manager with the secrets Sailor expects.
 *
 *   npm run secrets:local                      # create/update from .env values
 *   npm run secrets:local -- DAYTONA_API_KEY=... E2B_API_KEY=...
 *
 * LocalStack speaks the real AWS API, so the production adapter runs here with
 * AWS_ENDPOINT_URL=http://localhost:4566 and dummy credentials.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const envFile = `${root}.env`;
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    )
  : {};

const cli = Object.fromEntries(
  process.argv.slice(2).map((pair) => {
    const at = pair.indexOf("=");
    return at === -1 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
  }),
);

/** Secret name → environment variables it carries. */
const SECRETS = {
  "sailor/daytona": ["DAYTONA_API_KEY"],
  "sailor/e2b": ["E2B_API_KEY"],
  "sailor/llm": ["LLM_API_KEY"],
};

const docker = process.env.DOCKER_BIN ?? "docker";
const run = (args) => spawnSync(docker, args, { encoding: "utf8" });

const up = run(["compose", "up", "-d", "localstack"]);
if (up.status !== 0) {
  console.error((up.stderr || up.stdout || "could not start localstack").trim());
  process.exit(1);
}

// Wait for the Secrets Manager API (health endpoint flips before services are ready).
let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  const probe = run(["compose", "exec", "-T", "localstack", "awslocal", "secretsmanager", "list-secrets"]);
  ready = probe.status === 0;
  if (!ready) await new Promise((r) => setTimeout(r, 1000));
}
if (!ready) {
  console.error("localstack did not become ready on :4566");
  process.exit(1);
}

let written = 0;
for (const [name, keys] of Object.entries(SECRETS)) {
  const values = {};
  for (const key of keys) {
    const value = cli[key] || process.env[key] || fileEnv[key];
    if (value) values[key] = value;
  }
  if (!Object.keys(values).length) {
    console.log(`  ${name}: skipped (no ${keys.join(" / ")} set)`);
    continue;
  }
  const payload = JSON.stringify(values);
  const create = run([
    "compose", "exec", "-T", "localstack", "awslocal", "secretsmanager",
    "create-secret", "--name", name, "--secret-string", payload,
  ]);
  if (create.status === 0) {
    written += 1;
    console.log(`  ${name}: created (${Object.keys(values).join(", ")})`);
    continue;
  }
  const update = run([
    "compose", "exec", "-T", "localstack", "awslocal", "secretsmanager",
    "put-secret-value", "--secret-id", name, "--secret-string", payload,
  ]);
  if (update.status === 0) {
    written += 1;
    console.log(`  ${name}: updated (${Object.keys(values).join(", ")})`);
  } else {
    console.error(`  ${name}: failed — ${(update.stderr || update.stdout).trim()}`);
    process.exitCode = 1;
  }
}
console.log(`\n${written} secret(s) in localstack. Point the app at it with:`);
console.log("  SAILOR_SECRETS_BACKEND=aws AWS_ENDPOINT_URL=http://localhost:4566");
