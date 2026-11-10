import {
  getWorkspace,
  listUserWorkspaces,
  listWorkspaceMembers,
  listWorkspaceRepos,
  MEMBER_ROLES,
  type MemberWorkspace,
  REPOSITORY_SELECTIONS,
  setMemberRole,
  WORKSPACE_KINDS,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { requireWorkspace } from "../auth/authorize.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";

/** A workspace as the switcher shows it to one of its members. */
const WorkspaceSummary = z.object({
  id: z.string(),
  githubAccountId: z.number(),
  githubLogin: z.string(),
  name: z.string(),
  kind: z.enum(WORKSPACE_KINDS),
  avatarUrl: z.string().nullable(),
  /** The caller's role in it. */
  role: z.enum(MEMBER_ROLES),
  /** False once the GitHub App has been removed from the account. */
  installed: z.boolean(),
  suspended: z.boolean(),
});

const toSummary = (workspace: MemberWorkspace): z.input<typeof WorkspaceSummary> => ({
  ...workspace,
  installed: workspace.installationId !== null,
  suspended: workspace.suspendedAt !== null,
});

const Member = z.object({
  userId: z.string(),
  githubLogin: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(MEMBER_ROLES),
});

const WorkspaceProfile = z.object({
  workspace: WorkspaceSummary.extend({
    /** The App on the account, for Settings › GitHub. Null while it is not installed. */
    installation: z
      .object({
        id: z.number(),
        repositorySelection: z.enum(REPOSITORY_SELECTIONS),
        installedAt: z.date().nullable(),
        /** Who installed it, when Ponzu knows: their GitHub login. */
        installedBy: z.string().nullable(),
        suspendedAt: z.date().nullable(),
      })
      .nullable(),
  }),
  /** The repos Ponzu can open, most recently pushed first. */
  repos: z.array(
    z.object({
      id: z.string(),
      fullName: z.string(),
      name: z.string(),
      defaultBranch: z.string(),
      private: z.boolean(),
      pushedAt: z.date().nullable(),
    }),
  ),
  /** Admins first, then by name. */
  members: z.array(Member),
});

const WorkspaceParam = z.object({ id: z.string().max(64) });
const MemberParam = WorkspaceParam.extend({ userId: z.string().max(64) });
const RoleBody = z.object({ role: z.enum(MEMBER_ROLES) });

export const workspaces = new Hono<AppEnv>()
  .use(access.user)

  /** The switcher: every workspace the person is in, their own account's first. */
  .get("/", async (c) => {
    const { user } = c.var.actor;
    const listed = (await listUserWorkspaces(c.var.deps.db, user.id)).sort(
      (a, b) =>
        Number(b.githubAccountId === user.githubUserId) -
          Number(a.githubAccountId === user.githubUserId) || a.name.localeCompare(b.name),
    );
    return c.json(
      z.object({ workspaces: z.array(WorkspaceSummary) }).parse({
        workspaces: listed.map(toSummary),
      }),
    );
  })

  /** One workspace: its profile, its installation, its repos and its members with their roles. */
  .get("/:id", validate("param", WorkspaceParam), async (c) => {
    const { db } = c.var.deps;
    const member = await requireWorkspace(c, c.req.valid("param").id);
    const [workspace, repos, members] = await Promise.all([
      getWorkspace(db, member.id),
      listWorkspaceRepos(db, member.id),
      listWorkspaceMembers(db, member.id),
    ]);
    if (!workspace) throw new ApiError(404, "not_found", "There is no such workspace.");
    return c.json(
      WorkspaceProfile.parse({
        workspace: {
          ...toSummary(member),
          installation:
            workspace.installationId === null
              ? null
              : {
                  id: workspace.installationId,
                  repositorySelection: workspace.repositorySelection ?? "selected",
                  installedAt: workspace.installedAt,
                  installedBy: workspace.installedByLogin,
                  suspendedAt: workspace.suspendedAt,
                },
        },
        repos: repos.map((repo) => ({
          ...repo,
          name: repo.fullName.slice(repo.fullName.indexOf("/") + 1),
        })),
        members,
      }),
    );
  })

  /**
   * Set a member's role. Admins only. Membership itself is GitHub's; the role is the one thing
   * Ponzu adds, and a sync never changes it afterwards. The last admin cannot be demoted.
   */
  .patch(
    "/:id/members/:userId",
    validate("param", MemberParam),
    validate("json", RoleBody),
    async (c) => {
      const { db } = c.var.deps;
      const { id, userId } = c.req.valid("param");
      const workspace = await requireWorkspace(c, id, "admin");
      const { role } = c.req.valid("json");
      const result = await setMemberRole(db, { workspaceId: workspace.id, userId, role });
      if (result === "not_member") {
        throw new ApiError(404, "not_found", "There is no such member in this workspace.");
      }
      if (result === "last_admin") {
        throw new ApiError(
          409,
          "last_admin",
          "A workspace needs an admin. Make someone else an admin first.",
        );
      }
      const member = (await listWorkspaceMembers(db, workspace.id)).find(
        (candidate) => candidate.userId === userId,
      );
      if (!member)
        throw new ApiError(404, "not_found", "There is no such member in this workspace.");
      return c.json(z.object({ member: Member }).parse({ member }));
    },
  );
