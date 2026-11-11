import {
  enqueueJob,
  type GithubAccess,
  type GithubPerson,
  getWorkspaceByInstallation,
  listPeopleRepoReads,
  type PeopleRepoRead,
  type RepoPermission,
  recordWorkspacePeople,
  type Workspace,
} from "@ponzu/db";
import { z } from "zod";
import type { GithubInstalledRepository, GithubUserInstallation, Listed } from "../deps/github.ts";
import type { Deps } from "../deps/index.ts";
import { UpstreamError } from "../http/errors.ts";
import { runHeldJob } from "../jobs/run.ts";
import { reconcileInstallation } from "./installations.ts";

/*
 * Who can reach a workspace, as GitHub says: everyone with access to at least one repo of its
 * installation, whether or not they have opened Ponzu. It is the team the "Where do you
 * design?" count, Settings › Members and Share show (docs/cloud.md, "Identity and access").
 * What a person may do in Ponzu is still their own sync's answer (`memberships`,
 * `repo_access`); this only says who is there, and grants nothing.
 *
 * Read as the App, once for the whole installation and never per person: each repo's people
 * (its collaborators, its organization's members through teams or the base permission, its
 * owners) a hundred at a time with their names, and an organization's members once for their
 * roles. That comes out of the installation's hourly budget, so it is a job of its own
 * (`PEOPLE_JOB`), never inline in a person's sync or a webhook's work:
 * - a reconcile that finds the last read older than `PEOPLE_AFTER_MS` records one, and runs it
 *   at once in the background when it can;
 * - a webhook that says membership changed records one for the end of its minute, so a burst
 *   of deliveries (a team added to a repo, an organization's base permission changed) is one
 *   read, which the cron makes.
 * A read that fails is tried again as a job, and holds up nothing else.
 *
 * Each read asks about at most `MAX_PEOPLE_REPOS` repos, those asked longest ago first, so a
 * bigger installation is read whole over a few reads. Each repo whose list came back whole
 * replaces what was known of it; one cut short only adds. Someone left reaching no repo is gone.
 */

type PeopleDeps = Pick<Deps, "db" | "clock" | "github" | "log" | "analytics">;
type RecordDeps = Pick<Deps, "db" | "clock" | "log">;

/** How old the last read of a workspace's people may be before a reconcile reads it again. */
export const PEOPLE_AFTER_MS = 60 * 60_000;
/** The most repos one read asks about, those asked longest ago first. */
export const MAX_PEOPLE_REPOS = 100;
/** How many repos are asked about at once. */
const AT_ONCE = 4;

/** The job that reads an installation's people. Its key is the installation id and a time. */
export const PEOPLE_JOB = "github.people";
/** Webhooks within one window share one read, at the window's end. */
export const PEOPLE_WINDOW_MS = 60_000;

const Payload = z.object({ installationId: z.number().int() });

/** Whether a workspace's people are due a read. */
export function peopleDue(workspace: Workspace, now: number): boolean {
  return (
    workspace.peopleSyncedAt === null || now - workspace.peopleSyncedAt.getTime() >= PEOPLE_AFTER_MS
  );
}

/** Runs a recorded read: the installation is read again with its people. */
export async function runPeopleJob(deps: PeopleDeps, payload: unknown): Promise<void> {
  const { installationId } = Payload.parse(payload);
  if (!(await getWorkspaceByInstallation(deps.db, installationId))) return;
  await reconcileInstallation(deps, installationId, { people: "read" });
}

/**
 * GitHub said who can reach an installation's repos changed: record a read of its people for
 * the end of this minute, for the cron to make, unless one is recorded for then already. Never
 * throws: the work that called it (taking someone's access away, say) must not wait on, or
 * fail with, a list that is only shown.
 */
export async function readPeopleSoon(
  deps: RecordDeps,
  installationId: number | undefined,
): Promise<void> {
  if (installationId === undefined) return;
  const at = (Math.floor(deps.clock.now() / PEOPLE_WINDOW_MS) + 1) * PEOPLE_WINDOW_MS;
  try {
    await enqueueJob(deps.db, {
      kind: PEOPLE_JOB,
      key: `${installationId}@${at}`,
      payload: { installationId },
      runAt: new Date(at),
    });
  } catch (error) {
    deps.log.warn("github_people_not_recorded", { installationId, error });
  }
}

/**
 * A workspace's people are due a read, found by a reconcile that has just read its installation
 * (`read`): record one now and, where there is a request to run it beside (`background`), make
 * it there from what the reconcile read, so a person's sync never waits for it and GitHub is not
 * asked for the installation twice; otherwise, or if it fails, the cron makes it. Never throws.
 */
export async function readPeopleNow(
  deps: PeopleDeps & Partial<Pick<Deps, "background">>,
  read: Parameters<typeof refreshWorkspacePeople>[1],
): Promise<void> {
  const installationId = read.installation.id;
  const now = deps.clock.now();
  const at = Math.floor(now / PEOPLE_WINDOW_MS) * PEOPLE_WINDOW_MS;
  const worker = `${PEOPLE_JOB}:${crypto.randomUUID()}`;
  const { background } = deps;
  try {
    const job = await enqueueJob(deps.db, {
      kind: PEOPLE_JOB,
      key: `${installationId}@due@${at}`,
      payload: { installationId },
      runAt: new Date(now),
      ...(background ? { lockedBy: worker } : {}),
    });
    if (job && background) {
      background(
        "github_people",
        runHeldJob(deps, job, worker, () => refreshWorkspacePeople(deps, read)),
      );
    }
  } catch (error) {
    deps.log.warn("github_people_not_recorded", { installationId, error });
  }
}

