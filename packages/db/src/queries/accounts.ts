import { and, count, eq, getTableColumns, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import {
  claudeAccounts,
  type MemberRole,
  memberships,
  repos,
  users,
  workspaces,
} from "../schema/index.ts";
import { run } from "./run.ts";

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

/**
 * The person signing in: made on their first sign-in, brought up to date with GitHub on each
 * one after.
 *
 * The GitHub account is who they are. WorkOS keys its users by email and can issue the same
 * person a new id (their user there was deleted and made again, or their GitHub email
 * changed), so a known GitHub id arriving under a new WorkOS id is the same person and takes
 * the new id. It throws only if that WorkOS id already belongs to a different GitHub account.
 */
export async function upsertUser(db: Db, profile: GithubProfile): Promise<User> {
  const [user] = await run(
    db
      .insert(users)
      .values({ id: newId("usr"), ...profile })
      .onConflictDoUpdate({
        target: users.githubUserId,
        set: {
          workosUserId: profile.workosUserId,
          githubLogin: profile.githubLogin,
          name: profile.name,
          email: profile.email,
          avatarUrl: profile.avatarUrl,
        },
      })
      .returning(),
  );
  return user!;
}

/**
 * The person whose last sign-in came through this WorkOS user, or null. For the sign-in
 * exchange, which decides who a WorkOS user is. It does not authenticate anyone: a token's
 * `sub` says which WorkOS user it is for, not that Ponzu let its session in. Requests are
 * authenticated by session (`getSessionUser`).
 */
export async function getUserByWorkosId(db: Db, workosUserId: string): Promise<User | null> {
  const [user] = await run(db.select().from(users).where(eq(users.workosUserId, workosUserId)));
  return user ?? null;
}

// A credential is read only by the code that hands it to a sandbox, which asks for it by name.
const { encryptedCredential: _encryptedCredential, ...claudeAccountColumns } =
  getTableColumns(claudeAccounts);

export type ClaudeAccount = Omit<typeof claudeAccounts.$inferSelect, "encryptedCredential">;

/** A person's Claude account without its credential, or null if they have not connected one. */
export async function getClaudeAccount(db: Db, userId: string): Promise<ClaudeAccount | null> {
  const [account] = await run(
    db.select(claudeAccountColumns).from(claudeAccounts).where(eq(claudeAccounts.userId, userId)),
  );
  return account ?? null;
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
  /** Whether GitHub says it is suspended. Left out, a reinstall clears it and nothing else does. */
  suspendedAt?: Date | null;
}

/**
 * The workspace for a GitHub account the App is installed on. The account is the key, so a
 * reinstall comes back to the same workspace. Who installed it and when are kept until the
 * installation itself changes; an installer learned later (the person who came back from the
 * install page, after a webhook that could not name them) fills in an unknown one.
 */
export async function upsertWorkspace(
  db: Db,
  installation: GithubInstallation,
): Promise<Workspace> {
  const reinstalled = sql`${workspaces.installationId} is distinct from excluded.installation_id`;
  const suspendedAt =
    installation.suspendedAt === undefined
      ? sql`case when ${reinstalled} then null else ${workspaces.suspendedAt} end`
      : installation.suspendedAt;
  const [workspace] = await run(
    db
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
          installedByUserId: sql`case when ${reinstalled} then excluded.installed_by_user_id else coalesce(${workspaces.installedByUserId}, excluded.installed_by_user_id) end`,
          installedAt: sql`case when ${reinstalled} then now() else ${workspaces.installedAt} end`,
          suspendedAt,
        },
      })
      .returning(),
  );
  return workspace!;
}

/** The person with this id, or null. */
export async function getUser(db: Db, userId: string): Promise<User | null> {
  const [user] = await run(db.select().from(users).where(eq(users.id, userId)));
  return user ?? null;
}

/** The person signed in as this GitHub account, or null if they never signed in to Ponzu. */
export async function getUserByGithubId(db: Db, githubUserId: number): Promise<User | null> {
  const [user] = await run(db.select().from(users).where(eq(users.githubUserId, githubUserId)));
  return user ?? null;
}

