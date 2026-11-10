import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { githubUserToken } from "../github/user-token.ts";
import { createTestApp, type SignedInPerson, type TestApp } from "../testing/index.ts";

// The real GitHub client against the in-memory GitHub: what the next modules will call.

let t: TestApp;
let maya: SignedInPerson;
let token: string;
beforeAll(async () => {
  t = await createTestApp();
  maya = await t.signInAs({ login: "maya" });
  token = await githubUserToken(t.deps, maya.userId);
  t.github.installations.push(
    {
      id: 9001,
      account: { id: maya.github.id, login: "maya", type: "User" },
      repositorySelection: "all",
      repositories: [],
    },
    {
      id: 9002,
      account: { id: 77, login: "north-brook", type: "Organization" },
      repositorySelection: "selected",
      repositories: [
        { id: 1, fullName: "north-brook/fernwood", access: { [maya.github.id]: "write" } },
        {
          id: 2,
          fullName: "north-brook/site",
          private: false,
          defaultBranch: "trunk",
          access: { [maya.github.id]: "read" },
        },
        { id: 3, fullName: "north-brook/secret", access: { 4242: "write" } },
      ],
    },
    {
      id: 9003,
      account: { id: 78, login: "elsewhere", type: "Organization" },
      repositorySelection: "all",
      repositories: [{ id: 4, fullName: "elsewhere/thing", access: { 4242: "write" } }],
    },
  );
});
afterAll(() => t.close());

test("a person's installations are the ones they can reach, and no others", async () => {
  expect(await t.deps.github.listInstallations(token)).toEqual([
    {
      id: 9001,
      account: { id: maya.github.id, login: "maya", type: "User", avatarUrl: null },
      repositorySelection: "all",
      suspendedAt: null,
    },
    {
      id: 9002,
      account: { id: 77, login: "north-brook", type: "Organization", avatarUrl: null },
      repositorySelection: "selected",
      suspendedAt: null,
    },
  ]);
});

test("the repositories inside one are theirs to see, with whether they can push", async () => {
  expect(await t.deps.github.listInstallationRepositories(token, 9002)).toEqual([
    {
      id: 1,
      fullName: "north-brook/fernwood",
      defaultBranch: "main",
      private: true,
      pushedAt: null,
      canPush: true,
    },
    {
      id: 2,
      fullName: "north-brook/site",
      defaultBranch: "trunk",
      private: false,
      pushedAt: null,
      canPush: false,
    },
  ]);
});

test("a long list is read to its end, a page at a time", async () => {
  const big = {
    id: 9100,
    account: { id: 79, login: "monorepos", type: "Organization" as const },
    repositorySelection: "all" as const,
    repositories: Array.from({ length: 230 }, (_, index) => ({
      id: 1000 + index,
      fullName: `monorepos/r${index}`,
      access: { [maya.github.id]: "read" as const },
    })),
  };
  t.github.installations.push(big);

  const repositories = await t.deps.github.listInstallationRepositories(token, 9100);

  expect(repositories).toHaveLength(230);
  expect(new Set(repositories.map((repository) => repository.id)).size).toBe(230);
});

test("a user token GitHub refuses is github_reauth_required", async () => {
  await expect(t.deps.github.getUser("ghu_nobodyknowsthisone")).rejects.toMatchObject({
    status: 401,
    code: "github_reauth_required",
  });
});

test("the App gets an installation token by signing a JWT with its private key", async () => {
  const issued = await t.deps.github.createInstallationToken({
    installationId: 9002,
    repositoryIds: [1],
    permissions: { contents: "write", pull_requests: "write" },
  });

  expect(issued.token).toStartWith("ghs_");
  expect(issued.expiresAt.getTime()).toBe(t.clock.now() + 3600_000);
  // The fake checked the JWT's signature, issuer and expiry before answering.
  expect(t.github.installationTokenRequests.at(-1)).toEqual({
    installationId: 9002,
    body: { repository_ids: [1], permissions: { contents: "write", pull_requests: "write" } },
  });
});

