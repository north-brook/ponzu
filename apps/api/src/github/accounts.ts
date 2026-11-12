import { countWorkspacePeople, listUserWorkspaces, type User, type WorkspaceKind } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";

/** One row of the "Where do you build?" step: a GitHub account the person could build in. */
export interface GithubAccountRow {
  githubAccountId: number;
  login: string;
  /** Who the account is to people: the person's name, an organization's display name. */
  name: string;
  avatarUrl: string | null;
  kind: WorkspaceKind;
  /**
   * `ready`: the App is installed and the person reaches it. `not_installed` is only ever the
   * person's own account: their GitHub token does not show organizations without the App.
   */
  status: "ready" | "not_installed";
  /** The workspace it is, once ready. */
  workspaceId: string | null;
  suspended: boolean;
  /**
   * How many people GitHub says can reach a ready workspace's repos, whether or not they have
   * opened Ponzu (`github/people.ts`). Null until GitHub has been read for it, for the
   * person's own account, whose row shows no count, and for one they reach only as an outside
   * collaborator, who is not shown who else is in it.
   */
  memberCount: number | null;
}

/**
 * The person's own account first, then every account where the App is installed and they are
 * a member, by name. As of the last sync: call `syncGithub` first for a fresh answer.
 */
export async function listGithubAccounts(
  { db }: Pick<Deps, "db">,
  user: User,
): Promise<GithubAccountRow[]> {
  const installed = (await listUserWorkspaces(db, user.id)).filter(
    (workspace) => workspace.installationId !== null,
  );
  const own = installed.find((workspace) => workspace.githubAccountId === user.githubUserId);
  const others = installed
    .filter((workspace) => workspace !== own)
    .sort((a, b) => a.name.localeCompare(b.name) || a.githubLogin.localeCompare(b.githubLogin));
  const counts = new Map(
    // Each counts only the people this person is shown (docs/cloud.md, "Identity and access"):
    // someone who reaches a workspace only through repos shared with them is not shown who
    // else is in it, nor how many.
    (
      await countWorkspacePeople(db, {
        viewerUserId: user.id,
        workspaceIds: others
          .filter((workspace) => workspace.githubAccess !== "collaborator")
          .map((workspace) => workspace.id),
      })
    ).map(({ workspaceId, people }) => [workspaceId, people]),
  );

  return [
    {
      githubAccountId: user.githubUserId,
      login: user.githubLogin,
      name: user.name ?? user.githubLogin,
      avatarUrl: user.avatarUrl,
      kind: "personal",
      status: own ? "ready" : "not_installed",
      workspaceId: own?.id ?? null,
      suspended: own?.suspendedAt != null,
      memberCount: null,
    },
    ...others.map((workspace) => ({
      githubAccountId: workspace.githubAccountId,
      login: workspace.githubLogin,
      name: workspace.name,
      avatarUrl: workspace.avatarUrl,
      kind: workspace.kind,
      status: "ready" as const,
      workspaceId: workspace.id,
      suspended: workspace.suspendedAt !== null,
      memberCount: counts.get(workspace.id) ?? null,
    })),
  ];
}