/** A workspace, with the GitHub login of whoever installed the App on it when that is known. */
export async function getWorkspace(
  db: Db,
  workspaceId: string,
): Promise<(Workspace & { installedByLogin: string | null }) | null> {
  const [row] = await run(
    db
      .select({ ...getTableColumns(workspaces), installedByLogin: users.githubLogin })
      .from(workspaces)
      .leftJoin(users, eq(users.id, workspaces.installedByUserId))
      .where(eq(workspaces.id, workspaceId)),
  );
  return row ?? null;
}

/** The workspace an installation of the App belongs to now, or null. */
export async function getWorkspaceByInstallation(
  db: Db,
  installationId: number,
): Promise<Workspace | null> {
  const [row] = await run(
    db.select().from(workspaces).where(eq(workspaces.installationId, installationId)),
  );
  return row ?? null;
}

/**
 * Record GitHub's word that an installation is suspended. Only a workspace Ponzu already has
 * is touched: null when no workspace holds the installation.
 */
export async function suspendWorkspace(
  db: Db,
  { installationId, suspendedAt }: { installationId: number; suspendedAt: Date },
): Promise<Workspace | null> {
  const [row] = await run(
    db
      .update(workspaces)
      .set({ suspendedAt })
      .where(eq(workspaces.installationId, installationId))
      .returning(),
  );
  return row ?? null;
}

/**
 * The App was removed from an account: its workspace keeps its row, designs and members but
 * loses the installation, and its repos are marked removed, in one statement. An installation
 * no workspace holds (never seen, or already replaced by a reinstall) changes nothing. Answers
 * the workspace's id, or null.
 */
export async function markWorkspaceUninstalled(
  db: Db,
  installationId: number,
): Promise<string | null> {
  const uninstalled = db
    .$with("uninstalled")
    .as(
      db
        .update(workspaces)
        .set({ installationId: null, repositorySelection: null, suspendedAt: null })
        .where(eq(workspaces.installationId, installationId))
        .returning({ id: workspaces.id }),
    );
  const removed = db.$with("removed").as(
    db
      .update(repos)
      .set({ removedAt: sql`now()` })
      .where(
        and(
          inArray(repos.workspaceId, db.select({ id: uninstalled.id }).from(uninstalled)),
          isNull(repos.removedAt),
        ),
      )
      .returning({ id: repos.id }),
  );
  const [row] = await run(
    db.with(uninstalled, removed).select({ id: uninstalled.id }).from(uninstalled),
  );
  return row?.id ?? null;
}

/**
 * Record that GitHub says a person can reach a workspace. `role` is used only for a new
 * member: the role is Ponzu's own and a sync must never undo a change an admin made.
 */
export async function upsertMembership(
  db: Db,
  membership: { workspaceId: string; userId: string; role: MemberRole },
): Promise<Membership> {
  const [row] = await run(
    db
      .insert(memberships)
      .values(membership)
      .onConflictDoUpdate({
        target: [memberships.workspaceId, memberships.userId],
        set: { syncedAt: sql`now()` },
      })
      .returning(),
  );
  return row!;
}

/** A workspace as one of its members sees it in a list. */
export type MemberWorkspace = Pick<
  Workspace,
  "id" | "githubLogin" | "kind" | "name" | "avatarUrl" | "installationId" | "suspendedAt"
> & { role: MemberRole };

const memberWorkspaceColumns = {
  id: workspaces.id,
  githubLogin: workspaces.githubLogin,
  kind: workspaces.kind,
  name: workspaces.name,
  avatarUrl: workspaces.avatarUrl,
  installationId: workspaces.installationId,
  suspendedAt: workspaces.suspendedAt,
  role: memberships.role,
};

/** The workspaces a person belongs to, as GitHub last said, with their role in each. */
export function listUserWorkspaces(db: Db, userId: string): Promise<MemberWorkspace[]> {
  return run(
    db
      .select(memberWorkspaceColumns)
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, userId)),
  );
}

/** One workspace as a member sees it, or null if the person is not a member (or it does not exist). */
export async function getMemberWorkspace(
  db: Db,
  { userId, workspaceId }: { userId: string; workspaceId: string },
): Promise<MemberWorkspace | null> {
  const [workspace] = await run(
    db
      .select(memberWorkspaceColumns)
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId))),
  );
  return workspace ?? null;
}

/**
 * Drop a person's memberships of every workspace not listed: the other half of syncing with
 * GitHub, for the installations they can no longer reach. Answers how many were dropped.
 *
 * A workspace always has an admin. Where the person dropped was its last one, the member who
 * has been there longest becomes admin in the same statement, so no moment and no failure in
 * between leaves the workspace without one.
 */
