import {
  byRecentActivity,
  type CanvasListRow,
  type LiveArgs,
  type LiveQueryName,
  type LiveRows,
  type LiveSnapshot,
} from "@ponzu/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { backend } from "./backend";
import { phoneKeys } from "./persist";
import { useCloud } from "./query";
import { useWorkspaceInView } from "./workspace";

const NOTHING = Object.freeze({ rows: undefined, status: "connecting" }) as LiveSnapshot<never>;

/**
 * A live query of the signed-in person's `Live`, or nothing while `args` is null (no workspace
 * yet): `useLiveQuery` with a way to wait, so nothing subscribes to a query it can't name.
 */
export function useLive<Name extends LiveQueryName>(
  name: Name,
  args: LiveArgs[Name] | null,
): LiveSnapshot<LiveRows[Name]> {
  const { live } = useCloud();
  const key = args ? JSON.stringify(args, Object.keys(args).sort()) : null;
  const subscribe = useCallback(
    (changed: () => void) => (args ? live.subscribe(name, args, changed) : () => {}),
    // `args` is read through `key`: a new object with the same values is the same query.
    [live, name, key],
  );
  const snapshot = () => (args ? live.snapshot(name, args) : NOTHING);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The signed-in person, their workspace in view and its canvases: the live query's rows, first
 * painted from the request answer kept on disk, so the list opens offline onto the last one.
 * Newest activity first; the shared order (needs you first on an org) arrives with the list's
 * own slice.
 */
export function useCanvases(): {
  userId: string | null;
  workspaceId: string | null;
  canvases: CanvasListRow[] | undefined;
  /** Still waiting for anything to show. */
  loading: boolean;
} {
  const cloud = useCloud();
  const me = useQuery({ ...cloud.queries.me(), enabled: cloud.userId !== null });
  const [workspaceId] = useWorkspaceInView(cloud.userId, me.data?.workspaces);
  const first = useQuery({
    queryKey: phoneKeys.canvases(workspaceId ?? ""),
    queryFn: () => backend.api.workspaces.canvases(workspaceId!),
    enabled: workspaceId !== null,
  });
  const live = useLive("workspace.canvases", workspaceId ? { workspaceId } : null);
  const rows = workspaceId === null ? undefined : (live.rows ?? first.data?.canvases);
  const canvases = useMemo(
    () => (rows ? byRecentActivity(rows as readonly CanvasListRow[]) : undefined),
    [rows],
  );
  return {
    userId: cloud.userId,
    workspaceId,
    canvases,
    loading: canvases === undefined && !first.isError && live.status !== "ended",
  };
}
