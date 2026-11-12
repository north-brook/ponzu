import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import {
  claudeAccounts,
  type GithubAccess,
  type MemberRole,
  memberships,
  repoAccess,
  repos,
  uninstalledInstallations,
  users,
  workspaces,
} from "../schema/index.ts";
import { markRepoAccessStale, READABLE_PERMISSIONS } from "./repo-access.ts";
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
 * `created` says whether this made the row: the person's sign-up.
 */
export async function upsertUser(
  db: Db,
  profile: GithubProfile,
): Promise<User & { created: boolean }> {
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
      // An inserted row has no deleting transaction; an updated one has this one's.
      .returning({ ...getTableColumns(users), created: sql<boolean>`(xmax = 0)` }),
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
  /** When this was read from GitHub as the App. Left out, the last time is kept. */
  reconciledAt?: Date;
}

/**
 * The workspace for a GitHub account the App is installed on. The account is the key, so a
 * reinstall comes back to the same workspace. Who installed it and when are kept until the
 * installation itself changes; an installer learned later (the person who came back from the
 * install page, after a webhook that could not name them) fills in an unknown one.
 *
 * `connected` says whether this call is the one that made the account's installation work: it
 * made the row, put a new installation on it, or lifted a suspension. Of any number of calls at
 * once for the same installation (its webhook and the setup that follows it), exactly one says
 * so: the insert has one winner, and the update locks the row as it reads it, so a call that
 * waited for another reads what that one wrote.
 */
export async function upsertWorkspace(
  db: Db,
  installation: GithubInstallation,
): Promise<Workspace & { connected: boolean }> {
  const [inserted] = await run(
    db
      .insert(workspaces)
      .values({ id: newId("ws"), ...installation, installedAt: sql`now()` })
      .onConflictDoNothing({ target: workspaces.githubAccountId })
      .returning(),
  );
  if (inserted) return { ...inserted, connected: inserted.suspendedAt === null };

  // `from` the same row under another name reads it as it was before the update.
  const before = db.$with("before").as(
    db
      .select({
        id: workspaces.id,
        installationId: workspaces.installationId,
        suspendedAt: workspaces.suspendedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.githubAccountId, installation.githubAccountId))
      .for("update"),
  );
  const reinstalled = sql`(${before.installationId} is distinct from ${installation.installationId}::bigint)`;
  const installer = sql`${installation.installedByUserId}::text`;
  const suspendedAt =
    installation.suspendedAt === undefined
      ? sql`case when ${reinstalled} then null else ${workspaces.suspendedAt} end`
      : installation.suspendedAt;
  const [workspace] = await run(
    db
      .with(before)
      .update(workspaces)
      .set({
        githubLogin: installation.githubLogin,
        kind: installation.kind,
        name: installation.name,
        avatarUrl: installation.avatarUrl,
        installationId: installation.installationId,
        repositorySelection: installation.repositorySelection,
        installedByUserId: sql`case when ${reinstalled} then ${installer} else coalesce(${workspaces.installedByUserId}, ${installer}) end`,
        installedAt: sql`case when ${reinstalled} then now() else ${workspaces.installedAt} end`,
        suspendedAt,
        ...(installation.reconciledAt ? { reconciledAt: installation.reconciledAt } : {}),
      })
      .from(before)
      .where(eq(workspaces.id, before.id))
      .returning({
        ...getTableColumns(workspaces),
        connected: sql<boolean>`(${workspaces.suspendedAt} is null and (${reinstalled} or ${before.suspendedAt} is not null))`,
      }),
  );
  return workspace!;
}

/** The person with this id, or null. */
export async function getUser(db: Db, userId: string): Promise<User | null> {
  const [user] = await run(db.select().from(users).where(eq(users.id, userId)));
  return user ?? null;
}

/** A guided setup step that leaves no other trace: "Where do you design?" and the iPhone step. */
export type OnboardingStep = "where" | "iphone";

/**
 * Records that the person finished a step of guided setup, the first time only: a step done
 * again on another device keeps when it was first done. Answers both steps as they now stand.
 */
