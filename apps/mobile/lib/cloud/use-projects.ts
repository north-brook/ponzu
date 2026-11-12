import { pushableRepos } from "@ponzu/client/model";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useWorkspaces } from "./canvases";
import type { Shelf } from "./create";
import { useCloud } from "./query";

/**
 * Each of the person's usable workspaces with the repos they can push to there, pushed to
 * lately first (`GET /v1/workspaces/:id`, kept on disk with the rest): New canvas's project and
 * the picker's shelves. A workspace whose repos couldn't be had offers its Scratch alone.
 */
export function useProjects(): {
  userId: string | null;
  /** The workspace in view, and a way to move to another. */
  workspace: ReturnType<typeof useWorkspaces>["workspace"];
  choose: (id: string) => void;
  shelves: Shelf[] | undefined;
} {
  const cloud = useCloud();
  const { userId, workspaces, workspace, choose } = useWorkspaces();
  const answers = useQueries({
    queries: (workspaces ?? []).map((w) => ({
      ...cloud.queries.workspace(w.id),
      enabled: userId !== null,
    })),
  });
  // The shelves change only when what they show does: keyed by the pushable repos themselves,
  // so a repo that gains or loses push access moves on or off its shelf.
  const repos = answers.map((a) => (a.data ? pushableRepos(a.data.repos) : a.isError ? [] : null));
  const key = JSON.stringify(repos);
  const shelves = useMemo(
    () =>
      workspaces?.map(
        (w, i): Shelf => ({
          workspaceId: w.id,
          kind: w.kind,
          name: w.name,
          repos: repos[i] ?? null,
        }),
      ),
    [workspaces, key],
  );
  return { userId, workspace, choose, shelves };
}
