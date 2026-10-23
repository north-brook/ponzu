import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMemo } from "react";
import { type ActivityItem, buildActivity, isNew } from "./activity";
import { useFiles } from "./catalog";
import { useSeen } from "./seen";
import { Store, useStore } from "./store";
import { useThreadDocs } from "./threads";

const KEY = "ponzu.activitySeenAt";

/** When the person last opened Activity. */
export const activitySeenAt = new Store<number>(0);
AsyncStorage.getItem(KEY)
  .then((v) => v && activitySeenAt.set(Number(v)))
  .catch(() => {});

export function markActivitySeen() {
  const now = Date.now();
  activitySeenAt.set(now);
  AsyncStorage.setItem(KEY, String(now)).catch(() => {});
}

/** Activity's items, split into New and Seen. */
export function useActivity(): { fresh: ActivityItem[]; old: ActivityItem[] } {
  const files = useFiles();
  const seen = useSeen();
  const docs = useThreadDocs();
  const at = useStore(activitySeenAt);
  return useMemo(() => {
    const items = buildActivity({
      files,
      docs,
      seen,
      activitySeenAt: at,
    });
    const fresh: ActivityItem[] = [];
    const old: ActivityItem[] = [];
    for (const item of items) (isNew(item, { seen, activitySeenAt: at }) ? fresh : old).push(item);
    return { fresh, old: old.slice(0, 30) };
  }, [files, seen, docs, at]);
}

/** The bell's count: what's new in Activity. */
export function useActivityCount(): number {
  return useActivity().fresh.length;
}
