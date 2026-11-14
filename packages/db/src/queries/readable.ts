import { type SQL, sql } from "drizzle-orm";
import { canvases, memberships, repoAccess } from "../schema/index.ts";
import { READABLE_PERMISSIONS } from "./repo-access.ts";

/**
 * Which canvases of a workspace one person may read: a condition on `canvases`, for a statement
 * that reads from it. The canvas list (`listWorkspaceCanvases`) and search (`searchCanvases`)
 * both use this and nothing else, so search can never find a canvas the list would not show.
 *
 * A canvas is readable when it is in the workspace, the person is a member of the workspace, and
 * either it is a Scratch canvas they own or `repo_access` says they may read its repo (a read
 * GitHub gave them: never just that the repo is public, see `recordReachableRepos`). The
 * membership is checked here, though the API's callers check it too, so that a leftover
 * `repo_access` row of someone who left (or never joined) can never show them anything. How
 * recent the `repo_access` answers must be is the caller's to make sure of.
 */
export function readableCanvases({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId: string;
}): SQL {
  const readable = sql.join(
    READABLE_PERMISSIONS.map((permission) => sql`${permission}`),
    sql`, `,
  );
  return sql`(
    ${canvases.workspaceId} = ${workspaceId}
    and exists (
      select 1 from ${memberships} m
       where m.workspace_id = ${canvases.workspaceId} and m.user_id = ${userId}
    )
    and (
      (${canvases.repoId} is null and ${canvases.ownerId} = ${userId})
      or exists (
        select 1 from ${repoAccess} a
         where a.repo_id = ${canvases.repoId}
           and a.user_id = ${userId}
           and a.permission in (${readable})
      )
    )
  )`;
}
