/** Persisted and live views use the same call IDs and step-scoped part IDs. */
export interface ConversationPart {
  id: string;
  kind: "text" | "reasoning" | "tool" | "compaction";
  step: number;
  sequence: number;
  text?: string;
  reasoningTokens?: number;
  callId?: string;
  name?: string;
  verb?: string;
  input?: Record<string, unknown>;
  content?: string;
  ok?: boolean;
  /** Compaction parts: what was folded and the summary that replaced it. */
  removedMessages?: number;
  keptMessages?: number;
  summaryChars?: number;
  summary?: string;
  folding?: string;
  complete: boolean;
}
export interface RunConversation {
  parts: ConversationPart[];
  sequence: number;
  finished: boolean;
  /** The approach phases this run may move through, in order. */
  phases?: string[];
  /** Phases the run actually entered, in order (skips are honest). */
  visited?: string[];
  /** The phase the run is currently in, when known. */
  phase?: string | null;
}