export async function recordOnboardingStep(
  db: Db,
  { userId, step, at }: { userId: string; step: OnboardingStep; at: Date },
): Promise<{ whereAt: Date | null; iphoneAt: Date | null }> {
  const first = (column: typeof users.onboardingWhereAt) =>
    sql`coalesce(${column}, ${at.toISOString()}::timestamptz)`;
  const [row] = await run(
    db
      .update(users)
      .set(
        step === "where"
          ? { onboardingWhereAt: first(users.onboardingWhereAt) }
          : { onboardingIphoneAt: first(users.onboardingIphoneAt) },
      )
      .where(eq(users.id, userId))
      .returning({ whereAt: users.onboardingWhereAt, iphoneAt: users.onboardingIphoneAt }),
  );
  return row ?? { whereAt: null, iphoneAt: null };
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
 * Record GitHub's word, read at `reconciledAt`, that an installation is suspended. Only a
 * workspace Ponzu already has is touched: null when no workspace holds the installation.
 */
export async function suspendWorkspace(
  db: Db,
  {
    installationId,
    suspendedAt,
    reconciledAt,
  }: { installationId: number; suspendedAt: Date; reconciledAt: Date },
): Promise<Workspace | null> {
  const [row] = await run(
    db
      .update(workspaces)
      .set({ suspendedAt, reconciledAt })
      .where(eq(workspaces.installationId, installationId))
      .returning(),
  );
  return row ?? null;
}

/**
 * The App was removed from an account: its workspace keeps its row, canvases and members but
 * loses the installation, and its repos are marked removed, in one statement. The installation
 * is remembered as gone (`wasUninstalled`) even when no workspace holds it (never seen, or
 * already replaced by a reinstall). Answers the workspace's id, or null.
 */
export async function markWorkspaceUninstalled(
  db: Db,
  installationId: number,
): Promise<string | null> {
  const remembered = db
    .$with("remembered")
    .as(
      db
        .insert(uninstalledInstallations)
        .values({ installationId })
        .onConflictDoNothing()
        .returning({ installationId: uninstalledInstallations.installationId }),
    );
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
    db.with(remembered, uninstalled, removed).select({ id: uninstalled.id }).from(uninstalled),
  );
  return row?.id ?? null;
}

/** Whether GitHub has said this installation is gone (`markWorkspaceUninstalled`). */
export async function wasUninstalled(db: Db, installationId: number): Promise<boolean> {
  const rows = await run(
    db
      .select({ installationId: uninstalledInstallations.installationId })
      .from(uninstalledInstallations)
      .where(eq(uninstalledInstallations.installationId, installationId)),
  );
  return rows.length > 0;
}

/**
 * Installations Ponzu holds that were last read from GitHub before `before` (or never),
 * longest ago first: what the scheduled reconcile catches up, a few at a time.
 */
export async function listStaleInstallations(
  db: Db,
  { before, limit }: { before: Date; limit: number },
): Promise<number[]> {
  const rows = await run(
    db
      .select({ installationId: workspaces.installationId })
      .from(workspaces)
      .where(
        and(
          isNotNull(workspaces.installationId),
          or(isNull(workspaces.reconciledAt), lt(workspaces.reconciledAt, before)),
        ),
      )
      .orderBy(sql`${workspaces.reconciledAt} asc nulls first`, asc(workspaces.installationId))
      .limit(limit),
  );
  return rows.map((row) => row.installationId!);
}

/**
 * Record that GitHub says a person can reach a workspace, and how (`githubAccess`, kept as it
 * was when left out). `role` is used only for a new member: the role is Ponzu's own and a sync
 * must never undo a change an admin made. The one exception is an owner of the account, who
 * is always an admin, so nobody can take a workspace from the people GitHub says own it.
 */
export async function upsertMembership(
  db: Db,
  membership: {
    workspaceId: string;
    userId: string;
    role: MemberRole;
    githubAccess?: GithubAccess;
  },
): Promise<Membership> {
  const [row] = await run(
    db
      .insert(memberships)
      .values(membership)
      .onConflictDoUpdate({
        target: [memberships.workspaceId, memberships.userId],
        set: {
          syncedAt: sql`now()`,
          ...(membership.githubAccess
            ? {
                githubAccess: membership.githubAccess,
                role: sql`case when excluded.github_access = 'owner' then 'admin' else ${memberships.role} end`,
              }
            : {}),
        },
      })
      .returning(),
  );
  return row!;
}

