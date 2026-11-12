import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { pickWorkspace, workspaceKey } from "./workspace-rules";

/*
 * The workspace in view, per person (`ponzu.workspace.<userId>` in AsyncStorage: an id, not a
 * secret). It starts on the first of the person's workspaces, and stays on the one they picked
 * for as long as they belong to it.
 */

export function useWorkspaceInView(
  userId: string | null,
  workspaces: readonly { id: string }[] | undefined,
): [string | null, (id: string) => void] {
  const [stored, setStored] = useState<{ userId: string; id: string | null } | null>(null);
  useEffect(() => {
    if (!userId) return;
    let on = true;
    AsyncStorage.getItem(workspaceKey(userId))
      .catch(() => null)
      .then((id) => on && setStored({ userId, id }));
    return () => {
      on = false;
    };
  }, [userId]);
  const choose = useCallback(
    (id: string) => {
      if (!userId) return;
      setStored({ userId, id });
      void AsyncStorage.setItem(workspaceKey(userId), id).catch(() => {});
    },
    [userId],
  );
  const known = stored?.userId === userId ? stored.id : null;
  return [workspaces ? pickWorkspace(known, workspaces) : null, choose];
}
