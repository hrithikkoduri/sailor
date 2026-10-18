/** One-time repair for runtime directives incorrectly stored as user messages.
 * Dry-run by default. --apply backs up originals, skips active threads, and
 * uses an optimistic comparison so concurrent conversation writes win.
 * Normal runtime history handling does not contain these old string rules.
 * The trace_events journal is never changed. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/db/index.js";
import { loadConfig, loadDotEnv } from "../src/config.js";
import type { LLMMessage } from "@anchor/core";

const oldPhaseDirectives = [
  "PHASE: reproduce — produce a failing test (or a failing existing test run) that demonstrates the bug",
  "PHASE: fix — make the failing test pass with a minimal change",
  "PHASE: fix — make the failing test pass with a minimal change.",
  "PHASE: verify — run the full test suite, review the diff, then finish",
  "PHASE: verify — run the full test suite, review the diff, then finish.",
];

export function repairThreadHistory(messages: LLMMessage[]): LLMMessage[] {
  return messages.filter((message) => {
    if (message.origin === "engine") return false;
    if (message.role !== "user") return true;
    const text = message.content ?? "";
    return (
      !oldPhaseDirectives.includes(text) &&
      !oldPhaseDirectives.some(
        (directive) => text === `Begin the task. ${directive}`,
      ) &&
      !/^You have spent \d+ turns in the "(?:reproduce|fix|verify)" phase \(soft limit \d+\)\./.test(
        text,
      ) &&
      text !==
        "Continue: call a tool, or call finish(summary, success) if the task is complete."
    );
  });
}

async function main() {
  loadDotEnv();
  const pool = createPool(loadConfig().postgres.url);
  try {
    const { rows } = await pool.query<{ id: string; messages: LLMMessage[] }>(
      "SELECT t.id,t.messages FROM threads t WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.thread_id=t.id AND r.status IN ('running','queued'))",
    );
    const changed = rows
      .map((row) => ({
        ...row,
        repaired: repairThreadHistory(row.messages ?? []),
      }))
      .filter((row) => row.messages.length !== row.repaired.length);
    console.log(
      `${changed.length} idle thread(s), ${changed.reduce((sum, row) => sum + row.messages.length - row.repaired.length, 0)} old runtime directive(s) to remove from working memory.`,
    );
    if (!process.argv.includes("--apply")) {
      console.log(
        "Dry run only. Use --apply to back up and repair working memory; trace events remain unchanged.",
      );
      return;
    }
    if (!changed.length) return;
    const directory = path.resolve(process.cwd(), ".anchor", "history-repair");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const backup = path.join(directory, `${Date.now()}.json`);
    await writeFile(
      backup,
      JSON.stringify(changed.map(({ id, messages }) => ({ id, messages }))),
      { mode: 0o600 },
    );
    let repaired = 0;
    for (const row of changed) {
      const result = await pool.query(
        "UPDATE threads SET messages=$1::jsonb WHERE id=$2 AND messages=$3::jsonb AND NOT EXISTS (SELECT 1 FROM runs WHERE thread_id=$2 AND status IN ('running','queued'))",
        [JSON.stringify(row.repaired), row.id, JSON.stringify(row.messages)],
      );
      repaired += result.rowCount ?? 0;
    }
    console.log(
      `Repaired ${repaired} thread(s). Original working memory saved to ${backup}. Trace journal untouched.`,
    );
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
