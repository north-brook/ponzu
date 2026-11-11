// Rows for this package's tests to hang things on. Not exported from the package.
import { emptyDoc } from "@ponzu/core";
import type { Db } from "./client.ts";
import { upsertRepos, upsertUser, upsertWorkspace } from "./queries/accounts.ts";
import { createDesign } from "./queries/designs.ts";
import type { Actor, NewOp } from "./queries/ops.ts";

// GitHub ids must be unique; tests in one database take the next.
let nextGithubId = 1;

export async function seedUser(db: Db, login = "bryce") {
  const githubUserId = nextGithubId++;
  const { created: _created, ...user } = await upsertUser(db, {
    workosUserId: `user_${githubUserId}`,
    githubUserId,
    githubLogin: login,
    name: login,
    email: `${login}@example.com`,
    avatarUrl: null,
  });
  return user;
}

export function seedWorkspace(db: Db, login = "north-brook") {
  const githubAccountId = nextGithubId++;
  return upsertWorkspace(db, {
    githubAccountId,
    githubLogin: login,
    kind: "org",
    name: login,
    avatarUrl: null,
    installationId: githubAccountId,
    repositorySelection: "all",
    installedByUserId: null,
  });
}

export async function seedRepo(db: Db, workspaceId: string, fullName = "north-brook/fernwood") {
  const [repo] = await upsertRepos(db, {
    workspaceId,
    repos: [
      {
        githubRepoId: nextGithubId++,
        fullName,
        defaultBranch: "main",
        private: true,
        pushedAt: null,
      },
    ],
  });
  return repo!;
}

/** A person, a workspace and a Scratch design of theirs in it. */
export async function seedDesign(db: Db) {
  const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
  const design = await createDesign(db, {
    workspaceId: workspace.id,
    repoId: null,
    ownerId: user.id,
    claudeAccountId: null,
    name: "Lisbon",
    branch: null,
    doc: emptyDoc("Lisbon"),
  });
  return { user, workspace, design };
}

export const actorFor = (user: { id: string; name: string | null }): Actor => ({
  kind: "user",
  id: user.id,
  name: user.name ?? "Someone",
});

export const agent: Actor = { kind: "agent", id: "agent", name: "Ponzu" };

/** A rename: the smallest op there is, and its inverse. */
export const rename = (id: string, name: string, was = "Lisbon"): NewOp => ({
  id,
  op: { op: "file.rename", name },
  inverse: { op: "file.rename", name: was },
});
