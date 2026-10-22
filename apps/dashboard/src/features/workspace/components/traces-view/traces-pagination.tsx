import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/elements/button";

export function TracesPagination({
  page,
  hasMore,
  onPrevious,
  onNext,
}: {
  page: number;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
      <p>Page {page + 1} · Latest 50 runs per page · Updates automatically</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={!page} onClick={onPrevious}>
          <ChevronLeft className="size-3.5" />Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!hasMore} onClick={onNext}>
          Next<ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
