import {
  type DesignAccess,
  getDesignAccess,
  getMemberWorkspace,
  type MemberRole,
  type MemberWorkspace,
  type User,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import type { Actor, UserActor } from "./actor.ts";
import { canWrite, repoPermission } from "./repo-access.ts";

/*
 * What a caller may touch. An access declaration says who is asking; the functions here say
 * whether that person may have the thing they named, and hand back its row. A handler gets a
 * row another person could not see only through one of them, so every area answers the same
 * way:
 *
 *   404 `not_found`   the thing does not exist, or the caller cannot see it. The two are not
 *                     told apart, so an id cannot be probed for.
 *   403 `forbidden`   the caller can see it and may not do this to it.
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

/** A design as the caller may have it: they may look (`read`) or also steer it (`write`). */
export interface DesignGrant extends DesignAccess {
  access: "read" | "write";
}

type DesignContext = { var: { deps: Pick<Deps, "db" | "github" | "clock">; actor: Actor } };

/**
 * The design `designId` names, if the caller may `need` it. Opening a design takes read access
 * to its repository and steering it takes write access, both GitHub's to say (docs/cloud.md,
 * "Identity and access"), and either takes membership of its workspace; a Scratch design has
 * no repository and is its owner's alone. A runner may look at and steer its own design and
 * no other.
 */
export async function requireDesign(
  c: DesignContext,
  designId: string,
  need: "read" | "write",
): Promise<DesignGrant> {
  const { deps, actor } = c.var;
  const notFound = new ApiError(404, "not_found", "There is no such design.");
  if (actor.kind === "runner" && actor.designId !== designId) throw notFound;
  const found = await getDesignAccess(deps.db, {
    designId,
    userId: actor.kind === "user" ? actor.user.id : null,
  });
  if (!found) throw notFound;
  const access = actor.kind === "runner" ? "write" : await personAccess(deps, actor.user, found);
  if (!access) throw notFound;
  if (need === "write" && access !== "write") {
    throw new ApiError(403, "forbidden", "You can open this design but not change it.");
  }
  return { ...found, access };
}

/**
 * What a person may do with the design: nothing outside its workspace, and inside it what
 * GitHub lets them do in its repository. Null for nothing.
 */
async function personAccess(
  deps: Pick<Deps, "db" | "github" | "clock">,
  user: User,
  { design, repo, installationId, known, member }: DesignAccess,
): Promise<DesignGrant["access"] | null> {
  // Membership is GitHub's too, and a person who loses it loses the workspace's designs at
  // once, whatever answer about the repo is still kept.
  if (!member) return null;
  if (!repo) return design.ownerId === user.id ? "write" : null;
  // Without the App there is nobody to ask, and nothing the design could do anyway.
  if (installationId === null) return null;
  const permission = await repoPermission(deps, { user, repo, installationId, known });
  if (canWrite(permission)) return "write";
  return permission === "read" ? "read" : null;
}
