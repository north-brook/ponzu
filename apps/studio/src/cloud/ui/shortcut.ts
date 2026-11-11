import { useEffect, useRef } from "react";
import { useAnalytics } from "../../app/analytics/provider.tsx";

/** Key presses already counted: two shortcuts on one key (⌘, has two) are one use. */
const counted = new WeakSet<KeyboardEvent>();

/**
 * Runs `handler` on ⌘ (Ctrl off the Mac) plus `key`, anywhere in the window. `key` is the
 * KeyboardEvent key, lowercase: "k", "n", "j", ",". Each use is counted (`hotkey used`), by key.
 */
export function useShortcut(key: string, handler: () => void, enabled = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  const analytics = useAnalytics();
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== key) return;
      e.preventDefault();
      if (!counted.has(e)) {
        counted.add(e);
        analytics.capture("hotkey used", { hotkey: `mod+${key}` });
      }
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, enabled, analytics]);
}
