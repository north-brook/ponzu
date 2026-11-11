import { useEffect, useRef } from "react";

/** Run `act` when the window comes back to the front, at most once every `minMs`. */
export function useOnReturn(act: () => void, minMs: number): void {
  const acting = useRef(act);
  acting.current = act;
  useEffect(() => {
    let last = Date.now();
    const back = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < minMs) return;
      last = Date.now();
      acting.current();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [minMs]);
}
