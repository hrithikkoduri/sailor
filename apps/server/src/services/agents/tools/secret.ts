/**
 * `run_with_secret` — how an agent uses an account secret.
 *
 * The value is read server-side for exactly one command, injected into that
 * command's environment, and then scrubbed from the observation before the
 * engine records or streams it. Nothing is returned to the model, so the value
 * never enters the conversation, the trace, or a published diff.
 *
 * The run executor also registers every stored value with a `SecretRedactor`
 * that wraps all tools and trace sinks, so a later `cat` of a file the secret
 * was written to is scrubbed too. Honest limit: a shell can transform a value
 * (`base64`, hashing, splitting), so this cannot make exfiltration impossible;
 * it makes accidental exposure (echo, stack traces, `env`) safe.
 */
import { defineTool, type Sandbox } from "anchor-ai-sdk";
import type { Db } from "../../../db/index.js";
import { getSecretValue, secretCatalog } from "../../secrets/store.js";
import type { SecretRedactor } from "../../secrets/redactor.js";

const REDACTED = "[REDACTED]";

/** Replace every literal occurrence of the value, including in error output. */
export function redactValue(text: string, value: string): string {
  if (!value) return text;
  return text.split(value).join(REDACTED);
}

export function secretTools(args: {
  db: Db;
  threadId: string;
  userId: string | null;
  sandbox: Sandbox;
  redactor?: SecretRedactor;
}) {
  return [
    defineTool(
      {
        name: "run_with_secret",
        description:
          "Run one shell command with a stored account secret injected as an environment variable. Use this instead of asking the user to paste a key. The secret's value is never shown to you: reference it by name and use the env var the secret declares. If the secret does not exist, ask the user to add it in Settings → Secrets (by name), then continue.",
        parameters: {
          type: "object",
          properties: {
            secret: {
              type: "string",
              description: "The secret's name as shown in Settings, e.g. daytona",
            },
            command: {
              type: "string",
              description:
                "Shell command run in the workspace. Reference the value through its environment variable.",
            },
            timeout_secs: {
              type: "number",
              description: "Optional timeout; defaults to 600.",
            },
          },
          required: ["secret", "command"],
          additionalProperties: false,
        },
      },
      async (input) => {
        const name = typeof input.secret === "string" ? input.secret.trim() : "";
        const command = typeof input.command === "string" ? input.command : "";
        if (!name || !command.trim())
          return { ok: false, content: "Both a secret name and a command are required." };
        if (!args.userId)
          return {
            ok: false,
            content: "Secrets belong to an account; this thread has no owner to draw them from.",
          };

        const found = await getSecretValue(args.db, args.userId, name);
        if (!found) {
          const available = (await secretCatalog(args.db, args.userId)).map((s) => s.name);
          return {
            ok: false,
            content:
              available.length
                ? `No secret named "${name}". Available: ${available.join(", ")}. Pick one of those, or ask the user to add "${name}" in Settings → Secrets.`
                : `No secrets are configured. Ask the user to add one in Settings → Secrets (name "${name}"), then retry. Never ask for the value in chat.`,
          };
        }

        // Register before the command runs: any output the shell produces is
        // then covered by the global tool/trace wrapper, not just this result.
        args.redactor?.add(found.value);
        const timeoutSecs = Math.min(
          3600,
          Math.max(5, Number(input.timeout_secs) || 600),
        );
        const result = await args.sandbox.exec(command, {
          timeoutSecs,
          env: { [found.envVar]: found.value },
        });
        return {
          ok: result.exitCode === 0,
          // The observation is what the engine persists and streams — scrub it.
          content: redactValue(result.output, found.value).slice(0, 8000),
          meta: { exitCode: result.exitCode, secret: name },
        };
      },
      { verb: "Running a command with a stored secret" },
    ),
  ];
}
