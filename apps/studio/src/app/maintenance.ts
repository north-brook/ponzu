import type { ApiError } from "@ponzu/client";
import { useEffect, useRef } from "react";
import type { NoticeName } from "./analytics/events.ts";
import type { Host } from "./host.ts";

/*
 * Ponzu's maintenance switch, as the window says it (production spec §1.5). While the API is
 * read-only it answers every write with 503 `maintenance`; the window says why once, over the
 * work, and lets people go on looking. A canvas's edits wait and go in when it is back, and a
 * message that didn't go can be sent again. Wakes paused alone is said in the thread's foot
 * (`sandboxLine`), not here: nothing a person sends is refused then.
 */

/** The notice `maintenance`, word for word from the spec. */
export const MAINTENANCE_NOTICE =
  "Ponzu is updating. Your canvases are safe; you can look around, and changes come back in a few minutes.";

/**
 * How long after the notice it is not said again: a canvas's sync tries its edits again every
 * few seconds while Ponzu updates, and each refusal is the same news.
 */
export const MAINTENANCE_QUIET_MS = 60_000;

/** Whether an error is the maintenance switch's. */
export function isMaintenance(error: Pick<ApiError, "code">): boolean {
  return error.code === "maintenance";
}

/**
 * What to do about an error the API answered with, given when the notice was last said:
 * say it (and when), or nothing.
 */
export function maintenanceNotice(
  error: Pick<ApiError, "code">,
  lastSaid: number | null,
  now: number,
): { say: true; at: number } | null {
  if (!isMaintenance(error)) return null;
  if (lastSaid !== null && now - lastSaid < MAINTENANCE_QUIET_MS) return null;
  return { say: true, at: now };
}

/**
 * An ear for the API's errors that a host hands out (`Host.onApiError`): `heard` is called with
 * each error, and every listener hears it.
 */
export function apiErrors(): {
  heard(error: ApiError): void;
  listen(listener: (error: ApiError) => void): () => void;
} {
  const listeners = new Set<(error: ApiError) => void>();
  return {
    heard(error) {
      for (const listener of listeners) listener(error);
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The window's notice for the maintenance switch: one hook call in the main window. */
export function useMaintenanceNotice(
  host: Pick<Host, "onApiError">,
  tell: (name: NoticeName, words: string) => void,
): void {
  const lastSaid = useRef<number | null>(null);
  useEffect(
    () =>
      host.onApiError?.((error) => {
        const due = maintenanceNotice(error, lastSaid.current, Date.now());
        if (!due) return;
        lastSaid.current = due.at;
        tell("maintenance", MAINTENANCE_NOTICE);
      }),
    [host, tell],
  );
}
