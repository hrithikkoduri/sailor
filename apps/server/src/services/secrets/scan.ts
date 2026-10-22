/**
 * Publication secret scan.
 *
 * Before a checkpoint or push, look at what the turn would actually deliver —
 * tracked changes plus untracked (non-ignored) files, minus `.anchor/` — and
 * refuse if any stored secret value appears literally. The scan runs inside
 * the sandbox with the values supplied only as ephemeral environment variables;
 * the output is file names, never values.
 *
 * This is an accident guard, not an exfiltration boundary. It catches the
 * common failure (a key pasted into a config or test fixture). It cannot catch
 * a transformed value; the honest limit is documented in `redactor.ts`.
 */
import { shq, type Sandbox } from "anchor-ai-sdk";
import type { Db } from "../../db/index.js";
import { secretValues } from "./store.js";
import { secretVariants } from "./redactor.js";

export interface WorkspaceSecretScan {
  /** False means publication must stop. */
  ok: boolean;
  /** Files that contain a known secret (paths only, never values). */
  matches: string[];
  /** Set when the scan itself could not run (fail closed). */
  error?: string;
}

export function containsSecret(text: string, values: string[]): boolean {
  return values.some((value) => secretVariants(value).some((variant) => text.includes(variant)));
}

/**
 * Scan the deliverable tree relative to `ref`.
 *
 * `git add -A` first: untracked work is exactly what a publication would carry.
 * The `.anchor/` scratch directory is excluded because `deliverPullRequest`
 * strips it from the published commit.
 */
export async function scanWorkspaceForSecrets(args: {
  db: Db;
  userId: string;
  sandbox: Sandbox;
  ref: string;
  /** Already-loaded values, when the caller also needs them for a text scan. */
  values?: string[];
}): Promise<WorkspaceSecretScan> {
  const values = args.values ?? (await secretValues(args.db, args.userId));
  const variants = [...new Set(values.flatMap(secretVariants))];
  if (variants.length === 0) return { ok: true, matches: [] };

  const env: Record<string, string> = {};
  variants.forEach((value, index) => {
    env[`SAILOR_SCAN_${index}`] = value;
  });
  const loopValues = variants.map((_, index) => `"$SAILOR_SCAN_${index}"`).join(" ");
  const script = [
    "set -eu",
    "git add -A >/dev/null 2>&1 || true",
    'SCAN_FILES=$(mktemp "${TMPDIR:-/tmp}/sailor-scan.XXXXXX")',
    'trap \'rm -f "$SCAN_FILES"\' EXIT',
    `{ git diff --cached --name-only ${shq(args.ref)} -- . ':(exclude).anchor';`,
    "  git ls-files --others --exclude-standard -- . ':(exclude).anchor'; } | sort -u > \"$SCAN_FILES\"",
    "while IFS= read -r file; do",
    '  [ -n "$file" ] || continue',
    '  [ -f "$file" ] || continue',
    `  for value in ${loopValues}; do`,
    '    [ -n "$value" ] || continue',
    '    if grep -qF -e "$value" -- "$file"; then printf \'SECRET_IN:%s\\n\' "$file"; break; fi',
    "  done",
    'done < "$SCAN_FILES"',
  ].join("\n");

  let result;
  try {
    result = await args.sandbox.exec(script, { timeoutSecs: 120, env });
  } catch (err) {
    return {
      ok: false,
      matches: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      matches: [],
      error: result.output.trim().slice(0, 500) || `scan exited ${result.exitCode}`,
    };
  }

  const matches = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("SECRET_IN:"))
    .map((line) => line.slice("SECRET_IN:".length))
    .filter(Boolean);
  return { ok: matches.length === 0, matches };
}
