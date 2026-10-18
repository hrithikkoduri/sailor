/** Poll a loader on an interval (the threads list stays fresh this way). */
import { useEffect } from "react";

export function usePoll(load: () => void | Promise<void>, everyMs: number): void {
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), everyMs);
    return () => window.clearInterval(timer);
  }, [load, everyMs]);
}
