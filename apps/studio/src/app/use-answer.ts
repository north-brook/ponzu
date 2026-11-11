import { ApiError } from "@ponzu/client";
import { useCallback, useEffect, useRef, useState } from "react";

/*
 * An answer from the API that the window shows and asks for again when it may have changed (on
 * coming back to focus, after a link from GitHub). The last answer stays on screen while the next
 * is on its way, and while it fails, so a dropped connection never blanks the window.
 */

export interface Answer<T> {
  /** The last answer, or null before the first. */
  data: T | null;
  /** Why the last ask failed; cleared by the next answer. */
  error: ApiError | null;
  /** Ask again. */
  reload: () => void;
}

/** `ask`'s answer for `key`; a new key starts over. A null `ask` asks nothing. */
export function useAnswer<T>(ask: (() => Promise<T>) | null, key: string): Answer<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: ApiError | null }>({
    key,
    data: null,
    error: null,
  });
  const asking = useRef(ask);
  asking.current = ask;
  /** Only the latest ask's answer is taken. */
  const latest = useRef(0);

  const load = useCallback(() => {
    const run = asking.current;
    if (!run) return;
    const mine = ++latest.current;
    run().then(
      (data) => {
        if (latest.current === mine) setState({ key, data, error: null });
      },
      (error: unknown) => {
        if (latest.current !== mine) return;
        setState((now) => ({
          key,
          data: now.key === key ? now.data : null,
          error: error instanceof ApiError ? error : new ApiError(0, "network", String(error)),
        }));
      },
    );
  }, [key]);

  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
  }, [load]);

  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, reload: load };
}

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
