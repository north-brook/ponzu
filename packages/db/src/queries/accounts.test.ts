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
  getRepoInstallationId,
  getUser,
  getUserByGithubId,
  getUserByWorkosId,
  getWorkspace,
  getWorkspaceByInstallation,
  listStaleInstallations,
  listUserWorkspaces,
  listWorkspaceRepos,
  markReposRemoved,
  markReposRemovedExcept,
  markWorkspaceUninstalled,
  suspendWorkspace,
  upsertMembership,
  upsertRepos,
  upsertUser,
  upsertWorkspace,
  wasUninstalled,
} from "./accounts.ts";
import { createDesign, getDesign, listWorkspaceDesigns } from "./designs.ts";
import { recordRepoAccess } from "./repo-access.ts";
import { setMemberRepos } from "./members.ts";

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

  test("an installer learned after the fact fills in, and never replaces, a known one", async () => {
    const [first, second] = await Promise.all([seedUser(db, "first"), seedUser(db, "second")]);
    const account = { ...installation, githubAccountId: 7003, installationId: 503 };
    await upsertWorkspace(db, account);

    const filled = await upsertWorkspace(db, { ...account, installedByUserId: first.id });
    const kept = await upsertWorkspace(db, { ...account, installedByUserId: second.id });

    expect(filled.installedByUserId).toBe(first.id);
    expect(kept.installedByUserId).toBe(first.id);
  });

  test("suspension is GitHub's to say when it is given, and left alone when it is not", async () => {
    const account = { ...installation, githubAccountId: 7004, installationId: 504 };
    const when = new Date("2026-11-09T10:00:00Z");

    const suspended = await upsertWorkspace(db, { ...account, suspendedAt: when });
    expect(suspended.suspendedAt).toEqual(when);
    expect((await upsertWorkspace(db, account)).suspendedAt).toEqual(when);
    expect((await upsertWorkspace(db, { ...account, suspendedAt: null })).suspendedAt).toBeNull();
  });

  test("suspendWorkspace touches only a workspace that holds the installation", async () => {
    const workspace = await seedWorkspace(db);
    const when = new Date("2026-11-09T11:00:00Z");

    const suspended = await suspendWorkspace(db, {
      installationId: workspace.installationId!,
      suspendedAt: when,
      reconciledAt: when,
    });

    expect(suspended).toMatchObject({ id: workspace.id, suspendedAt: when, reconciledAt: when });
    expect(
      await suspendWorkspace(db, {
        installationId: 404_404,
        suspendedAt: when,
        reconciledAt: when,
      }),
    ).toBeNull();
  });

  test("reconciledAt is kept until a read of GitHub says when it happened again", async () => {
    const account = { ...installation, githubAccountId: 7005, installationId: 505 };
    const first = new Date("2026-11-09T12:00:00Z");

    expect((await upsertWorkspace(db, account)).reconciledAt).toBeNull();
    expect((await upsertWorkspace(db, { ...account, reconciledAt: first })).reconciledAt).toEqual(
      first,
    );
    expect((await upsertWorkspace(db, account)).reconciledAt).toEqual(first);
  });

  test("listStaleInstallations finds the installations read longest ago, never-read first", async () => {
    const at = (iso: string) => new Date(iso);
    const make = (githubAccountId: number, reconciledAt?: Date) =>
      upsertWorkspace(db, {
        ...installation,
        githubAccountId,
        installationId: githubAccountId,
        reconciledAt,
      });
    await make(7301, at("2026-11-09T09:00:00Z"));
    await make(7302);
    await make(7303, at("2026-11-09T13:00:00Z"));
    await make(7304, at("2026-11-09T08:00:00Z"));
    const uninstalled = await make(7305, at("2026-11-01T00:00:00Z"));
    await markWorkspaceUninstalled(db, uninstalled.installationId!);

    const stale = await listStaleInstallations(db, {
      before: at("2026-11-09T12:00:00Z"),
      limit: 100,
    });

    const ours = stale.filter((id) => id >= 7301 && id <= 7305);
    expect(ours).toEqual([7302, 7304, 7301]);
    expect(
      await listStaleInstallations(db, { before: at("2026-11-09T12:00:00Z"), limit: 1 }),
    ).toHaveLength(1);
  });

  test("markWorkspaceUninstalled keeps the workspace and marks its repos removed", async () => {
    const workspace = await seedWorkspace(db);
    const [repo] = await upsertRepos(db, {
      workspaceId: workspace.id,
      repos: [
        {
          githubRepoId: 8801,
          fullName: "a/b",
          defaultBranch: "main",
          private: true,
          pushedAt: null,
        },
      ],
    });

    expect(await wasUninstalled(db, workspace.installationId!)).toBe(false);
    expect(await markWorkspaceUninstalled(db, workspace.installationId!)).toBe(workspace.id);

    expect(await wasUninstalled(db, workspace.installationId!)).toBe(true);
    expect(await getWorkspace(db, workspace.id)).toMatchObject({
      installationId: null,
      repositorySelection: null,
    });
    const [after] = await db.select().from(repos).where(eq(repos.id, repo!.id));
    expect(after!.removedAt).toBeInstanceOf(Date);
    // Again, or for an installation nobody holds: nothing to do.
    expect(await markWorkspaceUninstalled(db, workspace.installationId!)).toBeNull();
    expect(await getWorkspaceByInstallation(db, workspace.installationId!)).toBeNull();
    // One Ponzu never saw is remembered as gone all the same.
    expect(await markWorkspaceUninstalled(db, 404_405)).toBeNull();
    expect(await wasUninstalled(db, 404_405)).toBe(true);
  });
});

