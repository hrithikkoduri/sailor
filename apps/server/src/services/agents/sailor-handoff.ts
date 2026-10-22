/**
 * Sailor's handoff vocabulary — the product's schema now, not the engine's.
 *
 * The engine carries `finish({ handoff })` opaquely (EngineOptions.handoff):
 * it declares the parameter from this schema, validates nothing itself, and
 * hands the model's object back untouched. These functions are where the
 * product reads its own fields out of it — how the run concluded, what a
 * follow-up wake should watch for, and where a resumed run starts.
 */
import type { EngineOptions } from "anchor-ai-sdk";

export type SailorDisposition = "done" | "watch" | "blocked";

export const SAILOR_HANDOFF = {
  schema: {
    type: "object",
    properties: {
      disposition: {
        type: "string",
        enum: ["done", "watch", "blocked"],
        description:
          "How to conclude: done (default with success=true), watch (wake a follow-up run on external signals), blocked (needs a human).",
      },
      watch: {
        type: "object",
        description:
          'What to be woken for, e.g. {"checks": true, "comments": true}.',
      },
      resumeAt: {
        type: "string",
        description:
          'Phase a future run on this thread should start at (e.g. "fix").',
      },
    },
    additionalProperties: false,
  },
  description:
    "Optional follow-up intent: disposition=watch with watch={checks:true,comments:true} and resumeAt=<phase> when a future run should be woken by external signals (CI, review) and start at that phase.",
  // What phase a thread persists for a resumable run — derived from the
  // handoff, because the engine must not know what "watch" means.
  threadPhase: (handoff: Record<string, unknown>) =>
    handoff.disposition === "watch" && typeof handoff.resumeAt === "string"
      ? handoff.resumeAt
      : undefined,
} satisfies NonNullable<EngineOptions["handoff"]>;

export interface SailorHandoff {
  disposition?: SailorDisposition;
  watch?: Record<string, unknown>;
  resumeAt?: string;
}

/**
 * Read Sailor's vocabulary out of the opaque handoff. No handoff → {} (the
 * run simply ended; rows keep null). Mirrors the old engine defaulting: an
 * explicit watch/blocked wins, then the presence of a watch spec, then the
 * declared success.
 */
export function readSailorHandoff(
  handoff: Record<string, unknown> | undefined,
  ok: boolean,
): SailorHandoff {
  if (handoff === undefined) return {};
  const disposition: SailorDisposition =
    handoff.disposition === "watch" || handoff.disposition === "blocked"
      ? handoff.disposition
      : handoff.watch
        ? "watch"
        : ok
          ? "done"
          : "blocked";
  return {
    disposition,
    ...(handoff.watch &&
    typeof handoff.watch === "object" &&
    !Array.isArray(handoff.watch)
      ? { watch: handoff.watch as Record<string, unknown> }
      : {}),
    ...(typeof handoff.resumeAt === "string"
      ? { resumeAt: handoff.resumeAt }
      : {}),
  };
}
