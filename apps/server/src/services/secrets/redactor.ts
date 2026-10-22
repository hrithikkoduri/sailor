/**
 * Known-value redaction for the agent runtime.
 *
 * Anchor already strips token-shaped strings at the trace boundary. This adds
 * the values Sailor itself knows about: every stored account secret for the
 * thread owner. The redactor is applied to every tool result before the model
 * sees it and again to every trace/live event, so an accidental `env`, `cat`,
 * stack trace, or file read cannot turn a secret into conversation state.
 *
 * Honest limit: a shell can transform a value (`base64`, hashing, splitting).
 * We register the literal, base64, and URL-encoded forms — the cheap accidents
 * — but cannot make deliberate exfiltration impossible. The real boundary is
 * that a secret is only injected for one approved `secrets use_secret` call.
 */
import type { Tool, ToolResult, TraceSink, TracedEvent } from "anchor-ai-sdk";

export const REDACTED = "[REDACTED]";

/** Short values would replace ordinary words; real credentials are longer. */
const MIN_REDACT_LENGTH = 8;

/** Engine/product fields whose values select behavior, not user text. */
const STRUCTURAL_KEYS = new Set([
  "callId",
  "completion",
  "disposition",
  "id",
  "jobId",
  "kind",
  "name",
  "ok",
  "phase",
  "runId",
  "secretScan",
  "seq",
  "status",
  "step",
  "threadId",
  "tool",
  "ts",
  "type",
]);

/** Every literal form worth scrubbing for one secret value. */
export function secretVariants(value: string): string[] {
  if (value.length < MIN_REDACT_LENGTH) return [];
  const variants = new Set([value]);
  const base64 = Buffer.from(value, "utf8").toString("base64");
  if (base64.length >= MIN_REDACT_LENGTH) variants.add(base64);
  const url = encodeURIComponent(value);
  if (url !== value && url.length >= MIN_REDACT_LENGTH) variants.add(url);
  return [...variants];
}

export class SecretRedactor {
  private values = new Set<string>();
  private ordered: string[] = [];

  add(value: string): void {
    const variants = secretVariants(value);
    if (!variants.length) return;
    for (const variant of variants) this.values.add(variant);
    // Longest first: a base64 variant can contain a shorter literal by chance.
    this.ordered = [...this.values].sort((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.values.size;
  }

  redact(text: string): string {
    if (!text || this.ordered.length === 0) return text;
    let out = text;
    for (const value of this.ordered) out = out.split(value).join(REDACTED);
    return out;
  }

  /** Deep-copy a JSON-shaped value, redacting every string. */
  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as T;
    if (value && typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        // A secret value that happens to equal "tool_result" or a job id must
        // not break the event contract; structural values stay verbatim.
        out[key] = STRUCTURAL_KEYS.has(key) ? item : this.redactDeep(item);
      }
      return out as T;
    }
    return value;
  }

  /** Wrap a tool so its observation and structured metadata are scrubbed. */
  wrap(tool: Tool): Tool {
    return {
      ...tool,
      run: async (input, ctx): Promise<ToolResult> => {
        try {
          const result = await tool.run(input, ctx);
          return {
            ...result,
            content: this.redact(result.content),
            ...(result.verb ? { verb: this.redact(result.verb) } : {}),
            ...(result.meta ? { meta: this.redactDeep(result.meta) } : {}),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(this.redact(message));
        }
      },
    };
  }

  /** Wrap a trace sink so every persisted live event is scrubbed too. */
  wrapSink(sink: TraceSink): TraceSink {
    return {
      name: sink.name,
      record: (entry: TracedEvent) =>
        sink.record({ ...entry, event: this.redactDeep(entry.event) }),
    };
  }
}