/**
 * Read who can reach an installation's repos and keep it for its workspace. `repositories` is
 * the installation's repo list as the reconcile that calls this just read it. Throws when
 * GitHub fails, for the job to try again.
 */
export async function refreshWorkspacePeople(
  { db, clock, github, log }: PeopleDeps,
  {
    workspace,
    installation,
    repositories,
  }: {
    workspace: Workspace;
    installation: GithubUserInstallation;
    repositories: Listed<GithubInstalledRepository>;
  },
): Promise<void> {
  const seenAt = new Date(clock.now());
  const { account } = installation;
  const org = account.type === "Organization";
  const [{ token, membersReadable }, reads] = await Promise.all([
    peopleToken(github, installation.id, org),
    listPeopleRepoReads(db, workspace.id),
  ]);

  // Never asked first, then those asked longest ago, then the most recently pushed.
  const askedAt = new Map(
    reads.map(({ githubRepoId, peopleReadAt }) => [githubRepoId, peopleReadAt?.getTime() ?? -1]),
  );
  const read = [...repositories.items]
    .sort(
      (a, b) =>
        (askedAt.get(a.id) ?? -1) - (askedAt.get(b.id) ?? -1) ||
        (b.pushedAt?.getTime() ?? 0) - (a.pushedAt?.getTime() ?? 0),
    )
    .slice(0, MAX_PEOPLE_REPOS);

  // The organization's members say only how each person reaches it (owner or member); who
  // is there at all comes from the repos' own lists, which include access through teams and
  // the base permission. Someone this cannot place keeps what was known of them.
  const roles = new Map<number, GithubAccess>();
  let rolesComplete = false;
  if (org && membersReadable) {
    const members = await github.listOrganizationPeople(token, account.login);
    rolesComplete = members?.complete === true;
    for (const member of members?.items ?? []) {
      roles.set(member.id, member.role === "admin" ? "owner" : "member");
    }
  }
  const accessOf = (id: number): GithubAccess | null => {
    if (!org) return id === account.id ? "owner" : "collaborator";
    return roles.get(id) ?? (rolesComplete ? "collaborator" : null);
  };

  const people = new Map<number, GithubPerson>();
  const found = (person: {
    id: number;
    login: string;
    name: string | null;
    avatarUrl: string | null;
  }) => {
    const known = people.get(person.id);
    if (known) return known;
    const made: GithubPerson = {
      githubUserId: person.id,
      githubLogin: person.login,
      name: person.name,
      avatarUrl: person.avatarUrl,
      githubAccess: accessOf(person.id),
      repoPermissions: {},
    };
    people.set(person.id, made);
    return made;
  };

  // A personal account's person owns every repo of it, whatever a list says.
  if (!org) {
    const owner = found({
      id: account.id,
      login: account.login,
      name: workspace.name === account.login ? null : workspace.name,
      avatarUrl: account.avatarUrl,
    });
    for (const repo of read) owner.repoPermissions[repo.id] = "admin";
  }

  const reposRead: PeopleRepoRead[] = [];
  for (let start = 0; start < read.length; start += AT_ONCE) {
    const batch = read.slice(start, start + AT_ONCE);
    const lists = await Promise.all(
      batch.map((repo) => github.listRepositoryPeople(token, repo.fullName)),
    );
    lists.forEach((listed, index) => {
      const repo = batch[index]!;
      // Null: gone between the two reads, or the token may not see it. Whoever only reached
      // it is not known to have lost access, so it is not counted read whole.
      reposRead.push({ githubRepoId: repo.id, complete: listed?.complete === true });
      for (const person of listed?.items ?? []) {
        if (person.permission === "none") continue;
        const entry = found(person);
        entry.repoPermissions[repo.id] = stronger(
          entry.repoPermissions[repo.id],
          person.permission,
        );
      }
    });
  }

  const complete =
    repositories.complete &&
    read.length === repositories.items.length &&
    reposRead.every((repo) => repo.complete);
  const kept = await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [...people.values()],
    reposRead,
    installedRepoIds: repositories.complete ? repositories.items.map((repo) => repo.id) : null,
    complete,
    seenAt,
  });
  const fields = {
    workspaceId: workspace.id,
    installationId: installation.id,
    people: people.size,
    repos: read.length,
    of: repositories.items.length,
    rolesComplete: !org || rolesComplete,
    complete,
    kept,
  };
  if (complete) log.info("github_people_read", fields);
  else log.warn("github_people_cut_short", fields);
}

/**
 * A token to read an installation's people: for an organization, with `members: read` so its
 * members' roles are seen; an installation whose owner has not accepted that permission gets
 * one without it, and the roles of people not seen before are not known.
 */
async function peopleToken(
  github: PeopleDeps["github"],
  installationId: number,
  org: boolean,
): Promise<{ token: string; membersReadable: boolean }> {
  if (org) {
    try {
      const { token } = await github.createInstallationToken({
        installationId,
        permissions: { metadata: "read", members: "read" },
      });
      return { token, membersReadable: true };
    } catch (error) {
      // 422: the installation has not been granted `members`.
      if (!(error instanceof UpstreamError && error.status === 422)) throw error;
    }
  }
  const { token } = await github.createInstallationToken({
    installationId,
    permissions: { metadata: "read" },
  });
  return { token, membersReadable: false };
}

const STRENGTH: RepoPermission[] = ["admin", "write", "read", "none"];

function stronger(
  kept: Exclude<RepoPermission, "none"> | undefined,
  found: Exclude<RepoPermission, "none">,
): Exclude<RepoPermission, "none"> {
  if (kept === undefined) return found;
  return STRENGTH.indexOf(found) < STRENGTH.indexOf(kept) ? found : kept;
}
