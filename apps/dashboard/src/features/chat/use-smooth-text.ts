/**
 * Paces streamed text so it reads as a steady flow instead of provider bursts.
 *
 * Providers deliver tokens unevenly (bursts of hundreds of characters, then
 * pauses), and the live projector batches them per frame. Revealing the
 * backlog over a short window, once per animation frame, turns that into a
 * smooth typewriter without ever falling behind for long.
 *
 * Only growth is animated. Finished text (history, a refresh) renders
 * immediately; a part that is streaming when it mounts starts empty and
 * catches up within the window. Replaced text snaps.
 */
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

/** The backlog is revealed within this window while the model is streaming. */
const STREAMING_CATCH_UP_MS = 350;
/** After the final frame, finish quickly rather than trailing the run. */
const FINISHED_CATCH_UP_MS = 150;
/** Never slower than this, so a slow trickle still moves. */
const MIN_CHARS_PER_SECOND = 45;

/** Pure: how many characters to reveal this frame. */
export function nextRevealLength(shown: number, target: number, elapsedMs: number, streaming: boolean): number {
  const backlog = target - shown;
  if (backlog <= 0) return target;
  const window = streaming ? STREAMING_CATCH_UP_MS : FINISHED_CATCH_UP_MS;
  const step = Math.max(
    1,
    Math.ceil((backlog * elapsedMs) / window),
    Math.ceil((MIN_CHARS_PER_SECOND * elapsedMs) / 1000),
  );
  return Math.min(target, shown + step);
}

export function useSmoothText(text: string, streaming: boolean): string {
  const reduce = useReducedMotion();
  const initial = streaming && !reduce ? 0 : text.length;
  const [shown, setShown] = useState(initial);
  const shownRef = useRef(initial);
  const shownText = useRef(text);
  const target = useRef(text);
  const streamingRef = useRef(streaming);
  const frame = useRef<number | null>(null);
  target.current = text;
  streamingRef.current = streaming;

  // External synchronization only: drive a requestAnimationFrame loop.
  useEffect(() => {
    const revealed = shownText.current.slice(0, shownRef.current);
    const replaced = !text.startsWith(revealed);
    if (reduce || replaced || shownRef.current >= text.length) {
      shownRef.current = text.length;
      shownText.current = text;
      setShown(text.length);
      return;
    }
    shownText.current = text;
    if (frame.current !== null) return;
    let last = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.min(64, now - last);
      last = now;
      const goal = target.current.length;
      shownRef.current = nextRevealLength(shownRef.current, goal, elapsed, streamingRef.current);
      setShown(shownRef.current);
      frame.current = shownRef.current < goal ? requestAnimationFrame(tick) : null;
    };
    frame.current = requestAnimationFrame(tick);
  }, [text, reduce]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null; // a StrictMode remount must be able to restart the loop
  }, []);

  return text.slice(0, shown);
}
