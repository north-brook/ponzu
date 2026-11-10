import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { type MemberRole, memberships, repos, users, workspaces } from "../schema/index.ts";

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Repo = typeof repos.$inferSelect;

export interface GithubProfile {
  workosUserId: string;
  githubUserId: number;
  githubLogin: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/** The person signing in: made on their first sign-in, brought up to date with GitHub on each one after. */
export async function upsertUser(db: Db, profile: GithubProfile): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ id: newId("usr"), ...profile })
    .onConflictDoUpdate({
      target: users.workosUserId,
      set: {
        githubUserId: profile.githubUserId,
        githubLogin: profile.githubLogin,
        name: profile.name,
        email: profile.email,
        avatarUrl: profile.avatarUrl,
      },
    })
    .returning();
  return user!;
}

export interface GithubInstallation {
  githubAccountId: number;
  githubLogin: string;
  kind: Workspace["kind"];
  name: string;
  avatarUrl: string | null;
  installationId: number;
  repositorySelection: NonNullable<Workspace["repositorySelection"]>;
  /** Who installed the App, when we know. */
  installedByUserId: string | null;
}

/**
 * The workspace for a GitHub account the App is installed on. The account is the key, so a
 * reinstall comes back to the same workspace. Who installed it and when are kept until the
 * installation itself changes.
 */
export async function upsertWorkspace(
  db: Db,
  installation: GithubInstallation,
): Promise<Workspace> {
  const reinstalled = sql`${workspaces.installationId} is distinct from excluded.installation_id`;
  const [workspace] = await db
    .insert(workspaces)
    .values({ id: newId("ws"), ...installation, installedAt: sql`now()` })
    .onConflictDoUpdate({
      target: workspaces.githubAccountId,
      set: {
        githubLogin: installation.githubLogin,
        kind: installation.kind,
        name: installation.name,
        avatarUrl: installation.avatarUrl,
        installationId: installation.installationId,
        repositorySelection: installation.repositorySelection,
        installedByUserId: sql`case when ${reinstalled} then excluded.installed_by_user_id else ${workspaces.installedByUserId} end`,
        installedAt: sql`case when ${reinstalled} then now() else ${workspaces.installedAt} end`,
        suspendedAt: sql`case when ${reinstalled} then null else ${workspaces.suspendedAt} end`,
      },
    })
    .returning();
  return workspace!;
}

/**
 * Record that GitHub says a person can reach a workspace. `role` is used only for a new
 * member: the role is Ponzu's own and a sync must never undo a change an admin made.
 */
export async function upsertMembership(
  db: Db,
  membership: { workspaceId: string; userId: string; role: MemberRole },
): Promise<Membership> {
  const [row] = await db
    .insert(memberships)
    .values(membership)
    .onConflictDoUpdate({
      target: [memberships.workspaceId, memberships.userId],
      set: { syncedAt: sql`now()` },
    })
    .returning();
  return row!;
}

/**
 * Drop a person's memberships of every workspace not listed: the other half of syncing with
 * GitHub, for the installations they can no longer reach. Answers how many were dropped.
 */
export async function deleteMembershipsExcept(
  db: Db,
  { userId, workspaceIds }: { userId: string; workspaceIds: string[] },
): Promise<number> {
  const dropped = await db
    .delete(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        workspaceIds.length > 0 ? notInArray(memberships.workspaceId, workspaceIds) : undefined,
      ),
    )
    .returning({ workspaceId: memberships.workspaceId });
  return dropped.length;
}

export interface GithubRepo {
  githubRepoId: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  pushedAt: Date | null;
}

/**
 * The repos an installation can see. A repo that was renamed, moved to another workspace or
 * seen again after it was removed keeps its row, and with it its base, secrets and designs.
 */
export async function upsertRepos(
  db: Db,
  { workspaceId, repos: seen }: { workspaceId: string; repos: GithubRepo[] },
): Promise<Repo[]> {
  if (seen.length === 0) return [];
  return db
    .insert(repos)
    .values(seen.map((repo) => ({ id: newId("repo"), workspaceId, ...repo })))
    .onConflictDoUpdate({
      target: repos.githubRepoId,
      set: {
        workspaceId: sql`excluded.workspace_id`,
        fullName: sql`excluded.full_name`,
        defaultBranch: sql`excluded.default_branch`,
        private: sql`excluded.private`,
        pushedAt: sql`excluded.pushed_at`,
        removedAt: null,
      },
    })
    .returning();
}

/** Mark repos the App can no longer see. Their rows stay, because designs point at them. */
export async function markReposRemoved(db: Db, githubRepoIds: number[]): Promise<number> {
  if (githubRepoIds.length === 0) return 0;
  const removed = await db
    .update(repos)
    .set({ removedAt: sql`now()` })
    .where(and(inArray(repos.githubRepoId, githubRepoIds), isNull(repos.removedAt)))
    .returning({ id: repos.id });
  return removed.length;
}
