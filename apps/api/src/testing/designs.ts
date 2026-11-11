import type { Doc } from "@ponzu/core";
import {
  createDesign,
  createRunnerToken,
  upsertMembership,
  upsertRepos,
  upsertWorkspace,
} from "@ponzu/db";
import { RUNNER_HEADER, type RunnerSession } from "@ponzu/runner/protocol";
import type { FakeInstallation, FakeRepository } from "./fake-github.ts";
import type { SignedInPerson, TestApp } from "./index.ts";

/*
 * Designs to test with: a workspace with the App installed and one repository, people whose
 * access to it GitHub decides, and short ways to call the API as them.
 */

// GitHub ids must be unique within one test database.
let nextGithubId = 70_001;

export type Access = "admin" | "write" | "read" | "none";

export interface Workspace {
  id: string;
  installationId: number;
  repo: { id: string; githubRepoId: number; fullName: string };
  /** Everyone named, signed in and a member, by login. */
  people: Record<string, SignedInPerson>;
  /** Change what GitHub says a person may do in the repository. */
  grant(login: string, access: Exclude<Access, "admin">): void;
  /** The installation and repository as the fake GitHub holds them, to change behind Ponzu's back. */
  github: { installation: FakeInstallation; repository: FakeRepository };
}

/**
 * A workspace whose repository each named person can reach as given, every one of them a
 * member. An `admin` is an admin of the workspace who can write to the repository.
 */
export async function workspaceWithRepo(
  t: TestApp,
  access: Record<string, Access>,
  { private: isPrivate = true }: { private?: boolean } = {},
): Promise<Workspace> {
  const accountId = nextGithubId++;
  const installationId = nextGithubId++;
  const githubRepoId = nextGithubId++;
  const login = `org-${accountId}`;
  const fullName = `${login}/fernwood`;
  const workspace = await upsertWorkspace(t.db, {
    githubAccountId: accountId,
    githubLogin: login,
    kind: "org",
    name: login,
    avatarUrl: null,
    installationId,
    repositorySelection: "selected",
    installedByUserId: null,
  });
  const [repo] = await upsertRepos(t.db, {
    workspaceId: workspace.id,
    repos: [{ githubRepoId, fullName, defaultBranch: "main", private: isPrivate, pushedAt: null }],
  });
  const repository: FakeRepository = { id: githubRepoId, fullName, private: isPrivate, access: {} };
  const installation: FakeInstallation = {
    id: installationId,
    account: { id: accountId, login, type: "Organization" },
    repositorySelection: "selected",
    repositories: [repository],
  };
  t.github.installations.push(installation);

  const people: Record<string, SignedInPerson> = {};
  const grant = (who: string, level: Exclude<Access, "admin">) => {
    const id = people[who]!.github.id;
    if (level === "none") delete repository.access[id];
    else repository.access[id] = level;
  };
  for (const [who, level] of Object.entries(access)) {
    people[who] = await t.signInAs({ login: who });
    await upsertMembership(t.db, {
      workspaceId: workspace.id,
      userId: people[who].userId,
      role: level === "admin" ? "admin" : "member",
    });
    grant(who, level === "admin" ? "write" : level);
  }
  return {
    id: workspace.id,
    installationId,
    repo: { id: repo!.id, githubRepoId, fullName },
    people,
    grant,
    github: { installation, repository },
  };
}

/** A design in the workspace's repository, owned by `owner`, starting as `doc`. */
export async function designIn(
  t: TestApp,
  workspace: Workspace,
  owner: string,
  doc: Doc,
  repo: "repo" | "scratch" = "repo",
) {
  return createDesign(t.db, {
    workspaceId: workspace.id,
    repoId: repo === "repo" ? workspace.repo.id : null,
    ownerId: workspace.people[owner]!.userId,
    claudeAccountId: null,
    name: doc.name,
    branch: null,
    doc,
  });
}

/** A design's runner as it is once started: its token, and the session that gave it the lease. */
export interface StartedRunner {
  token: string;
  session: RunnerSession;
  /** What it sends on every later call: the token, and the lease as `X-Ponzu-Runner`. */
  headers: { authorization: string; [RUNNER_HEADER]: string };
}

/**
 * A runner token for the design and a session through the real `POST /v1/runner/session`, so
 * the runner holds the design's lease. Starting another for the same design supersedes this
 * one, as in a sandbox.
 */
export async function startRunner(t: TestApp, designId: string): Promise<StartedRunner> {
  const { token } = await createRunnerToken(t.db, { designId, ttlSeconds: 3600 });
  const started = await call(
    t,
    { authorization: `Bearer ${token}` },
    "POST",
    "/v1/runner/session",
    {},
  );
  if (started.status !== 200) {
    throw new Error(
      `startRunner: the session answered ${started.status} ${JSON.stringify(started.body)}`,
    );
  }
  const session = started.body as RunnerSession;
  return {
    token,
    session,
    headers: { authorization: `Bearer ${token}`, [RUNNER_HEADER]: session.runnerId },
  };
}

/** The headers a design's runner sends, from a runner just started for it. */
export async function runnerHeaders(t: TestApp, designId: string) {
  return (await startRunner(t, designId)).headers;
}

/** A design in the workspace's repository, as `designIn` makes it, with its runner started. */
export async function designWithRunner(
  t: TestApp,
  workspace: Workspace,
  owner: string,
  doc: Doc,
  repo: "repo" | "scratch" = "repo",
) {
  const design = await designIn(t, workspace, owner, doc, repo);
  return { design, runner: await startRunner(t, design.id) };
}

/** Calls the API and reads the answer, whatever it was. */
export async function call(
  t: TestApp,
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await t.app.request(path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
