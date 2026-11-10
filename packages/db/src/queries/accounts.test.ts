import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { claudeAccounts, memberships, repos, users, workspaces } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import {
  deleteMembershipsExcept,
  type GithubInstallation,
  type GithubProfile,
  getClaudeAccount,
  getMemberWorkspace,
  getUserByWorkosId,
  listUserWorkspaces,
  markReposRemoved,
  upsertMembership,
  upsertRepos,
  upsertUser,
  upsertWorkspace,
} from "./accounts.ts";
import { createDesign, getDesign, listWorkspaceDesigns } from "./designs.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

describe("upsertUser", () => {
  const profile: GithubProfile = {
    workosUserId: "user_01ABC",
    githubUserId: 9001,
    githubLogin: "brycedbjork",
    name: "Bryce",
    email: "bryce@example.com",
    avatarUrl: "https://example.com/a.png",
  };

  test("makes a user on first sign-in and keeps their id on every one after", async () => {
    const first = await upsertUser(db, profile);
    expect(first.id).toMatch(/^usr_[0-9a-z]{16}$/);
    expect(first).toMatchObject(profile);

    // They renamed themselves on GitHub and dropped their public name.
    const second = await upsertUser(db, { ...profile, githubLogin: "bryce", name: null });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ githubLogin: "bryce", name: null, email: "bryce@example.com" });
    expect(second.createdAt).toEqual(first.createdAt);
  });

  test("a GitHub account that arrives under a new WorkOS id is the same person", async () => {
    const known = { ...profile, githubUserId: 9002, workosUserId: "user_01OLD" };
    const first = await upsertUser(db, known);
    await db.update(users).set({ defaultModel: "claude-opus" }).where(eq(users.id, first.id));

    // WorkOS deleted its user and made a new one for the same GitHub account.
    const second = await upsertUser(db, { ...known, workosUserId: "user_01NEW" });

    expect(second).toMatchObject({
      id: first.id,
      workosUserId: "user_01NEW",
      githubUserId: 9002,
      defaultModel: "claude-opus",
    });
    expect(await db.$count(users, eq(users.githubUserId, 9002))).toBe(1);
  });

  test("leaves what Ponzu keeps about the person alone", async () => {
    const user = await seedUser(db, "maya");
    expect(user).toMatchObject({ pingNeedsYou: true, emailDigest: false, defaultModel: null });
  });
});

describe("upsertWorkspace", () => {
  const installation: GithubInstallation = {
    githubAccountId: 7001,
    githubLogin: "north-brook",
    kind: "org",
    name: "North Brook",
    avatarUrl: null,
    installationId: 501,
    repositorySelection: "selected",
    installedByUserId: null,
  };

  test("is one workspace per GitHub account, brought up to date each time", async () => {
    const installer = await seedUser(db, "installer");
    const first = await upsertWorkspace(db, { ...installation, installedByUserId: installer.id });
    expect(first.id).toMatch(/^ws_/);
    expect(first).toMatchObject({ installationId: 501, installedByUserId: installer.id });
    expect(first.installedAt).toBeInstanceOf(Date);
    expect(first.monthlyCapCents).toBeNull();

    // A webhook for the same installation, which does not say who installed it.
    const second = await upsertWorkspace(db, {
      ...installation,
      name: "Northbrook",
      repositorySelection: "all",
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ name: "Northbrook", repositorySelection: "all" });
    expect(second.installedByUserId).toBe(installer.id);
    expect(second.installedAt).toEqual(first.installedAt);
  });

  test("a reinstall comes back to the same workspace, lifted out of suspension", async () => {
    const first = await upsertWorkspace(db, {
      ...installation,
      githubAccountId: 7002,
      installationId: 502,
    });
    await db
      .update(workspaces)
      .set({ suspendedAt: new Date(), installedAt: new Date(0) })
      .where(eq(workspaces.id, first.id));
    const reinstaller = await seedUser(db, "reinstaller");

    const second = await upsertWorkspace(db, {
      ...installation,
      githubAccountId: 7002,
      installationId: 777,
      installedByUserId: reinstaller.id,
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      installationId: 777,
      installedByUserId: reinstaller.id,
      suspendedAt: null,
    });
    expect(second.installedAt!.getTime()).toBeGreaterThan(0);
  });
});

