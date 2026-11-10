import {
  listStaleInstallations,
  markReposRemovedExcept,
  markWorkspaceUninstalled,
  suspendWorkspace,
  upsertRepos,
  upsertWorkspace,
  type Workspace,
  wasUninstalled,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";

/*
 * One installation of the App, brought in line with GitHub. Whatever asked (a webhook, a sync
 * that found Ponzu's copy old, the scheduled sweep), the answer is read from GitHub as the App
 * at that moment, never taken from a payload: webhooks arrive late, twice and out of order, and
 * the installation as GitHub has it now is the one thing that is right whichever arrives last.
 *
 * These reads count against the installation's own hourly budget, which every token minted
 * for it shares (git, permission checks), so a person's sync does not make them every time:
 * see `syncGithub`.
 */

type ReconcileDeps = Pick<Deps, "db" | "clock" | "github" | "log">;

/** All it takes to read an installation's account and repo list. */
const READ_REPOSITORIES = { metadata: "read" } as const;

/** How long the sweep leaves an installation before reading it again with nothing else asking. */
const SWEEP_AFTER_MS = 6 * 3600_000;

/**
 * Bring an installation's workspace and repos in line with GitHub, and answer the workspace.
 *
 * - Gone from GitHub (uninstalled): the workspace keeps its row, members and designs, loses the
 *   installation, and its repos are marked removed. Answers null.
 * - Suspended: recorded on the workspace if Ponzu has one; GitHub mints a suspended
 *   installation no token, so its repos stay as last seen. Answers that workspace, or null
 *   when there is none: a suspension makes no new workspace.
 * - Otherwise the workspace is made or updated, every repo the installation can see is
 *   recorded, and any it no longer sees is marked removed (never deleted: designs point at
 *   it). A repo list GitHub served only in part marks nothing removed.
 *
 * `installedByUserId` is who installed it, for a webhook that says so; it fills in an unknown
 * installer and never replaces a known one. Safe to run any number of times, at once.
 */
export async function reconcileInstallation(
  { db, clock, github, log }: ReconcileDeps,
  installationId: number,
  { installedByUserId = null }: { installedByUserId?: string | null } = {},
): Promise<Workspace | null> {
  const readAt = new Date(clock.now());
  const installation = await github.getInstallation(installationId);
  if (!installation) {
    await markWorkspaceUninstalled(db, installationId);
    return null;
  }
  if (installation.suspendedAt) {
    return suspendWorkspace(db, {
      installationId,
      suspendedAt: installation.suspendedAt,
      reconciledAt: readAt,
    });
  }

  // Never stored: it is good for an hour and minted again next time.
  const { token } = await github.createInstallationToken({
    installationId,
    permissions: READ_REPOSITORIES,
  });
  const { account } = installation;
  const [name, repositories] = await Promise.all([
    github.getAccountName(token, account.login),
    github.listRepositoriesAsInstallation(token),
  ]);

  const workspace = await upsertWorkspace(db, {
    githubAccountId: account.id,
    githubLogin: account.login,
    kind: account.type === "Organization" ? "org" : "personal",
    name: name ?? account.login,
    avatarUrl: account.avatarUrl,
    installationId,
    repositorySelection: installation.repositorySelection,
    installedByUserId,
    suspendedAt: null,
    reconciledAt: readAt,
  });
  await upsertRepos(db, {
    workspaceId: workspace.id,
    repos: repositories.items.map((repository) => ({
      githubRepoId: repository.id,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      private: repository.private,
      pushedAt: repository.pushedAt,
    })),
  });
  if (repositories.complete) {
    await markReposRemovedExcept(db, {
      workspaceId: workspace.id,
      githubRepoIds: repositories.items.map((repository) => repository.id),
    });
  } else {
    log.warn("github_repositories_cut_short", {
      installationId,
      listed: repositories.items.length,
    });
  }

  // GitHub may have reported the installation gone while this was reading it, and that
  // uninstall would then be underneath what this just wrote. An installation id is never used
  // again, so it is applied again on top.
  if (await wasUninstalled(db, installationId)) {
    await markWorkspaceUninstalled(db, installationId);
    return null;
  }
  return workspace;
}

/**
 * The scheduled backstop: read again the installations nobody has had a reason to read for a
 * while, a few each run. It catches whatever no webhook said (GitHub does not retry a delivery
 * that failed) and nobody's sync noticed (an uninstall, which no token lists any more).
 */
export async function sweepInstallations(deps: ReconcileDeps, { limit }: { limit: number }) {
  const before = new Date(deps.clock.now() - SWEEP_AFTER_MS);
  const installationIds = await listStaleInstallations(deps.db, { before, limit });
  const results = await Promise.allSettled(
    installationIds.map((installationId) => reconcileInstallation(deps, installationId)),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      deps.log.warn("github_sweep_failed", {
        installationId: installationIds[index],
        error: result.reason,
      });
    }
  });
  return installationIds.length;
}
