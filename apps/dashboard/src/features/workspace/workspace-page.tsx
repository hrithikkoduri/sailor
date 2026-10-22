import type { ReactNode } from "react";
import { AppShell } from "@/features/shell/app-shell";

export function WorkspacePage({ eyebrow, title, description, action, children }: {
  eyebrow: string; title: string; description: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  return <AppShell>
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-6xl px-5 py-8 md:px-10 md:py-12">
      <header className="mb-9 flex flex-wrap items-start justify-between gap-5"><div>
        <p className="eyebrow mb-2">{eyebrow}</p><h1 className="page-heading">{title}</h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>{action}</header>{children}
    </div></div>
  </AppShell>;
}
