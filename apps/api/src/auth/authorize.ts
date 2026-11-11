import {
  type DesignAccess,
  getDesignAccess,
  getMemberWorkspace,
  getRepoIdeasAccess,
  type MemberRole,
  type MemberWorkspace,
  type RepoIdeasAccess,
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
 * The repo `repoId` names, with its ideas, if the signed-in person may read it: a member of its
 * workspace whom GitHub lets read the repo (as `requireDesign` asks for a design in it). The
 * same 404 when it does not exist, the App has lost it, or the person may not read it. Pass
 * `"write"` for something only someone who can push to it may do: 403 for a reader.
 */
export async function requireRepo(
  c: { var: { deps: Pick<Deps, "db" | "github" | "clock">; actor: UserActor } },
  repoId: string,
  need: "read" | "write" = "read",
): Promise<RepoIdeasAccess> {
  const { deps, actor } = c.var;
  const found = await getRepoIdeasAccess(deps.db, { repoId, userId: actor.user.id });
  if (!found?.member) throw new ApiError(404, "not_found", "There is no such repo.");
  const permission = await repoPermission(deps, {
    user: actor.user,
    repo: found.repo,
    installation: { installationId: found.installationId, suspendedAt: found.suspendedAt },
    known: found.known,
  });
  if (permission === "none") throw new ApiError(404, "not_found", "There is no such repo.");
  if (need === "write" && !canWrite(permission)) {
    throw new ApiError(403, "forbidden", "You can read this repo but not push to it.");
  }
  return found;
}

/**
 * What a person may do with the design: nothing outside its workspace, and inside it what
 * GitHub lets them do in its repository. Null for nothing.
 */
async function personAccess(
  deps: Pick<Deps, "db" | "github" | "clock">,
  user: User,
  { design, repo, installationId, suspendedAt, known, member }: DesignAccess,
): Promise<DesignGrant["access"] | null> {
  // Membership is GitHub's too, and a person who loses it loses the workspace's designs at
  // once, whatever answer about the repo is still kept.
  if (!member) return null;
  if (!repo) return design.ownerId === user.id ? "write" : null;
  // Without the App, or while it is suspended, it is `none`: nobody to ask, and nothing the
  // design could do anyway.
  const installation = { installationId, suspendedAt };
  const permission = await repoPermission(deps, { user, repo, installation, known });
  if (canWrite(permission)) return "write";
  return permission === "read" ? "read" : null;
}