describe("people and workspaces by id", () => {
  test("getUser and getUserByGithubId find a person, and nobody else", async () => {
    const user = await seedUser(db, "lookup");
    expect(await getUser(db, user.id)).toEqual(user);
    expect(await getUserByGithubId(db, user.githubUserId)).toEqual(user);
    expect(await getUser(db, "usr_nobody")).toBeNull();
    expect(await getUserByGithubId(db, 404_404_404)).toBeNull();
  });

  test("getWorkspace names who installed the App; getWorkspaceByInstallation finds it", async () => {
    const installer = await seedUser(db, "installs");
    const workspace = await upsertWorkspace(db, {
      githubAccountId: 7101,
      githubLogin: "fablefuel",
      kind: "org",
      name: "Fablefuel",
      avatarUrl: null,
      installationId: 7102,
      repositorySelection: "all",
      installedByUserId: installer.id,
    });

    expect(await getWorkspace(db, workspace.id)).toMatchObject({
      id: workspace.id,
      installedByLogin: "installs",
    });
    expect((await getWorkspaceByInstallation(db, 7102))!.id).toBe(workspace.id);
    expect(await getWorkspace(db, "ws_nowhere")).toBeNull();
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

  test("an owner of the account is made an admin whatever their role was", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const key = { workspaceId: workspace.id, userId: user.id };
    const joined = await upsertMembership(db, { ...key, role: "member", githubAccess: "member" });
    expect(joined).toMatchObject({ role: "member", githubAccess: "member" });

    // GitHub now says they own the organization.
    const owner = await upsertMembership(db, { ...key, role: "member", githubAccess: "owner" });
    expect(owner).toMatchObject({ role: "admin", githubAccess: "owner" });

    // No longer an owner: what they reach changes, and the role stays as it is.
    const after = await upsertMembership(db, { ...key, role: "member", githubAccess: "member" });
    expect(after).toMatchObject({ role: "admin", githubAccess: "member" });
    // Without word of how they reach it, that is left as it was.
    const touched = await upsertMembership(db, { ...key, role: "member" });
    expect(touched).toMatchObject({ role: "admin", githubAccess: "member" });
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

    const dropped = await deleteMembershipsExcept(db, { userId: user.id, workspaceIds: [b.id] });
    expect(dropped.sort()).toEqual([a.id, c.id].sort());
    expect(await of(user.id)).toEqual([b.id]);
    expect(await of(other.id)).toEqual([a.id, b.id, c.id].sort());

    // Reaching nothing at all drops the rest.
    expect(await deleteMembershipsExcept(db, { userId: user.id, workspaceIds: [] })).toEqual([
      b.id,
    ]);
    expect(await of(user.id)).toEqual([]);
  });

  test("deleteMembershipsExcept never drops someone from their own account's workspace", async () => {
    const user = await seedUser(db, "solo");
    const own = await upsertWorkspace(db, {
      githubAccountId: user.githubUserId,
      githubLogin: "solo",
      kind: "personal",
      name: "solo",
      avatarUrl: null,
      installationId: 7401,
      repositorySelection: "all",
      installedByUserId: user.id,
    });
    const org = await seedWorkspace(db);
    await upsertMembership(db, { workspaceId: own.id, userId: user.id, role: "admin" });
    await upsertMembership(db, { workspaceId: org.id, userId: user.id, role: "member" });
    // The App was taken off their account.
    await markWorkspaceUninstalled(db, 7401);

    expect(await deleteMembershipsExcept(db, { userId: user.id, workspaceIds: [] })).toEqual([
      org.id,
    ]);
    expect((await listUserWorkspaces(db, user.id)).map((workspace) => workspace.id)).toEqual([
      own.id,
    ]);
  });

  test("listUserWorkspaces gives a person their workspaces and roles, and nobody else's", async () => {
    const [user, other] = await Promise.all([seedUser(db), seedUser(db, "maya")]);
    const [mine, theirs] = await Promise.all([seedWorkspace(db, "acme"), seedWorkspace(db)]);
    await upsertMembership(db, { workspaceId: mine.id, userId: user.id, role: "admin" });
    await upsertMembership(db, { workspaceId: theirs.id, userId: other.id, role: "member" });

    expect(await listUserWorkspaces(db, user.id)).toEqual([
      {
        id: mine.id,
        githubAccountId: mine.githubAccountId,
        githubLogin: "acme",
        kind: "org",
        name: "acme",
        avatarUrl: null,
        installationId: mine.installationId,
        suspendedAt: null,
        role: "admin",
        githubAccess: "collaborator",
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
    await recordRepoAccess(db, [
      { userId: user.id, repoId: repo!.id, permission: "write", checkedAt: new Date() },
    ]);

    await upsertRepos(db, { workspaceId: to.id, repos: [seen(211, "b/app")] });

    expect((await getDesign(db, inRepo.id))!.workspaceId).toBe(to.id);
    expect((await getDesign(db, scratch.id))!.workspaceId).toBe(from.id);
    const names = async (workspaceId: string) =>
      (await listWorkspaceDesigns(db, { workspaceId, userId: user.id })).map((d) => d.name);
    expect(await names(from.id)).toEqual(["Lisbon"]);
    expect(await names(to.id)).toEqual(["checkout"]);
  });

  test("markReposRemovedExcept marks what an installation's list left out, there only", async () => {
    const [workspace, other] = await Promise.all([seedWorkspace(db), seedWorkspace(db)]);
    await upsertRepos(db, {
      workspaceId: workspace.id,
      repos: [seen(401, "a/kept"), seen(402, "a/gone")],
    });
    await upsertRepos(db, { workspaceId: other.id, repos: [seen(403, "b/untouched")] });
    const names = async (workspaceId: string) =>
      (await db.select().from(repos).where(eq(repos.workspaceId, workspaceId)))
        .filter((repo) => repo.removedAt === null)
        .map((repo) => repo.fullName);

    expect(
      await markReposRemovedExcept(db, { workspaceId: workspace.id, githubRepoIds: [401] }),
    ).toBe(1);
    expect(await names(workspace.id)).toEqual(["a/kept"]);
    expect(await names(other.id)).toEqual(["b/untouched"]);

    // An installation with no repos left.
    expect(await markReposRemovedExcept(db, { workspaceId: workspace.id, githubRepoIds: [] })).toBe(
      1,
    );
    expect(await names(workspace.id)).toEqual([]);
  });

  test("listWorkspaceRepos gives a member the repos they reach, most recently pushed first", async () => {
    const [workspace, user, other] = await Promise.all([
      seedWorkspace(db),
      seedUser(db, "reader"),
      seedUser(db, "outsider"),
    ]);
    await upsertRepos(db, {
      workspaceId: workspace.id,
      repos: [
        { ...seen(501, "a/old"), pushedAt: new Date("2026-01-01T00:00:00Z") },
        { ...seen(502, "a/never"), pushedAt: null },
        { ...seen(503, "a/new"), pushedAt: new Date("2026-11-01T00:00:00Z") },
        seen(504, "a/hidden"),
        seen(505, "a/removed"),
      ],
    });
    await markReposRemoved(db, [505]);
    for (const person of [user, other]) {
      await upsertMembership(db, { workspaceId: workspace.id, userId: person.id, role: "member" });
    }
    await setMemberRepos(db, {
      workspaceId: workspace.id,
      userId: user.id,
      repos: [501, 502, 503, 505].map((githubRepoId) => ({
        githubRepoId,
        canPush: githubRepoId === 503,
      })),
      complete: true,
    });
    const list = (userId: string) => listWorkspaceRepos(db, { workspaceId: workspace.id, userId });

    expect((await list(user.id)).map(({ fullName, canPush }) => [fullName, canPush])).toEqual([
      ["a/new", true],
      ["a/old", false],
      ["a/never", false],
    ]);
    // In the workspace, and shown none of it.
    expect(await list(other.id)).toEqual([]);
  });

  test("getRepoInstallationId names the installation that holds a repo", async () => {
    const workspace = await seedWorkspace(db);
    await upsertRepos(db, { workspaceId: workspace.id, repos: [seen(601, "a/held")] });

    expect(await getRepoInstallationId(db, 601)).toBe(workspace.installationId);
    expect(await getRepoInstallationId(db, 602)).toBeNull();
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