/** A workspace as one of its members sees it in a list. */
export type MemberWorkspace = Pick<
  Workspace,
  | "id"
  | "githubAccountId"
  | "githubLogin"
  | "kind"
  | "name"
  | "avatarUrl"
  | "installationId"
  | "suspendedAt"
> & { role: MemberRole; githubAccess: GithubAccess };

const memberWorkspaceColumns = {
  id: workspaces.id,
  githubAccountId: workspaces.githubAccountId,
  githubLogin: workspaces.githubLogin,
  kind: workspaces.kind,
  name: workspaces.name,
  avatarUrl: workspaces.avatarUrl,
  installationId: workspaces.installationId,
  suspendedAt: workspaces.suspendedAt,
  role: memberships.role,
  githubAccess: memberships.githubAccess,
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
 * GitHub, for the installations they can no longer reach. Answers the workspaces they left,
 * each of which may now need an admin (`ensureWorkspaceAdmin`).
 *
 * Their own account's workspace is never one of them: it stays theirs with the App removed
 * from it, as their canvases in it do.
 */
export async function deleteMembershipsExcept(
  db: Db,
  { userId, workspaceIds }: { userId: string; workspaceIds: string[] },
): Promise<string[]> {
  const ownAccount = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(users, eq(users.githubUserId, workspaces.githubAccountId))
    .where(eq(users.id, userId));
  const dropped = await run(
    db
      .delete(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          workspaceIds.length > 0 ? notInArray(memberships.workspaceId, workspaceIds) : undefined,
          notInArray(memberships.workspaceId, ownAccount),
        ),
      )
      .returning({ workspaceId: memberships.workspaceId }),
  );
  return dropped.map((row) => row.workspaceId);
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
 * seen again after it was removed keeps its row, and with it its base, secrets and canvases.
 * Its canvases move to the new workspace with it, in the same statement: their foreign key is
 * the repo and its workspace together, and cascades.
 */
export async function upsertRepos(
  db: Db,
  { workspaceId, repos: seen }: { workspaceId: string; repos: GithubRepo[] },
): Promise<Repo[]> {
  if (seen.length === 0) return [];
  // A repo that moved to another account or changed visibility changed who may read it, so
  // what anyone was told about it is asked again before it is trusted (`repo_access`), however
  // Ponzu learned of the change: a webhook, someone's sync, or the sweep.
  const known = await run(
    db
      .select({
        githubRepoId: repos.githubRepoId,
        workspaceId: repos.workspaceId,
        private: repos.private,
      })
      .from(repos)
      .where(
        inArray(
          repos.githubRepoId,
          seen.map(({ githubRepoId }) => githubRepoId),
        ),
      ),
  );
  const visibility = new Map(seen.map((repo) => [repo.githubRepoId, repo.private]));
  const changed = known
    .filter(
      (repo) =>
        repo.workspaceId !== workspaceId || repo.private !== visibility.get(repo.githubRepoId),
    )
    .map(({ githubRepoId }) => githubRepoId);
  await markRepoAccessStale(db, { githubRepoIds: changed });
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

/**
 * The repos of a workspace one member can open, as GitHub last said (`repo_access`), most
 * recently pushed first, with whether they can push to each. That they are a member, and how
 * recent those answers must be, is the caller's to decide.
 */
export function listWorkspaceRepos(
  db: Db,
  { workspaceId, userId }: { workspaceId: string; userId: string },
): Promise<(Repo & { canPush: boolean })[]> {
  return run(
    db
      .select({
        ...getTableColumns(repos),
        canPush: sql<boolean>`${repoAccess.permission} in ('admin', 'write')`.mapWith(Boolean),
      })
      .from(repos)
      .innerJoin(
        repoAccess,
        and(
          eq(repoAccess.repoId, repos.id),
          eq(repoAccess.userId, userId),
          inArray(repoAccess.permission, READABLE_PERMISSIONS),
        ),
      )
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

/** Mark repos the App can no longer see. Their rows stay, because canvases point at them. */
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
