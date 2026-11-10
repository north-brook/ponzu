import {
  markReposRemovedExcept,
  markWorkspaceUninstalled,
  suspendWorkspace,
  upsertRepos,
  upsertWorkspace,
  type Workspace,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";

/*
 * One installation of the App, brought in line with GitHub. Whatever asked (a person's sync, a
 * webhook), the answer is read from GitHub as the App at that moment, never taken from a
 * payload: webhooks arrive late, twice and out of order, and the installation as GitHub has it
 * now is the one thing that is right whichever of them arrives last.
 */

/** All it takes to read an installation's account and repo list. */
const READ_REPOSITORIES = { metadata: "read" } as const;

/**
 * Bring an installation's workspace and repos in line with GitHub, and answer the workspace.
 *
 * - Gone from GitHub (uninstalled): the workspace keeps its row, members and designs, loses the
 *   installation, and its repos are marked removed. Answers null.
 * - Suspended: recorded on the workspace if Ponzu has one; GitHub mints a suspended
 *   installation no token, so its repos stay as last seen. Answers that workspace, or null
 *   when there is none: a suspension makes no new workspace.
 * - Otherwise the workspace is made or updated, every repo the installation can see is
 *   recorded, and any it no longer sees is marked removed (never deleted: designs point at it).
 *
 * `installedByUserId` is who installed it, for a webhook that says so; it fills in an unknown
 * installer and never replaces a known one. Safe to run any number of times, at once.
 */
export async function reconcileInstallation(
  { db, github }: Pick<Deps, "db" | "github">,
  installationId: number,
  { installedByUserId = null }: { installedByUserId?: string | null } = {},
): Promise<Workspace | null> {
  const installation = await github.getInstallation(installationId);
  if (!installation) {
    await markWorkspaceUninstalled(db, installationId);
    return null;
  }
  if (installation.suspendedAt) {
    return suspendWorkspace(db, { installationId, suspendedAt: installation.suspendedAt });
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
  });
  await upsertRepos(db, {
    workspaceId: workspace.id,
    repos: repositories.map((repository) => ({
      githubRepoId: repository.id,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      private: repository.private,
      pushedAt: repository.pushedAt,
    })),
  });
  await markReposRemovedExcept(db, {
    workspaceId: workspace.id,
    githubRepoIds: repositories.map((repository) => repository.id),
  });
  return workspace;
}
