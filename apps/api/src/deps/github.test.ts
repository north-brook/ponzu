import { afterAll, beforeAll, expect, test } from "bun:test";
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
  expect(await t.deps.github.listInstallations(token)).toEqual({
    items: [
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
    ],
    complete: true,
  });
});

test("the repositories inside one are theirs to see, with whether they can push", async () => {
  expect(await t.deps.github.listInstallationRepositories(token, 9002)).toEqual({
    items: [
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
    ],
    complete: true,
  });
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

  expect(repositories.complete).toBe(true);
  expect(repositories.items).toHaveLength(230);
  expect(new Set(repositories.items.map((repository) => repository.id)).size).toBe(230);
});

test("a list longer than twenty pages says it was cut short", async () => {
  const sizes = [2_000, 2_001];
  for (const size of sizes) {
    t.github.installations.push({
      id: 9200 + size,
      account: { id: 80 + size, login: `huge${size}`, type: "Organization" },
      repositorySelection: "all",
      repositories: Array.from({ length: size }, (_, index) => ({
        id: 100_000 * size + index,
        fullName: `huge${size}/r${index}`,
        access: { [maya.github.id]: "read" as const },
      })),
    });
  }

  const exact = await t.deps.github.listInstallationRepositories(token, 11_200);
  const over = await t.deps.github.listInstallationRepositories(token, 11_201);

  // Exactly as many as are read is all of them: GitHub's total says so.
  expect(exact).toMatchObject({ complete: true });
  expect(exact.items).toHaveLength(2_000);
  expect(over).toMatchObject({ complete: false });
  expect(over.items).toHaveLength(2_000);
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
