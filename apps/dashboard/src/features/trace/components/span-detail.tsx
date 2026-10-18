import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/animate-ui/components/radix/accordion";
import { Markdown } from "@/elements/markdown";
import type { SpanNode } from "../build-tree";
import { fmtTokens } from "@/utils/format";
import { CircleX } from "lucide-react";
import { cn } from "@/utils/cn";

export function SpanDetail({ node }: { node: SpanNode }) {
  const output = node.detail.output as
    | { text?: string; toolCalls?: unknown[]; reasoning?: string }
    | undefined;
  const failed = node.status === "fail";
  const meta = (node.detail.metadata.meta ?? {}) as Record<string, unknown>;
  const error =
    typeof node.detail.metadata.error === "string"
      ? node.detail.metadata.error
      : undefined;
  // Same display vocabulary as the tree rows — one name everywhere.
  const displayName = node.name
    .replace("agent · step", "Model call")
    .replace("phase · ", "");
  return (
    <div className="mx-auto max-w-3xl px-5 py-4 md:px-6 md:py-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow mb-2">
            {node.kind === "run" ? "Turn details" : `${node.kind} span`}
          </p>
          <h2 className="text-lg font-medium tracking-tight">{displayName}</h2>
          <p className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span
              className={cn(
                "capitalize",
                failed && "font-medium text-destructive",
              )}
            >
              {node.status === "ok"
                ? "Completed"
                : failed
                  ? "Failed"
                  : node.status}
            </span>
            {node.durationMs !== undefined && (
              <span>
                {node.estimated ? "~" : ""}
                {(node.durationMs / 1000).toFixed(2)}s
              </span>
            )}
            {node.tokensIn !== undefined && (
              <span>
                {fmtTokens(node.tokensIn + (node.tokensOut ?? 0))} tokens
                {typeof node.detail.metadata.inputCached === "number" &&
                  ` · ${fmtTokens(node.detail.metadata.inputCached)} cached`}
              </span>
            )}
            {node.badge && <span>{node.badge.replace(/_/g, " ")}</span>}
          </p>
        </div>
        <CopyButton
          content={JSON.stringify(node.detail, null, 2)}
          variant="ghost"
          size="sm"
          aria-label="Copy span details"
        />
      </div>
      {failed && (
        <section
          aria-label="Failure details"
          className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs"
        >
          <CircleX
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          <div className="min-w-0">
            <p className="font-medium text-destructive">
              {node.kind === "tool"
                ? meta.exitCode === -1
                  ? "Sandbox execution request failed"
                  : "Tool call failed"
                : node.kind === "run"
                  ? "Turn failed"
                  : "Execution failed"}
            </p>
            <p className="mt-1 break-words text-foreground">
              {error ??
                (meta.exitCode === -1
                  ? "Command completion could not be confirmed. The recorded error is in Output below."
                  : `See Output for the recorded error${typeof meta.exitCode === "number" ? ` (exit code ${meta.exitCode})` : ""}.`)}
            </p>
          </div>
        </section>
      )}
      <Accordion
        key={node.id}
        type="multiple"
        defaultValue={["input", "output", "metadata"]}
      >
        <AccordionItem value="input">
          <AccordionTrigger className="py-4 text-[13px] hover:no-underline">
            Input
          </AccordionTrigger>
          <AccordionContent>
            <TraceValue value={node.detail.input} />
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="output">
          <AccordionTrigger className="py-4 text-[13px] hover:no-underline">
            Output
          </AccordionTrigger>
          <AccordionContent>
            {node.kind === "llm" && (output?.text || output?.reasoning) ? (
              <div className="space-y-4 rounded-xl border border-border bg-card p-5">
                {output.reasoning && (
                  <div className="border-l-2 border-border pl-3">
                    <p className="eyebrow mb-2">Reasoning</p>
                    <Markdown
                      text={output.reasoning}
                      className="text-xs text-muted-foreground"
                    />
                  </div>
                )}
                {output.text && <Markdown text={output.text} />}
                {!!output.toolCalls?.length && (
                  <TraceValue value={output.toolCalls} />
                )}
              </div>
            ) : (
              <TraceValue value={node.detail.output} />
            )}
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="metadata">
          <AccordionTrigger className="py-4 text-[13px] hover:no-underline">
            Metadata
          </AccordionTrigger>
          <AccordionContent>
            <dl className="space-y-3">
              {Object.entries(node.detail.metadata)
                .filter(([, v]) => v != null)
                .map(([key, value]) => (
                  <div
                    key={key}
                    className="grid grid-cols-[minmax(90px,1fr)_minmax(0,2fr)] gap-5 border-b border-border/60 pb-3 text-xs"
                  >
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="min-w-0 break-words">
                      {typeof value === "object" ? (
                        <TraceValue value={value} />
                      ) : (
                        String(value)
                      )}
                    </dd>
                  </div>
                ))}
            </dl>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function TraceValue({ value }: { value: unknown }) {
  if (value == null)
    return (
      <p className="py-2 text-xs text-muted-foreground">
        Not recorded for this span.
      </p>
    );
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/35 p-4 font-mono text-[11px] leading-[1.9]">
      {text}
    </pre>
  );
}