test("an installation that is gone is an upstream failure, not a token", async () => {
  await expect(t.deps.github.createInstallationToken({ installationId: 1 })).rejects.toThrow(
    /answered 404/,
  );
});

describe("a person's permission in a repository", () => {
  const fernwood = { id: 1, fullName: "north-brook/fernwood" };
  const ask = (
    repository: { id: number; fullName: string },
    user = { id: maya.github.id, login: "maya" },
    installationId = 9002,
  ) => t.deps.github.getRepoPermission({ installationId, repository, user });

  test("is asked as the App, with a token for that one repository and metadata only", async () => {
    const before = t.github.installationTokenRequests.length;

    expect(await ask(fernwood)).toBe("write");
    expect(await ask({ id: 2, fullName: "north-brook/site" })).toBe("read");
    expect(await ask({ id: 3, fullName: "north-brook/secret" })).toBe("none");

    expect(t.github.installationTokenRequests.slice(before).map(({ body }) => body)).toEqual([
      { repository_ids: [1], permissions: { metadata: "read" } },
      { repository_ids: [2], permissions: { metadata: "read" } },
      { repository_ids: [3], permissions: { metadata: "read" } },
    ]);
  });

  test("asks every time, but questions about one person and repository at once share an answer", async () => {
    const asked = () => t.github.permissionRequests.filter((line) => line.endsWith(" maya")).length;
    const before = asked();

    const answers = await Promise.all([ask(fernwood), ask(fernwood), ask(fernwood)]);
    expect(answers).toEqual(["write", "write", "write"]);
    expect(asked()).toBe(before + 1);

    expect(await ask(fernwood)).toBe("write");
    expect(asked()).toBe(before + 2);
  });

  test("reuses its token for most of the hour, and mints again when GitHub stops taking it early", async () => {
    await ask(fernwood);
    const minted = t.github.installationTokenRequests.length;
    expect(await ask(fernwood)).toBe("write");
    expect(t.github.installationTokenRequests.length).toBe(minted);

    // Suspended and back, or its permissions changed: the token says 401 before it runs out.
    t.github.revokeInstallationTokens();
    expect(await ask(fernwood)).toBe("write");
    expect(t.github.installationTokenRequests.length).toBe(minted + 1);
  });

  test("takes an answer only about the person's own account, whatever login now belongs to whom", async () => {
    const repository = t.github.installations[1]!.repositories[0]!;
    const renamed = t.github.addUser({
      id: 5150,
      login: "kit-new",
      name: null,
      avatarUrl: null,
      emails: [],
    });
    repository.access[renamed.id] = "read";
    // Kit last signed in as `kit` and has renamed since; nobody has taken `kit` yet.
    const kit = { id: renamed.id, login: "kit" };
    expect(await ask(fernwood, kit)).toBe("read");

    // Now someone else has the old login, and write access.
    const squatter = t.github.addUser({
      id: 5151,
      login: "kit",
      name: null,
      avatarUrl: null,
      emails: [],
    });
    repository.access[squatter.id] = "write";
    expect(await ask(fernwood, kit)).toBe("read");

    // An account that is gone has no access, whoever holds its old login.
    expect(await ask(fernwood, { id: 5152, login: "kit" })).toBe("none");
    delete repository.access[renamed.id];
    delete repository.access[squatter.id];
  });

  test("is none for a login GitHub does not know, a repository or installation the App has lost", async () => {
    expect(await ask(fernwood, { id: 9999, login: "renamed-since" })).toBe("none");
    expect(await ask({ id: 4, fullName: "elsewhere/thing" })).toBe("none");
    const uninstalled = { id: 5, fullName: "gone/thing" };
    expect(await ask(uninstalled, { id: maya.github.id, login: "maya" }, 12345)).toBe("none");
  });

  test("GitHub failing is an upstream failure, not an answer", async () => {
    t.github.failNext("/repos/north-brook/site/collaborators/maya/permission", 502);
    const site = { id: 2, fullName: "north-brook/site" };
    t.clock.advance(60_000);

    await expect(ask(site)).rejects.toThrow(/answered 502/);
    expect(await ask(site)).toBe("read");
  });
});
