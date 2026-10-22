import { ExternalLink, GitPullRequest, ListOrdered, MessageSquare, MoreHorizontal, Trash2, Workflow } from "lucide-react";
import { ThreadDock } from "@/features/thread-tabs/thread-dock";
import { Button } from "@/elements/button";
import { IconButton } from "@/elements/icon-button";
import { eventPreview } from "@/utils/events";
import {
  TabsList,
  TabsTrigger,
} from "@/components/animate-ui/components/radix/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/animate-ui/components/radix/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/animate-ui/components/radix/dialog";
import type { PendingEvent, ThreadDetail, ThreadRun } from "../api";

export function ThreadHeader({
  thread,
  title,
  pendingEvents,
  active,
  busy,
  onInterject,
  onKeepSandbox,
  onDelete,
}: {
  thread: ThreadDetail["thread"];
  title: string;
  pendingEvents: PendingEvent[];
  active?: ThreadRun | undefined;
  busy: boolean;
  onInterject: (eventId: string) => void;
  onKeepSandbox: () => void;
  onDelete: () => void;
}) {
  return (
    <div data-thread-toolbar className="flex min-w-0 flex-1 items-center gap-2">
      <h1 className="sr-only">{title}</h1>
      <ThreadDock />
      <TabsList aria-label="Thread views" className="h-8 shrink-0 bg-muted/60">
        <TabsTrigger value="chat" className="gap-2 px-3 text-xs">
          <MessageSquare className="size-3.5" />
          <span className="hidden md:inline">Conversation</span><span className="sr-only md:hidden">Conversation</span>
        </TabsTrigger>
        <TabsTrigger value="trace" className="gap-2 px-3 text-xs">
          <Workflow className="size-3.5" />
          <span className="hidden md:inline">Trace</span><span className="sr-only md:hidden">Trace</span>
        </TabsTrigger>
      </TabsList>
      <div className="ml-auto flex items-center gap-1.5 sm:ml-0">
        {thread.issueUrl && (
          <Button variant="ghost" size="sm" asChild className="hidden h-7 text-xs text-muted-foreground md:inline-flex">
            <a href={thread.issueUrl} target="_blank" rel="noreferrer">
              Issue
              <ExternalLink className="size-3" />
            </a>
          </Button>
        )}
        {thread.prUrl && (
          <Button variant="outline" size="sm" asChild className="h-7 text-xs">
            <a href={thread.prUrl} target="_blank" rel="noreferrer">
              <GitPullRequest className="size-3.5" />
              PR #{thread.prNumber}
            </a>
          </Button>
        )}
        {pendingEvents.length > 0 && (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
                <ListOrdered className="size-3.5" />
                {pendingEvents.length} queued
              </Button>
            </DialogTrigger>
            <DialogContent className="rounded-2xl">
              <DialogHeader>
                <DialogTitle>Queued updates</DialogTitle>
                <DialogDescription>
                  These updates become the next turn. Interject to ask the current run to stop at its next boundary.
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-80 space-y-3 overflow-y-auto">
                {pendingEvents.map((event) => (
                  <div key={event.id} className="rounded-lg border border-border p-3">
                    <p className="text-[11px] text-muted-foreground">{event.kind.replace(/_/g, " ")}</p>
                    <p className="mt-1 line-clamp-3 text-sm">{eventPreview(event.kind, event.payload)}</p>
                    <Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => onInterject(event.id)}>
                      Interject
                    </Button>
                  </div>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        )}
        {active && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Run options">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={busy} onSelect={onKeepSandbox}>
                Keep sandbox for debugging
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Dialog>
          <DialogTrigger asChild>
            <IconButton
              label="Delete thread"
              disabled={!!active || busy}
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 />
            </IconButton>
          </DialogTrigger>
          <DialogContent className="rounded-2xl sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Delete this thread?</DialogTitle>
              <DialogDescription>
                This removes the conversation, its runs, and its traces. Any pull request already opened stays on GitHub. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {active && <p className="text-xs text-warning">Stop the current run first.</p>}
            <div className="flex justify-end gap-2">
              <Button variant="destructive" disabled={!!active || busy} onClick={onDelete}>
                <Trash2 className="size-3.5" />
                Delete thread
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
