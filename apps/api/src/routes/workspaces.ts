import {
  AGENT_STATES,
  DESIGN_STATUSES,
  GITHUB_ACCESS,
  getWorkspace,
  listUserWorkspaces,
  listWorkspaceDesigns,
  listWorkspaceMembers,
  listWorkspacePeople,
  listWorkspaceRepos,
  MEMBER_ROLES,
  type MemberWorkspace,
  PR_CHECKS,
  PR_STATES,
  REPOSITORY_SELECTIONS,
  setMemberRole,
  WORKSPACE_KINDS,
  type WorkspacePerson,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { requireWorkspace } from "../auth/authorize.ts";
import { refreshWorkspaceRepoAccess } from "../auth/repo-access.ts";
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
  /** How GitHub says they reach it. An `owner` is always an admin and cannot be demoted. */
  githubAccess: z.enum(GITHUB_ACCESS),
});

/**
 * Someone GitHub says can reach the workspace, whether or not they have opened Ponzu. Someone
 * who has not has no Ponzu user and no role yet: there is nothing to change about them here.
 */
export const WorkspacePersonView = z.object({
  githubUserId: z.number(),
  githubLogin: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** Whether they have opened Ponzu and are in the workspace there. */
  joined: z.boolean(),
  /** Their Ponzu user once they have joined; null until then. */
  userId: z.string().nullable(),
  /** Their role once they have joined; null until then. */
  role: z.enum(MEMBER_ROLES).nullable(),
  /** How GitHub says they reach it. */
  githubAccess: z.enum(GITHUB_ACCESS),
});

export const toPersonView = (person: WorkspacePerson): z.input<typeof WorkspacePersonView> => ({
  ...person,
  joined: person.userId !== null,
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
  /**
   * The repos of it the caller can open, as GitHub said within the last minute (`repo_access`,
   * refreshed before answering), most recently pushed first.
   */
  repos: z.array(
    z.object({
      id: z.string(),
      fullName: z.string(),
      name: z.string(),
      defaultBranch: z.string(),
      private: z.boolean(),
      pushedAt: z.date().nullable(),
      canPush: z.boolean(),
    }),
  ),
  /**
   * Admins first, then by name. Someone who reaches the workspace only through repos shared
   * with them sees only themselves: GitHub does not show them who else is in it.
   */
  members: z.array(Member),
  /**
   * Everyone GitHub says can reach the workspace, whether or not they have opened Ponzu: those
   * who have (`joined`, as in `members`) first, admins first, then the rest, each by name. Only
   * whom GitHub would show this person: an owner of the account sees everyone; a member sees
   * its owners and members, and an outside collaborator only if they share a repo the member can
   * push to; someone who reaches it only through repos shared with them sees only themselves.
   */
  people: z.array(WorkspacePersonView),
});

/** A row of the sidebar: what `workspace.designs` delivers live, plus how far the person has looked. */
const DesignRow = z.object({
  id: z.string(),
  workspaceId: z.string(),
  repoId: z.string().nullable(),
  repoFullName: z.string().nullable(),
  ownerId: z.string().nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  branch: z.string().nullable(),
  status: z.enum(DESIGN_STATUSES),
  settledAt: z.date().nullable(),
  seq: z.number(),
  previewSeq: z.number().nullable(),
  agentState: z.enum(AGENT_STATES),
  agentStatus: z.string().nullable(),
  needsYouCount: z.number(),
  prNumber: z.number().nullable(),
  prState: z.enum(PR_STATES).nullable(),
  prChecks: z.enum(PR_CHECKS),
  lastActivityAt: z.date(),
  createdAt: z.date(),
  seenSeq: z.number().nullable(),
  seenThreadSeq: z.number().nullable(),
});

const DesignList = z.object({ designs: z.array(DesignRow) });

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
    const { user } = c.var.actor;
    const member = await requireWorkspace(c, c.req.valid("param").id);
    // The repos are listed from `repo_access`, so what it says is brought up to the minute
    // first, as for the design list: a repo they lost leaves the list within it.
    await refreshWorkspaceRepoAccess(
      { ...c.var.deps, log: c.var.log },
      { user, workspace: member },
    );
    const [workspace, repos, everyone, people] = await Promise.all([
      getWorkspace(db, member.id),
      listWorkspaceRepos(db, { workspaceId: member.id, userId: user.id }),
      listWorkspaceMembers(db, member.id),
      // Only those GitHub would show them: chosen in the query.
      listWorkspacePeople(db, { workspaceId: member.id, viewerUserId: user.id }),
    ]);
    const onlySelf = member.githubAccess === "collaborator";
    const members = onlySelf ? everyone.filter(({ userId }) => userId === user.id) : everyone;
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
        people: people.map(toPersonView),
      }),
    );
  })

  /**
   * The workspace's designs, for a first paint; the `workspace.designs` live query keeps them
   * fresh. Like the live query, it lists the designs in repos GitHub lets the person read, as
   * of the last minute, and their own Scratch designs.
   */
  .get("/:id/designs", validate("param", WorkspaceParam), async (c) => {
    const { user } = c.var.actor;
    const workspace = await requireWorkspace(c, c.req.valid("param").id);
    await refreshWorkspaceRepoAccess({ ...c.var.deps, log: c.var.log }, { user, workspace });
    const designs = await listWorkspaceDesigns(c.var.deps.db, {
      workspaceId: workspace.id,
      userId: user.id,
    });
    return c.json(DesignList.parse({ designs }));
  })

  /**
   * Set a member's role. Admins only. Membership itself is GitHub's; the role is the one thing
   * Ponzu adds, and a sync never changes it afterwards. Neither an owner of the account nor the
   * last admin can be demoted.
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
      if (result === "owner") {
        throw new ApiError(
          409,
          "owner_is_admin",
          "GitHub says this person owns the account, so they are always an admin.",
        );
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