describe("memberships", () => {
  test("a sync never changes a role an admin set", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const key = { workspaceId: workspace.id, userId: user.id };

    const first = await upsertMembership(db, { ...key, role: "member" });
    expect(first.role).toBe("member");
    await db
      .update(memberships)
      .set({ role: "admin", syncedAt: new Date(0) })
      .where(eq(memberships.userId, user.id));

    const synced = await upsertMembership(db, { ...key, role: "member" });

    expect(synced.role).toBe("admin");
    expect(synced.syncedAt.getTime()).toBeGreaterThan(0);
  });

  test("deleteMembershipsExcept drops the workspaces a person can no longer reach", async () => {
    const [user, other] = await Promise.all([seedUser(db), seedUser(db, "maya")]);
    const [a, b, c] = await Promise.all([seedWorkspace(db), seedWorkspace(db), seedWorkspace(db)]);
    for (const workspace of [a, b, c]) {
      await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role: "member" });
      await upsertMembership(db, { workspaceId: workspace.id, userId: other.id, role: "member" });
    }
    const of = async (userId: string) =>
      (await db.select().from(memberships).where(eq(memberships.userId, userId)))
        .map((row) => row.workspaceId)
        .sort();

    expect(await deleteMembershipsExcept(db, { userId: user.id, workspaceIds: [b.id] })).toBe(2);
    expect(await of(user.id)).toEqual([b.id]);
    expect(await of(other.id)).toEqual([a.id, b.id, c.id].sort());

    // Reaching nothing at all drops the rest.
    expect(await deleteMembershipsExcept(db, { userId: user.id, workspaceIds: [] })).toBe(1);
    expect(await of(user.id)).toEqual([]);
  });

  test("listUserWorkspaces gives a person their workspaces and roles, and nobody else's", async () => {
    const [user, other] = await Promise.all([seedUser(db), seedUser(db, "maya")]);
    const [mine, theirs] = await Promise.all([seedWorkspace(db, "acme"), seedWorkspace(db)]);
    await upsertMembership(db, { workspaceId: mine.id, userId: user.id, role: "admin" });
    await upsertMembership(db, { workspaceId: theirs.id, userId: other.id, role: "member" });

    expect(await listUserWorkspaces(db, user.id)).toEqual([
      {
        id: mine.id,
        githubLogin: "acme",
        kind: "org",
        name: "acme",
        avatarUrl: null,
        installationId: mine.installationId,
        suspendedAt: null,
        role: "admin",
      },
    ]);
    expect(await listUserWorkspaces(db, "usr_nobody")).toEqual([]);
  });

  test("getMemberWorkspace gives a member their workspace and role, and anyone else nothing", async () => {
    const [user, other] = await Promise.all([seedUser(db), seedUser(db, "ines")]);
    const [mine, theirs] = await Promise.all([seedWorkspace(db, "globex"), seedWorkspace(db)]);
    await upsertMembership(db, { workspaceId: mine.id, userId: user.id, role: "member" });
    await upsertMembership(db, { workspaceId: theirs.id, userId: other.id, role: "admin" });

    expect(await getMemberWorkspace(db, { userId: user.id, workspaceId: mine.id })).toMatchObject({
      id: mine.id,
      githubLogin: "globex",
      role: "member",
    });
    expect(await getMemberWorkspace(db, { userId: user.id, workspaceId: theirs.id })).toBeNull();
    expect(await getMemberWorkspace(db, { userId: user.id, workspaceId: "ws_nowhere" })).toBeNull();
  });
});

describe("what a signed-in request reads", () => {
  test("getUserByWorkosId finds the person whose sign-in came through a WorkOS user", async () => {
    const user = await seedUser(db);
    expect(await getUserByWorkosId(db, user.workosUserId)).toEqual(user);
    expect(await getUserByWorkosId(db, "user_nobody")).toBeNull();
  });

  test("getClaudeAccount never hands back the credential", async () => {
    const user = await seedUser(db);
    expect(await getClaudeAccount(db, user.id)).toBeNull();
    await db.insert(claudeAccounts).values({
      id: "cla_test",
      userId: user.id,
      kind: "subscription",
      encryptedCredential: "ciphertext",
      planLabel: "Claude Max",
    });

    const account = await getClaudeAccount(db, user.id);

    expect(account).toMatchObject({ kind: "subscription", status: "connected" });
    expect(JSON.stringify(account)).not.toContain("ciphertext");
  });
});

