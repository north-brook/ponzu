import type { AgentChange } from "@ponzu/core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  type ActivityFilter,
  type ActivityItem,
  buildActivity,
  DEFAULT_FILTER,
  isNew,
} from "./activity";
import { useFiles, whenAgentEdits } from "./catalog";
import { getJson, NetError } from "./http";
import { baseUrl, type Mac } from "./mac";
import { keys } from "./mac-queries";
import { macs } from "./macs";
import { queryClient } from "./query";
import { reach } from "./reach";
import { useSeen } from "./seen";
import { Store, useStore } from "./store";
import { useThreadDocs } from "./threads";

const KEY = "ponzu.activitySeenAt";

/** When the person last opened Activity. */
export const activitySeenAt = new Store<number>(0);
AsyncStorage.getItem(KEY)
  .then((v) => v && activitySeenAt.set(Number(v)))
  .catch(() => {});

const FILTER_KEY = "ponzu.activityFilter";

/** Activity's filter, kept across launches: New or Everything, every kind or one. */
export const activityFilter = new Store<ActivityFilter>(DEFAULT_FILTER);
AsyncStorage.getItem(FILTER_KEY)
  .then((v) => v && activityFilter.set({ ...DEFAULT_FILTER, ...JSON.parse(v) }))
  .catch(() => {});

export function setActivityFilter(f: ActivityFilter) {
  activityFilter.set(f);
  AsyncStorage.setItem(FILTER_KEY, JSON.stringify(f)).catch(() => {});
}

export function markActivitySeen() {
  const now = Date.now();
  activitySeenAt.set(now);
  AsyncStorage.setItem(KEY, String(now)).catch(() => {});
}

/**
 * `GET /api/activity`: what agents changed in the Mac's designs, newest
 * first. Null from a Mac too old to keep a history, which has no such route.
 */
export async function fetchChanges(
  mac: Pick<Mac, "dns" | "address">,
): Promise<AgentChange[] | null> {
  try {
    const body = await getJson<{ entries: AgentChange[] }>(
      `${baseUrl(mac)}/api/activity?limit=100`,
      8_000,
    );
    return body.entries;
  } catch (err) {
    if (err instanceof NetError && err.status === 404) return null;
    throw err;
  }
}

const asking = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * An agent just changed a design on `mac` (the catalog stream said so): ask
 * the Mac what, once the burst of edits settles.
 */
export function changesMoved(mac: string) {
  clearTimeout(asking.get(mac));
  asking.set(
    mac,
    setTimeout(() => {
      asking.delete(mac);
      queryClient.invalidateQueries({ queryKey: keys.activity(mac) });
    }, 1_500),
  );
}

whenAgentEdits(changesMoved);

/**
 * One Mac's change log, as the cache holds it: standby's camera falls back
 * to it when an agent goes quiet between edits.
 */
export function useMacChanges(id: string | undefined): AgentChange[] {
  const saved = useStore(macs);
  const mac = saved.find((m) => m.id === id);
  const q = useQuery({
    queryKey: keys.activity(id ?? ""),
    queryFn: () => fetchChanges(mac!),
    enabled: Boolean(mac),
    staleTime: 10_000,
  });
  return q.data ?? [];
}

/** Each Mac's changes, as the cache holds them, with thumbnails on the Mac's address. */
function useChanges(): Record<string, AgentChange[] | null> {
  const saved = useStore(macs);
  const r = useStore(reach);
  const combine = useCallback(
    (results: { data?: AgentChange[] | null }[]) => {
      const all: Record<string, AgentChange[] | null> = {};
      results.forEach((q, i) => {
        const mac = saved[i]!;
        if (q.data === undefined) return;
        const base = baseUrl(mac);
        all[mac.id] =
          q.data &&
          q.data.map((c) => ({
            ...c,
            artboards: c.artboards.map((a) => (a.thumb ? { ...a, thumb: base + a.thumb } : a)),
          }));
      });
      return all;
    },
    [saved],
  );
  return useQueries({
    queries: saved.map((m) => ({
      queryKey: keys.activity(m.id),
      queryFn: () => fetchChanges(m),
      // Asked while the Mac answers: on opening, on coming back to the app, and after an agent's edit.
      enabled: r[m.id] === "answer",
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    })),
    combine,
  });
}

/**
 * Activity's items, split into New and Seen. `since` stands in for when the
 * person last looked (development's `ponzu://activity?since=`), read here
 * rather than written to the store: a write while Activity renders would
 * update Designs' bell mid-render.
 */
export function useActivity(since?: number): { fresh: ActivityItem[]; old: ActivityItem[] } {
  const files = useFiles();
  const changes = useChanges();
  const seen = useSeen();
  const docs = useThreadDocs();
  const stored = useStore(activitySeenAt);
  const at = since ?? stored;
  return useMemo(() => {
    const items = buildActivity({
      files,
      changes,
      docs,
      seen,
      activitySeenAt: at,
    });
    const fresh: ActivityItem[] = [];
    const old: ActivityItem[] = [];
    for (const item of items) (isNew(item, { seen, activitySeenAt: at }) ? fresh : old).push(item);
    return { fresh, old: old.slice(0, 30) };
  }, [files, changes, seen, docs, at]);
}

/** The bell's count: what's new in Activity. */
export function useActivityCount(): number {
  return useActivity().fresh.length;
}
