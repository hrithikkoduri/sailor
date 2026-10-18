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
}
