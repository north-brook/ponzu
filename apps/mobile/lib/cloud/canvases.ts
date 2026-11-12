import {
  byRecentActivity,
  type CanvasListRow,
  type LiveArgs,
  type LiveQueryName,
  type LiveRows,
  type LiveSnapshot,
  type QuestionRow,
} from "@ponzu/client";
import { keepUnchanged, membersById, type Person, type WorkspaceKind } from "@ponzu/client/model";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { backend } from "./backend";
import { buildList, type CanvasList, previewWatch, questionWatch } from "./list";
import { phoneKeys } from "./persist";
import { useCloud } from "./query";
import { useWorkspaceInView } from "./workspace";

const NOTHING = Object.freeze({ rows: undefined, status: "connecting" }) as LiveSnapshot<never>;
const NO_PEOPLE: ReadonlyMap<string, Person> = new Map();

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

/** A workspace the person can be shown: the switcher's row. */
export interface ShownWorkspace {
  id: string;
  kind: WorkspaceKind;
  /** "Personal" for the person's own; the organization's name otherwise. */
  name: string;
}

/**
 * The person's workspaces they can work in (the App on it and not suspended), and the one in
 * view. While none is usable (an install on its way), any of theirs, so the list still has a
 * home.
 */
export function useWorkspaces(): {
  userId: string | null;
  workspaces: ShownWorkspace[] | undefined;
  workspace: ShownWorkspace | null;
  choose: (id: string) => void;
} {
  const cloud = useCloud();
  const me = useQuery({ ...cloud.queries.me(), enabled: cloud.userId !== null });
  const all = me.data?.workspaces;
  const workspaces = useMemo(() => {
    if (!all) return undefined;
    const usable = all.filter((w) => w.installed && !w.suspended);
    return (usable.length ? usable : all).map(
      (w): ShownWorkspace => ({
        id: w.id,
        kind: w.kind,
        name: w.kind === "personal" ? "Personal" : w.name,
      }),
    );
  }, [all]);
  const [workspaceId, choose] = useWorkspaceInView(cloud.userId, workspaces);
  const workspace = workspaces?.find((w) => w.id === workspaceId) ?? null;
  return { userId: cloud.userId, workspaces, workspace, choose };
}

/**
 * The workspace in view's rows: the live query's, first painted from the request answer kept on
 * disk, so the list opens offline onto the last one.
 */
function useRows(workspaceId: string | null): {
  rows: readonly CanvasListRow[] | undefined;
  failed: boolean;
  ended: boolean;
} {
  const first = useQuery({
    queryKey: phoneKeys.canvases(workspaceId ?? ""),
    queryFn: () => backend.api.workspaces.canvases(workspaceId!),
    enabled: workspaceId !== null,
  });
  const live = useLive("workspace.canvases", workspaceId ? { workspaceId } : null);
  const rows =
    workspaceId === null
      ? undefined
      : ((live.rows ?? first.data?.canvases) as readonly CanvasListRow[] | undefined);
  return { rows, failed: first.isError, ended: live.status === "ended" };
}

/**
 * The signed-in person, their workspace in view and its canvases, newest activity first: the
 * plain rows, for what lists canvases by name (Search).
 */
export function useCanvases(): {
  userId: string | null;
  workspaceId: string | null;
  canvases: CanvasListRow[] | undefined;
  /** Still waiting for anything to show. */
  loading: boolean;
} {
  const { userId, workspace } = useWorkspaces();
  const workspaceId = workspace?.id ?? null;
  const { rows, failed, ended } = useRows(workspaceId);
  const canvases = useMemo(() => (rows ? byRecentActivity(rows) : undefined), [rows]);
  return {
    userId,
    workspaceId,
    canvases,
    loading: canvases === undefined && !failed && !ended,
  };
}

/**
 * Where each canvas with a preview keeps its files: `GET /v1/canvases/:id`'s `assetsUrl`, asked
 * once per canvas and kept on disk with the list (persist.ts), so previews show offline too.
 */
function useAssetsUrls(ids: readonly string[]): ReadonlyMap<string, string> {
  const views = useQueries({
    queries: ids.map((id) => ({
      queryKey: phoneKeys.canvasView(id),
      queryFn: () => backend.api.canvases.get(id),
      // Where a canvas's files are moves only when its key is rotated: asked again on a remount.
      staleTime: 5 * 60_000,
    })),
  });
  // The same answers make the same map, so the rows draw again only when an address arrives.
  const key = JSON.stringify(
    ids.flatMap((id, i) => {
      const url = views[i]?.data?.assetsUrl;
      return url ? [[id, url]] : [];
    }),
  );
  return useMemo(() => new Map<string, string>(JSON.parse(key)), [key]);
}

/** Each of these canvases' open questions, live, by canvas id. */
function useQuestions(ids: readonly string[]): ReadonlyMap<string, readonly QuestionRow[]> {
  const { live } = useCloud();
  const [rows, setRows] = useState<ReadonlyMap<string, readonly QuestionRow[]>>(new Map());
  const key = ids.join(",");
  useEffect(() => {
    const watched = key ? key.split(",") : [];
    const stops = watched.map((canvasId) =>
      live.subscribe("canvas.questions", { canvasId }, (snapshot) =>
        setRows((was) => new Map(was).set(canvasId, snapshot.rows ?? [])),
      ),
    );
    // Rows no longer watched let go of their questions.
    setRows((was) => new Map([...was].filter(([id]) => watched.includes(id))));
    return () => {
      for (const stop of stops) stop();
    };
  }, [live, key]);
  return rows;
}

/**
 * The canvases list: the workspace in view's canvases in the Mac sidebar's order with their
 * previews, people and the questions waiting on the viewer, and the settled ones apart.
 */
export function useCanvasList(): {
  userId: string | null;
  workspace: ShownWorkspace | null;
  list: CanvasList | undefined;
  /** Still waiting for anything to show. */
  loading: boolean;
} {
  const cloud = useCloud();
  const { userId, workspace } = useWorkspaces();
  const workspaceId = workspace?.id ?? null;
  const kind = workspace?.kind ?? "personal";
  const { rows, failed, ended } = useRows(workspaceId);
  const members = useQuery({
    ...cloud.queries.workspace(workspaceId ?? ""),
    enabled: workspaceId !== null,
  });
  const people = useMemo(
    () => (members.data ? membersById(members.data.members) : NO_PEOPLE),
    [members.data],
  );
  const previews = useMemo(() => (rows ? previewWatch(rows) : []), [rows]);
  const watched = useMemo(() => (rows ? questionWatch(rows, kind) : []), [rows, kind]);
  const assetsUrls = useAssetsUrls(previews);
  const questions = useQuestions(watched);
  const built = useMemo(
    () => (rows ? buildList(rows, { kind, people, assetsUrls, questions }) : undefined),
    [rows, kind, people, assetsUrls, questions],
  );
  // Rows a live update didn't touch stay the same objects, so CanvasRow's memo holds and only
  // the row that changed draws again (as the Mac's sidebar does, sidebar-data.ts).
  const last = useRef(built);
  const list = useMemo(() => keepUnchanged(last.current, built), [built]);
  useEffect(() => {
    last.current = list;
  }, [list]);
  return {
    userId,
    workspace,
    list,
    loading: list === undefined && !failed && !ended,
  };
}
