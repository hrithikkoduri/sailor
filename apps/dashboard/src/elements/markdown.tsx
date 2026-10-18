/** Markdown for agent messages — compact prose + code blocks with copy. */
import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "@/components/animate-ui/components/buttons/copy";

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1">
        <span className="font-mono text-[10.5px] tracking-wide text-muted-foreground">
          {lang ?? "text"}
        </span>
        <CopyButton
          content={code}
          size="xs"
          className="size-6 cursor-pointer bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
        />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`prose-harness text-sm text-foreground ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({
            className: codeClassName,
            children,
            ...props
          }: ComponentProps<"code">) => {
            const raw = String(children ?? "");
            const isBlock =
              /language-/.test(codeClassName ?? "") || raw.includes("\n");
            if (!isBlock) {
              return (
                <code className={codeClassName} {...props}>
                  {children}
                </code>
              );
            }
            const lang = /language-(\w+)/.exec(codeClassName ?? "")?.[1];
            return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
