import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, useIsFocused } from "expo-router";
import { useEffect } from "react";
import type { CanvasList } from "./list";

/*
 * Someone through setup whose workspace has no canvases yet lands on an empty list: New canvas
 * comes over it by itself, once (iPhone design §5, G-M1), as the Mac opens its create page. Once
 * per person on this phone, kept at `ponzu.firstCanvas.<userId>` (an id, not a secret).
 */

export const firstCanvasKey = (userId: string) => `ponzu.firstCanvas.${userId}`;

/** Whether New canvas should come now: the list has come, and is empty, settled tray and all. */
export function offerFirstCanvas(list: CanvasList | undefined): boolean {
  return list !== undefined && list.active.length === 0 && list.settled.length === 0;
}

/** Who it has come for in this run, so it never comes twice while the key is being written. */
const offered = new Set<string>();

/** For a test starting again. */
export function forgetFirstCanvas(): void {
  offered.clear();
}

export function useFirstCanvas({
  userId,
  workspace,
  list,
}: {
  userId: string | null;
  workspace: { id: string } | null;
  list: CanvasList | undefined;
}): void {
  const focused = useIsFocused();
  const now = focused && userId !== null && workspace !== null && offerFirstCanvas(list);
  useEffect(() => {
    if (!now || !userId || offered.has(userId)) return;
    offered.add(userId);
    let on = true;
    const key = firstCanvasKey(userId);
    AsyncStorage.getItem(key)
      .catch(() => null)
      .then((seen) => {
        if (seen) return;
        // Left (or the list filled) before the answer came: it may come next time.
        if (!on) {
          offered.delete(userId);
          return;
        }
        void AsyncStorage.setItem(key, "1").catch(() => {});
        router.push("/new");
      });
    return () => {
      on = false;
    };
  }, [now, userId]);
}
