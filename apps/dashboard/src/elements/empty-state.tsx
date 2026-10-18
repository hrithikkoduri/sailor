/** Empty-state block used by threads (and anywhere else a view can be blank). */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="mt-16 flex flex-col items-center gap-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card/60">
        <Icon className="size-5 text-muted-foreground" />
      </span>
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
