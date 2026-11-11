import {
  type GithubAccess,
  type GithubPerson,
  type RepoPermission,
  recordWorkspacePeople,
  type Workspace,
} from "@ponzu/db";
import type { GithubInstalledRepository, GithubUserInstallation, Listed } from "../deps/github.ts";
import type { Deps } from "../deps/index.ts";
import { UpstreamError } from "../http/errors.ts";

/*
 * Who can reach a workspace, as GitHub says: everyone with access to at least one repo of its
 * installation, whether or not they have opened Ponzu. It is the team the "Where do you
 * design?" count, Settings › Members and Share show (docs/cloud.md, "Identity and access").
 * What a person may do in Ponzu is still their own sync's answer (`memberships`,
 * `repo_access`); this only says who is there.
 *
 * Read as the App, once for the whole installation and never per person: each repo's people
 * (its collaborators, its organization's members through teams or the base permission, its
 * owners) a hundred at a time with their names, and an organization's members once for their
 * roles. That comes out of the installation's hourly budget, so it is read when an
 * installation is reconciled and the last read is older than `PEOPLE_AFTER_MS`, or when a
 * webhook says membership changed; and at most `MAX_PEOPLE_REPOS` repos are read each time.
 * A read cut short anywhere only adds people: nobody it missed is taken to have lost access.
 */

type PeopleDeps = Pick<Deps, "db" | "clock" | "github" | "log">;

/** How old the last read of a workspace's people may be before a reconcile reads it again. */
export const PEOPLE_AFTER_MS = 60 * 60_000;
/** The most repos one read asks about, most recently pushed first. */
export const MAX_PEOPLE_REPOS = 100;
/** How many repos are asked about at once. */
const AT_ONCE = 4;

/** Whether a workspace's people are due a read. */
export function peopleDue(workspace: Workspace, now: number): boolean {
  return (
    workspace.peopleSyncedAt === null || now - workspace.peopleSyncedAt.getTime() >= PEOPLE_AFTER_MS
  );
}

/**
 * Read who can reach an installation's repos and keep it for its workspace. `repositories` is
 * the installation's repo list as the reconcile that calls this just read it.
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
  const { token, membersReadable } = await peopleToken(github, installation.id, org);

  const read = [...repositories.items]
    .sort((a, b) => (b.pushedAt?.getTime() ?? 0) - (a.pushedAt?.getTime() ?? 0))
    .slice(0, MAX_PEOPLE_REPOS);
  let complete = repositories.complete && read.length === repositories.items.length;

  const roles = new Map<number, GithubAccess>();
  let rolesComplete = false;
  if (org && membersReadable) {
    const members = await github.listOrganizationPeople(token, account.login);
    rolesComplete = members?.complete === true;
    for (const member of members?.items ?? []) {
      roles.set(member.id, member.role === "admin" ? "owner" : "member");
    }
  }
  // Without its members, an organization's people may be missing someone.
  if (org && !rolesComplete) complete = false;

  const people = new Map<number, GithubPerson>();
  const found = (
    person: { id: number; login: string; name: string | null; avatarUrl: string | null },
    githubAccess: GithubAccess,
  ) => {
    const known = people.get(person.id);
    if (known) return known;
    const made: GithubPerson = {
      githubUserId: person.id,
      githubLogin: person.login,
      name: person.name,
      avatarUrl: person.avatarUrl,
      githubAccess,
      repoPermissions: {},
    };
    people.set(person.id, made);
    return made;
  };

  // A personal account's person owns every repo of it, whatever a list says.
  if (!org) {
    const owner = found(
      {
        id: account.id,
        login: account.login,
        name: workspace.name === account.login ? null : workspace.name,
        avatarUrl: account.avatarUrl,
      },
      "owner",
    );
    for (const repo of read) owner.repoPermissions[repo.id] = "admin";
  }

  const accessOf = (id: number): GithubAccess =>
    !org ? "collaborator" : (roles.get(id) ?? (rolesComplete ? "collaborator" : "member"));
  for (let start = 0; start < read.length; start += AT_ONCE) {
    const batch = read.slice(start, start + AT_ONCE);
    const lists = await Promise.all(
      batch.map((repo) => github.listRepositoryPeople(token, repo.fullName)),
    );
    lists.forEach((listed, index) => {
      const repo = batch[index]!;
      // Gone between the two reads, or the token may not see it: whoever only reached it is
      // not known to have lost access.
      if (!listed || !listed.complete) complete = false;
      for (const person of listed?.items ?? []) {
        if (person.permission === "none") continue;
        const entry = found(person, accessOf(person.id));
        entry.repoPermissions[repo.id] = stronger(
          entry.repoPermissions[repo.id],
          person.permission,
        );
      }
    });
  }

  const kept = await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [...people.values()],
    complete,
    seenAt,
  });
  const fields = {
    workspaceId: workspace.id,
    installationId: installation.id,
    people: people.size,
    repos: read.length,
    complete,
    kept,
  };
  if (complete) log.info("github_people_read", fields);
  else log.warn("github_people_cut_short", fields);
}

/**
 * A token to read an installation's people: for an organization, with `members: read` so its
 * members and their teams' access are seen; an installation whose owner has not accepted that
 * permission gets one without it, and its read is cut short.
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
