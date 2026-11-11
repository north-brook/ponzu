import { type Api, type Live, type PresenceRow, presentNow } from "@ponzu/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../cloud/time.ts";
import { keepUnchanged } from "./map.ts";

/*
 * What the sidebar's rows show beyond their own live row: where each design's files are, which
 * only `GET /v1/designs/:id` names and its previews are under (`previewOf`), and who is in it
 * right now.
 */

/**
 * Where each listed design's files are, asked for once per design while the window is open, for
 * the designs that have previews. One the API won't answer for is left without.
 */
export function useAssetsUrls(
  api: Pick<Api, "designs">,
  designs: readonly { id: string; previewSeq: number | null }[] | null,
): ReadonlyMap<string, string> {
  const [known, setKnown] = useState<ReadonlyMap<string, string>>(new Map());
  const wanted = useMemo(
    () => (designs ?? []).filter((d) => d.previewSeq !== null).map((d) => d.id),
    [designs],
  );
  const [asked] = useState(() => new Set<string>());
  useEffect(() => {
    for (const id of wanted) {
      if (asked.has(id)) continue;
      asked.add(id);
      api.designs.get(id).then(
        (view) => setKnown((now) => new Map(now).set(id, view.assetsUrl)),
        // Asked again the next time the list changes.
        () => asked.delete(id),
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

/** At most this many designs are watched for who is in them: the top of the list. */
export const PRESENCE_ROWS = 16;

/** Who is in each of these designs now, the viewer left out, by design. */
export function useRowPresence(
  live: Pick<Live, "subscribe">,
  designIds: readonly string[],
  meId: string,
): ReadonlyMap<string, PresenceRow[]> {
  const [rows, setRows] = useState<ReadonlyMap<string, readonly PresenceRow[]>>(new Map());
  const now = useNow();
  const key = designIds.slice(0, PRESENCE_ROWS).join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    const stops = ids.map((designId) =>
      live.subscribe("design.presence", { designId }, (snapshot) =>
        setRows((was) => new Map(was).set(designId, snapshot.rows ?? [])),
      ),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [live, key]);
  return useMemo(() => {
    const here = new Map<string, PresenceRow[]>();
    for (const [designId, list] of rows) {
      here.set(
        designId,
        presentNow(list, now).filter((row) => row.userId !== meId),
      );
    }
    return here;
  }, [rows, now, meId]);
}
