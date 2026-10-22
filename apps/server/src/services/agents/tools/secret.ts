/**
 * `secrets` — the one account-secret tool.
 *
 * Modes:
 *   list_secret  → names and env vars only, never values.
 *   use_secret   → read one value server-side, inject it into one command,
 *                  and scrub the observation. The model never sees the value.
 *   ask_user     → pause the run and open a secure form in chat. The form
 *                  posts the value directly to /api/secrets; the answer that
 *                  resumes the run is only the secret's name.
 *
 * Never ask the user to paste a secret into chat or a repository file. The
 * form is the only write path.
 */
import { defineTool, type Sandbox } from "anchor-ai-sdk";
import { schema, type Db } from "../../../db/index.js";
import { getSecretValue, secretCatalog } from "../../secrets/store.js";
import { parseQuestions } from "../../threads/questions.js";
import type { SecretRedactor } from "../../secrets/redactor.js";

const REDACTED = "[REDACTED]";

/** Replace every literal occurrence of the value, including in error output. */
export function redactValue(text: string, value: string): string {
  if (!value) return text;
  return text.split(value).join(REDACTED);
}

/** The sandbox's own ceiling; interruption comes from the run signal, not a cap. */
const DEFAULT_TIMEOUT_SECS = 600;
const MAX_TIMEOUT_SECS = 3600;

/** Resolves when the run is cancelled, so a blocked command never holds the run. */
function untilAborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

function envVarFor(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "SECRET";
}

export function secretTools(args: {
  db: Db;
  threadId: string;
  userId: string | null;
  sandbox: Sandbox;
  redactor?: SecretRedactor;
  /** The run's cancel signal: a stop or interject returns from use_secret at once. */
  signal?: AbortSignal;
  /** Pause this run and surface the form; the engine aborts at the tool boundary. */
  onQuestions?: (requestId: string) => void;
  notify?: () => void;
}) {
  return [
    defineTool(
      {
        name: "secrets",
        description:
          "Account secrets, one tool with three modes. list_secret returns existing names/env vars (never values). use_secret runs one shell command with one stored value injected as its env var; the value is never shown to you. ask_user opens a secure form in chat when no existing secret matches; the user stores the value directly and the run pauses. Never ask the user to paste a secret into chat, a file, or a note.",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["list_secret", "use_secret", "ask_user"],
              description: "Which secret operation to perform.",
            },
            secret: {
              type: "string",
              description: "Secret name as shown in Settings, e.g. daytona (use_secret/ask_user).",
            },
            command: {
              type: "string",
              description: "Shell command for use_secret; reference the value through its env var.",
            },
            env_var: {
              type: "string",
              description: "Environment variable for ask_user, e.g. DAYTONA_API_KEY. Derived from the name when omitted.",
            },
            title: {
              type: "string",
              description: "Short form title for ask_user.",
            },
            description: {
              type: "string",
              description: "How to create/fetch the key for ask_user (link or short instructions).",
            },
            timeout_secs: {
              type: "number",
              description: `Optional use_secret timeout in seconds; default ${DEFAULT_TIMEOUT_SECS}, max ${MAX_TIMEOUT_SECS}.`,
            },
          },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      async (input) => {
        const mode = typeof input.mode === "string" ? input.mode : "";
        if (!args.userId)
          return {
            ok: false,
            content: "Secrets belong to an account; this thread has no owner to draw them from.",
          };

        if (mode === "list_secret") {
          const catalog = await secretCatalog(args.db, args.userId);
          return {
            ok: true,
            content: catalog.length
              ? JSON.stringify(catalog)
              : "No secrets are configured for this account.",
            meta: { count: catalog.length },
          };
        }

        const name = typeof input.secret === "string" ? input.secret.trim() : "";
        if (!name) return { ok: false, content: "A secret name is required." };

        if (mode === "ask_user") {
          const catalog = await secretCatalog(args.db, args.userId);
          if (catalog.some((secret) => secret.name === name))
            return {
              ok: true,
              content: `Secret "${name}" already exists. Use mode use_secret with that name.`,
            };

          const envVar = typeof input.env_var === "string" && input.env_var.trim()
            ? input.env_var.trim()
            : envVarFor(name);
          const title = typeof input.title === "string" && input.title.trim()
            ? input.title.trim().slice(0, 200)
            : `Secret needed: ${name}`;
          const description = typeof input.description === "string"
            ? input.description.trim().slice(0, 1000)
            : "";
          let question;
          try {
            [question] = parseQuestions([{
              id: "secret",
              type: "secret",
              label: `Add the ${name} secret`,
              ...(description ? { description } : {}),
              secretName: name,
              secretEnvVar: envVar,
              required: true,
            }]);
          } catch (err) {
            return { ok: false, content: err instanceof Error ? err.message : "Invalid secret request." };
          }

          const [request] = await args.db
            .insert(schema.questionRequests)
            .values({ threadId: args.threadId, title, questions: [question!] })
            .returning();
          args.onQuestions?.(request!.id);
          args.notify?.();
          return {
            ok: true,
            content: "Secret form sent. Work is paused until the user stores it.",
            meta: { requestId: request!.id, secret: name, envVar },
          };
        }

        if (mode !== "use_secret")
          return { ok: false, content: `Unknown mode "${mode}". Use list_secret, use_secret, or ask_user.` };

        const command = typeof input.command === "string" ? input.command : "";
        if (!command.trim())
          return { ok: false, content: "A command is required for use_secret." };

        const found = await getSecretValue(args.db, args.userId, name);
        if (!found) {
          const available = (await secretCatalog(args.db, args.userId)).map((s) => s.name);
          return {
            ok: false,
            content: available.length
              ? `No secret named "${name}". Available: ${available.join(", ")}. Pick one, or use mode ask_user to request "${name}".`
              : `No secrets are configured. Use mode ask_user to request "${name}", then retry. Never ask for the value in chat.`,
          };
        }

        args.redactor?.add(found.value);
        const timeoutSecs = Math.min(
          MAX_TIMEOUT_SECS,
          Math.max(5, Number(input.timeout_secs) || DEFAULT_TIMEOUT_SECS),
        );
        const execution = args.sandbox.exec(command, {
          timeoutSecs,
          env: { [found.envVar]: found.value },
        });
        const result = args.signal
          ? await Promise.race([execution, untilAborted(args.signal)])
          : await execution;
        if (result === "aborted") {
          // The sandbox command may still finish on its own deadline; the run
          // must not wait for it to honour a stop or an interjection.
          execution.catch(() => undefined);
          return { ok: false, content: "Stopped: the run was interrupted before the command finished." };
        }
        return {
          ok: result.exitCode === 0,
          content: redactValue(result.output, found.value).slice(0, 8000),
          meta: { exitCode: result.exitCode, secret: name },
        };
      },
      { verb: "Using an account secret" },
    ),
  ];
}