export async function deleteMembershipsExcept(
  db: Db,
  { userId, workspaceIds }: { userId: string; workspaceIds: string[] },
): Promise<number> {
  const dropped = db.$with("dropped").as(
    db
      .delete(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          workspaceIds.length > 0 ? notInArray(memberships.workspaceId, workspaceIds) : undefined,
        ),
      )
      .returning({ workspaceId: memberships.workspaceId, role: memberships.role }),
  );
  // Every part of a statement sees the table as it was before the delete, so the person being
  // dropped is excluded by name rather than by being gone.
  const heirs = db.$with("heirs").as(
    db
      .selectDistinctOn([memberships.workspaceId], {
        workspaceId: memberships.workspaceId,
        userId: memberships.userId,
      })
      .from(memberships)
      .innerJoin(
        dropped,
        and(eq(dropped.workspaceId, memberships.workspaceId), eq(dropped.role, "admin")),
      )
      .where(
        and(
          ne(memberships.userId, userId),
          sql`not exists (select 1 from ${memberships} as other where other.workspace_id = ${memberships.workspaceId} and other.role = 'admin' and other.user_id <> ${userId})`,
        ),
      )
      .orderBy(memberships.workspaceId, memberships.createdAt, memberships.userId),
  );
  const promoted = db.$with("promoted").as(
    db
      .update(memberships)
      .set({ role: "admin" })
      .from(heirs)
      .where(
        and(eq(memberships.workspaceId, heirs.workspaceId), eq(memberships.userId, heirs.userId)),
      )
      .returning({ userId: memberships.userId }),
  );
  const [row] = await run(
    db.with(dropped, heirs, promoted).select({ count: count() }).from(dropped),
  );
  return row?.count ?? 0;
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
 * Its designs move to the new workspace with it, in the same statement: their foreign key is
 * the repo and its workspace together, and cascades.
 */
export async function upsertRepos(
  db: Db,
  { workspaceId, repos: seen }: { workspaceId: string; repos: GithubRepo[] },
): Promise<Repo[]> {
  if (seen.length === 0) return [];
  return run(
    db
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
      .returning(),
  );
}

/**
 * Mark every repo of a workspace that is not in `githubRepoIds` removed: the other half of
 * reading an installation's whole repo list from GitHub. Answers how many were marked.
 */
export async function markReposRemovedExcept(
  db: Db,
  { workspaceId, githubRepoIds }: { workspaceId: string; githubRepoIds: number[] },
): Promise<number> {
  const removed = await run(
    db
      .update(repos)
      .set({ removedAt: sql`now()` })
      .where(
        and(
          eq(repos.workspaceId, workspaceId),
          isNull(repos.removedAt),
          githubRepoIds.length > 0 ? notInArray(repos.githubRepoId, githubRepoIds) : undefined,
        ),
      )
      .returning({ id: repos.id }),
  );
  return removed.length;
}

/** The repos a workspace can open now, most recently pushed first. */
export function listWorkspaceRepos(db: Db, workspaceId: string): Promise<Repo[]> {
  return run(
    db
      .select()
      .from(repos)
      .where(and(eq(repos.workspaceId, workspaceId), isNull(repos.removedAt)))
      .orderBy(sql`${repos.pushedAt} desc nulls last`, repos.fullName),
  );
}

/** The installation that holds a repo Ponzu knows, or null (unknown, or its App is gone). */
export async function getRepoInstallationId(db: Db, githubRepoId: number): Promise<number | null> {
  const [row] = await run(
    db
      .select({ installationId: workspaces.installationId })
      .from(repos)
      .innerJoin(workspaces, eq(workspaces.id, repos.workspaceId))
      .where(eq(repos.githubRepoId, githubRepoId)),
  );
  return row?.installationId ?? null;
}

/** Mark repos the App can no longer see. Their rows stay, because designs point at them. */
export async function markReposRemoved(db: Db, githubRepoIds: number[]): Promise<number> {
  if (githubRepoIds.length === 0) return 0;
  const removed = await run(
    db
      .update(repos)
      .set({ removedAt: sql`now()` })
      .where(and(inArray(repos.githubRepoId, githubRepoIds), isNull(repos.removedAt)))
      .returning({ id: repos.id }),
  );
  return removed.length;
}
