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
  const key = JSON.stringify(
    answers.map((a) => [a.data ? a.data.repos.map((r) => [r.id, r.pushedAt]) : null, a.isError]),
  );
  const shelves = useMemo(
    () =>
      workspaces?.map(
        (w, i): Shelf => ({
          workspaceId: w.id,
          kind: w.kind,
          name: w.name,
          repos: answers[i]?.data
            ? pushableRepos(answers[i].data.repos)
            : answers[i]?.isError
              ? []
              : null,
        }),
      ),
    [workspaces, key],
  );
  return { userId, workspace, choose, shelves };
}
