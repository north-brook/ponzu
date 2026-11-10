import { getMemberWorkspace, type MemberRole, type MemberWorkspace } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import type { UserActor } from "./actor.ts";

/*
 * What a caller may touch. An access declaration says who is asking; the functions here say
 * whether that person may have the thing they named, and hand back its row. A handler gets a
 * row another person could not see only through one of them, so every area answers the same
 * way:
 *
 *   404 `not_found`   the thing does not exist, or the caller cannot see it. The two are not
 *                     told apart, so an id cannot be probed for.
 *   403 `forbidden`   the caller can see it and may not do this to it.
 *
 * `requireDesign` belongs here too and is the designs module's to write: opening a design
 * takes read access to its repository and steering it takes write access, both asked of
 * GitHub (docs/cloud.md, "Identity and access"), and a runner may act only on
 * `actor.designId`. Membership of the workspace alone is not that check.
 */

/** A handler's context, as far as these need it: only a route for a signed-in person has one. */
type UserContext = { var: { deps: Pick<Deps, "db">; actor: UserActor } };

/**
 * The workspace `workspaceId` names, as the signed-in person sees it. Pass `"admin"` for
 * something only an admin of the workspace may do.
 */
export async function requireWorkspace(
  c: UserContext,
  workspaceId: string,
  role?: Extract<MemberRole, "admin">,
): Promise<MemberWorkspace> {
  const { deps, actor } = c.var;
  const workspace = await getMemberWorkspace(deps.db, { userId: actor.user.id, workspaceId });
  if (!workspace) throw new ApiError(404, "not_found", "There is no such workspace.");
  if (role === "admin" && workspace.role !== "admin") {
    throw new ApiError(403, "forbidden", "Only an admin of this workspace can do this.");
  }
  return workspace;
}
