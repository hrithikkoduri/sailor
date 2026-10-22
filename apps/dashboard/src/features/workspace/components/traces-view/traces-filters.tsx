import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/elements/select";
import { outcomeLabel, TRACE_OUTCOMES } from "../../traces";

export function TracesFilters({
  status,
  query,
  onStatusChange,
  onQueryChange,
}: {
  status: string;
  query: string;
  onStatusChange: (value: string) => void;
  onQueryChange: (value: string) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        Outcome
        <Select value={status} onValueChange={onStatusChange}>
          <SelectTrigger aria-label="Filter traces by outcome" className="w-40 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRACE_OUTCOMES.map((outcome) => (
              <SelectItem key={outcome} value={outcome}>{outcomeLabel(outcome)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="relative">
        <Search className="absolute top-3 left-3 size-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label="Search traces on this page"
          placeholder="Search this page…"
          className="h-10 w-64 bg-card pl-9"
        />
      </div>
    </div>
  );
}
