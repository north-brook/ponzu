import { useRef } from "react";

/**
 * Focus for a control an edit in place replaces, such as the pencil that turns into a field:
 * `returnTo(key)` as the edit ends from the keyboard, and the control drawn again with
 * `ref={target(key)}` takes focus as it mounts, so the next Tab carries on from where it was.
 */
export function useFocusReturn() {
  const pending = useRef<string | null>(null);
  return {
    returnTo: (key: string) => {
      pending.current = key;
    },
    target: (key: string) => (element: HTMLElement | null) => {
      if (!element || pending.current !== key) return;
      pending.current = null;
      element.focus();
    },
  };
}
