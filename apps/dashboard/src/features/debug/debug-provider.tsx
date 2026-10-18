import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const DebugContext = createContext<{
  enabled: boolean;
  toggle: () => void;
} | null>(null);

/** Local display preference only: no API flags, extra permissions, or agent
 * behavior changes. One listener covers the app, including focused composers. */
export function DebugProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem("sailor-debug") === "true";
    } catch {
      return false;
    }
  });
  const [announcement, setAnnouncement] = useState("");
  const toggle = useCallback(() => {
    setEnabled(!enabled);
    setAnnouncement(`Debug mode ${enabled ? "disabled" : "enabled"}.`);
  }, [enabled]);

  useEffect(() => {
    try {
      localStorage.setItem("sailor-debug", String(enabled));
    } catch {
      /* storage may be unavailable */
    }
  }, [enabled]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.altKey) return;
      if (
        !(event.metaKey || event.ctrlKey) ||
        !event.shiftKey ||
        !(event.code === "KeyD" || event.key.toLowerCase() === "d")
      )
        return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [toggle]);

  return (
    <DebugContext.Provider value={{ enabled, toggle }}>
      {children}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </DebugContext.Provider>
  );
}

export function useDebugMode() {
  const context = useContext(DebugContext);
  if (!context) throw new Error("useDebugMode requires DebugProvider");
  return context;
}
