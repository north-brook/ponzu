import {
  forgetWorkspacePeople,
  getWorkspaceByInstallation,
  listStaleInstallations,
  markRepoAccessStale,
  markReposRemovedExcept,
  markWorkspaceUninstalled,
  suspendWorkspace,
  upsertRepos,
  upsertWorkspace,
  type Workspace,
  wasUninstalled,
} from "@ponzu/db";
import { type CaptureOptions, stableUuid } from "../analytics/analytics.ts";
import type { Deps } from "../deps/index.ts";
import { peopleDue, readPeopleNow, refreshWorkspacePeople } from "./people.ts";

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

/** `background`, where there is a request to run work beside: a due read of people runs there. */
type ReconcileDeps = Pick<Deps, "db" | "clock" | "github" | "log" | "analytics"> &
  Partial<Pick<Deps, "background">>;

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
 * Who can reach its repos (`github/people.ts`) is read with it when `people` is `read`: the
 * people job, which throws when GitHub fails, to be tried again. Otherwise, when the last read
 * is old, a read is recorded as that job and run beside, never here: a person's sync and a
 * webhook's work never wait on it nor fail with it. An uninstalled installation's people are
 * forgotten; a suspended one's stay as last seen.
 *
 * `installedByUserId` is who installed it, for a webhook that says so; it fills in an unknown
 * installer and never replaces a known one. Safe to run any number of times, at once.
 */
export async function reconcileInstallation(
  deps: ReconcileDeps,
  installationId: number,
  {
    installedByUserId = null,
    reposChanged = false,
    people = "when_due",
  }: {
    installedByUserId?: string | null;
    /** GitHub said the repos the installation reaches changed: said in analytics once read. */
    reposChanged?: boolean;
    /** `read`: read who can reach its repos here (the people job). */
    people?: "read" | "when_due";
  } = {},
): Promise<Workspace | null> {
  const { db, clock, github, log, analytics } = deps;
  const readAt = new Date(clock.now());
  const installation = await github.getInstallation(installationId);
  const before = await getWorkspaceByInstallation(db, installationId);
  // Whether anyone can reach its repos through Ponzu changed: every answer kept about them is
  // asked again before it is trusted (`repo_access`). Without the App or while it is suspended
  // the answer is `none`; once it is back, GitHub's.
  const reachChanged = async () => {
    if (before) await markRepoAccessStale(db, { workspaceId: before.id });
  };
  // This runs at once from a webhook and from the setup or the sweep, and each read `before`
  // for itself: what two of them could both see is said once, on the database's word or under
  // one id that both give it (PostHog keeps one event per id).
  const disconnected = (reason: "uninstalled" | "suspended", options: CaptureOptions = {}) => {
    if (before?.suspendedAt === null) {
      analytics.capture(
        "workspace disconnected",
        { workspace_id: before.id, reason },
        { distinctId: null, workspaceId: before.id, ...options },
      );
    }
  };
  if (!installation) {
    // Only the call that took the installation off the workspace says it went.
    const uninstalled = await markWorkspaceUninstalled(db, installationId);
    await reachChanged();
    if (before) await forgetWorkspacePeople(db, before.id);
    if (uninstalled) disconnected("uninstalled");
    return null;
  }
  if (installation.suspendedAt) {
    const suspended = await suspendWorkspace(db, {
      installationId,
      suspendedAt: installation.suspendedAt,
      reconciledAt: readAt,
    });
    if (before?.suspendedAt === null) await reachChanged();
    // GitHub's own time for the suspension, which every reader of it agrees on.
    disconnected("suspended", {
      timestamp: installation.suspendedAt,
      uuid: stableUuid(`${installationId}/suspended/${installation.suspendedAt.toISOString()}`),
    });
    return suspended;
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

  const { connected, ...workspace } = await upsertWorkspace(db, {
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
  if (before?.suspendedAt != null) await reachChanged();
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

  if (people === "read") {
    await refreshWorkspacePeople(deps, { workspace, installation, repositories });
  } else if (peopleDue(workspace, readAt.getTime())) {
    await readPeopleNow(deps, { workspace, installation, repositories });
  }

  // GitHub may have reported the installation gone while this was reading it, and that
  // uninstall would then be underneath what this just wrote. An installation id is never used
  // again, so it is applied again on top.
  if (await wasUninstalled(db, installationId)) {
    await markWorkspaceUninstalled(db, installationId);
    await forgetWorkspacePeople(db, workspace.id);
    return null;
  }
  const kind = workspace.kind === "org" ? "organization" : "user";
  analytics.group({
    workspaceId: workspace.id,
    name: account.login,
    kind,
    repos: repositories.items.length,
    repositorySelection: installation.repositorySelection,
  });
  // Connected: an account new to Ponzu, back after an uninstall, or out of a suspension, which
  // the database says to exactly one caller. It is about whoever installed it when Ponzu knows
  // them, and otherwise the person whose sign-in or setup found it (the request's scope).
  if (connected) {
    analytics.capture(
      "workspace connected",
      { workspace_id: workspace.id, kind, repos: repositories.items.length },
      {
        ...(workspace.installedByUserId ? { distinctId: workspace.installedByUserId } : {}),
        workspaceId: workspace.id,
      },
    );
  } else if (reposChanged) {
    analytics.capture(
      "repo access changed",
      { workspace_id: workspace.id, repos: repositories.items.length },
      { distinctId: null, workspaceId: workspace.id },
    );
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
