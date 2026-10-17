/**
 * Thread state machine — pure tests, no services needed.
 */
import { describe, expect, it } from "vitest";
import { canTransition, THREAD_STATES } from "../../src/threads/state.js";

describe("thread state machine", () => {
  it("allows the lifecycle's happy path", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "pr_open")).toBe(true);
    expect(canTransition("pr_open", "waiting_ci")).toBe(true);
    expect(canTransition("waiting_ci", "fixing")).toBe(true);
    expect(canTransition("fixing", "waiting_ci")).toBe(true);
    expect(canTransition("waiting_ci", "addressing_comments")).toBe(true);
    expect(canTransition("addressing_comments", "waiting_ci")).toBe(true);
    expect(canTransition("waiting_ci", "merged")).toBe(true);
  });

  it("refuses illegal jumps", () => {
    expect(canTransition("queued", "merged")).toBe(false);
    expect(canTransition("merged", "running")).toBe(false);
    expect(canTransition("closed", "pr_open")).toBe(false);
    expect(canTransition("abandoned", "queued")).toBe(false);
  });

  it("unknown current states can only move nowhere", () => {
    expect(canTransition("nonsense", "running")).toBe(false);
  });

  it("terminal states have no exits", () => {
    for (const terminal of ["merged", "closed", "abandoned"] as const) {
      const exits = THREAD_STATES.filter((to) => canTransition(terminal, to));
      expect(exits).toEqual([]);
    }
  });
});
