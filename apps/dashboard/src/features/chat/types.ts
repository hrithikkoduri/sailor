/** Persisted and live views use the same call IDs and step-scoped part IDs. */
export interface ConversationPart {
  id: string;
  kind: "text" | "reasoning" | "tool";
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