describe("repos", () => {
  const seen = (githubRepoId: number, fullName: string) => ({
    githubRepoId,
    fullName,
    defaultBranch: "main",
    private: true,
    pushedAt: new Date("2026-11-01T12:00:00Z"),
  });

  test("upsertRepos adds new repos and brings known ones up to date", async () => {
    const workspace = await seedWorkspace(db);
    const [fernwood] = await upsertRepos(db, {
      workspaceId: workspace.id,
      repos: [seen(101, "north-brook/fernwood")],
    });
    expect(fernwood).toMatchObject({ fullName: "north-brook/fernwood", baseStatus: "none" });
    expect(fernwood!.id).toMatch(/^repo_/);
    // What Ponzu learned about the repo must survive a sync.
    await db.update(repos).set({ baseSnapshot: "snap_1" }).where(eq(repos.id, fernwood!.id));

    const again = await upsertRepos(db, {
      workspaceId: workspace.id,
      repos: [
        { ...seen(101, "north-brook/fern"), defaultBranch: "trunk" },
        seen(102, "north-brook/lenny"),
      ],
    });

    expect(again).toHaveLength(2);
    const renamed = again.find((repo) => repo.githubRepoId === 101);
    expect(renamed).toMatchObject({
      id: fernwood!.id,
      fullName: "north-brook/fern",
      defaultBranch: "trunk",
      baseSnapshot: "snap_1",
    });
    expect(await upsertRepos(db, { workspaceId: workspace.id, repos: [] })).toEqual([]);
  });

  test("a repo transferred to another account moves workspace and keeps its row", async () => {
    const [from, to] = await Promise.all([seedWorkspace(db), seedWorkspace(db)]);
    const [before] = await upsertRepos(db, { workspaceId: from.id, repos: [seen(201, "a/site")] });

    const [after] = await upsertRepos(db, { workspaceId: to.id, repos: [seen(201, "b/site")] });

    expect(after).toMatchObject({ id: before!.id, workspaceId: to.id, fullName: "b/site" });
  });

  test("a transferred repo takes its designs to the new workspace, and leaves Scratch behind", async () => {
    const [from, to, user] = await Promise.all([
      seedWorkspace(db),
      seedWorkspace(db),
      seedUser(db),
    ]);
    const [repo] = await upsertRepos(db, { workspaceId: from.id, repos: [seen(211, "a/app")] });
    const make = (name: string, repoId: string | null) =>
      createDesign(db, {
        workspaceId: from.id,
        repoId,
        ownerId: user.id,
        claudeAccountId: null,
        name,
        branch: repoId && `pz/${name}`,
        doc: emptyDoc(name),
      });
    const inRepo = await make("checkout", repo!.id);
    const scratch = await make("Lisbon", null);

    await upsertRepos(db, { workspaceId: to.id, repos: [seen(211, "b/app")] });

    expect((await getDesign(db, inRepo.id))!.workspaceId).toBe(to.id);
    expect((await getDesign(db, scratch.id))!.workspaceId).toBe(from.id);
    const names = async (workspaceId: string) =>
      (await listWorkspaceDesigns(db, { workspaceId, userId: user.id })).map((d) => d.name);
    expect(await names(from.id)).toEqual(["Lisbon"]);
    expect(await names(to.id)).toEqual(["checkout"]);
  });

  test("markReposRemoved marks, and seeing the repo again clears it", async () => {
    const workspace = await seedWorkspace(db);
    await upsertRepos(db, {
      workspaceId: workspace.id,
      repos: [seen(301, "a/one"), seen(302, "a/two")],
    });

    expect(await markReposRemoved(db, [301, 999])).toBe(1);
    expect(await markReposRemoved(db, [301])).toBe(0);
    expect(await markReposRemoved(db, [])).toBe(0);
    const marked = await db.select().from(repos).where(eq(repos.workspaceId, workspace.id));
    expect(marked.find((repo) => repo.githubRepoId === 301)!.removedAt).toBeInstanceOf(Date);
    expect(marked.find((repo) => repo.githubRepoId === 302)!.removedAt).toBeNull();

    const [back] = await upsertRepos(db, {
      workspaceId: workspace.id,
      repos: [seen(301, "a/one")],
    });
    expect(back!.removedAt).toBeNull();
  });
});
