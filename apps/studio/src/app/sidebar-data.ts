import { type Api, type Live, type PresenceRow, presentNow } from "@ponzu/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../cloud/time.ts";
import { keepUnchanged } from "./map.ts";

/*
 * What the sidebar's rows show beyond their own live row: where each canvas's files are, which
 * only `GET /v1/canvases/:id` names and its previews are under (`previewOf`), and who is in it
 * right now.
 */

/**
 * Where each listed canvas's files are, asked for once per canvas while the window is open, for
 * the canvases that have previews, and again when its file links are reset (its row's
 * `assetKeyRotatedAt` moves). One the API won't answer for is left without.
 */
export function useAssetsUrls(
  api: Pick<Api, "canvases">,
  canvases:
    | readonly { id: string; previewSeq: number | null; assetKeyRotatedAt?: string | null }[]
    | null,
): ReadonlyMap<string, string> {
  const [known, setKnown] = useState<ReadonlyMap<string, string>>(new Map());
  const wanted = useMemo(
    () =>
      (canvases ?? [])
        .filter((d) => d.previewSeq !== null)
        .map((d) => ({ id: d.id, ask: `${d.id} ${d.assetKeyRotatedAt ?? ""}` })),
    [canvases],
  );
  const [asked] = useState(() => new Set<string>());
  useEffect(() => {
    for (const { id, ask } of wanted) {
      if (asked.has(ask)) continue;
      asked.add(ask);
      api.canvases.get(id).then(
        (view) => setKnown((now) => new Map(now).set(id, view.assetsUrl)),
        // Asked again the next time the list changes.
        () => asked.delete(ask),
      );
    }
  }, [api, wanted, asked]);
  return known;
}

/**
 * The value, sharing every part that hasn't changed since the last render (`keepUnchanged`): the
 * rows a live update didn't touch, and an unchanged preview, stay the same objects, so their rows
 * aren't drawn again and their pictures aren't asked for again.
 */
export function useUnchanged<T>(value: T): T {
  const last = useRef(value);
  // Compared once per new value, not on every render of the window.
  const kept = useMemo(() => keepUnchanged(last.current, value), [value]);
  useEffect(() => {
    last.current = kept;
  }, [kept]);
  return kept;
}

/** At most this many canvases are watched for who is in them: the top of the list. */
export const PRESENCE_ROWS = 16;

/** Who is in each of these designs now, the viewer left out, by design. */
export function useRowPresence(
  live: Pick<Live, "subscribe">,
  canvasIds: readonly string[],
  meId: string,
): ReadonlyMap<string, PresenceRow[]> {
  const [rows, setRows] = useState<ReadonlyMap<string, readonly PresenceRow[]>>(new Map());
  const now = useNow();
  const key = canvasIds.slice(0, PRESENCE_ROWS).join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    const stops = ids.map((canvasId) =>
      live.subscribe("canvas.presence", { canvasId }, (snapshot) =>
        setRows((was) => new Map(was).set(canvasId, snapshot.rows ?? [])),
      ),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [live, key]);
  return useMemo(() => {
    const here = new Map<string, PresenceRow[]>();
    for (const [canvasId, list] of rows) {
      here.set(
        canvasId,
        presentNow(list, now).filter((row) => row.userId !== meId),
      );
    }
    return here;
  }, [rows, now, meId]);
}
