import { useEffect, useRef, useState } from "react";

/*
 * Holding a modifier to see the numbers that jump with it: the canvas's page tabs (⌥) and a
 * host's own (the cloud app's sidebar rows and page tabs). Its own entry point,
 * `@ponzu/canvas/modifier-hint`, so a host's chrome can use it without loading the canvas.
 */

/**
 * Whether a modifier has been held on its own for a moment, so the 1–9 it jumps with
 * can show. It waits because ⌘ is down for ⌘Z too. Another key, a click or a scroll
 * hides it, except the digits it shows, so you can keep jumping while you hold it.
 * `allow`, asked as the wait ends, keeps it hidden while the host has something on top
 * (a menu, a dialog) that the digits wouldn't reach past.
 */
export function useModifierHint(
  key: "Meta" | "Control" | "Alt",
  delay = 250,
  allow?: () => boolean,
): boolean {
  const [shown, setShown] = useState(false);
  const allowed = useRef(allow);
  allowed.current = allow;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let on = false;
    const show = (next: boolean) => {
      on = next;
      setShown(next);
    };
    const hide = () => {
      clearTimeout(timer);
      show(false);
    };
    const down = (e: KeyboardEvent) => {
      const alone =
        e.metaKey === (key === "Meta") &&
        e.ctrlKey === (key === "Control") &&
        e.altKey === (key === "Alt") &&
        !e.shiftKey;
      if (e.key !== key) {
        if (!(on && alone && /^Digit[0-9]$/.test(e.code))) hide();
        return;
      }
      // Windows repeats a held Ctrl; that's still the same hold.
      if (e.repeat) return;
      hide();
      if (alone && !isTyping(e)) {
        timer = setTimeout(() => show(allowed.current?.() ?? true), delay);
      }
    };
    const up = (e: KeyboardEvent) => e.key === key && hide();
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("wheel", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [key, delay]);
  return shown;
}

/** The key went to a field that types: an input, a text area, something editable. */
export function isTyping(e: Event): boolean {
  const t = e.composedPath()[0] as HTMLElement | undefined;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
