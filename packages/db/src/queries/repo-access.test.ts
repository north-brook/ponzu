import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { repoAccess } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { markReposRemoved, upsertRepos } from "./accounts.ts";
import { createDesign } from "./designs.ts";
import {
  getRepoAccess,
  listWorkspaceRepoAccess,
  markRepoAccessStale,
  recordNoRepoAccess,
  recordReachableRepos,
  recordRepoAccess,
} from "./repo-access.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const at = (time: string) => new Date(`2026-11-10T${time}Z`);

describe("recordRepoAccess", () => {
  test("keeps the newest answer per person and repo, whatever order they arrive in", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id, "north-brook/kept");
    const answer = (permission: "read" | "none", time: string) => ({
      userId: user.id,
      repoId: repo.id,
      permission,
      checkedAt: at(time),
    });

    await recordRepoAccess(db, [answer("read", "12:00:00")]);
    await recordRepoAccess(db, [answer("none", "12:01:00")]);
    // A slow request that asked before access was taken away.
    await recordRepoAccess(db, [answer("read", "12:00:30")]);
    await recordRepoAccess(db, []);

    expect(await db.select().from(repoAccess)).toContainEqual(answer("none", "12:01:00"));
  });
});

describe("listWorkspaceRepoAccess", () => {
  test("lists every repo of the workspace, with what one person may do in each", async () => {
    const [user, teammate, workspace, elsewhere] = await Promise.all([
      seedUser(db, "ines"),
      seedUser(db, "omar"),
      seedWorkspace(db, "acme"),
      seedWorkspace(db, "other"),
    ]);
    const [withDesign, asked, empty, foreign] = await Promise.all([
      seedRepo(db, workspace.id, "acme/site"),
      seedRepo(db, workspace.id, "acme/app"),
      seedRepo(db, workspace.id, "acme/empty"),
      seedRepo(db, elsewhere.id, "other/site"),
    ]);
    for (const repo of [withDesign, asked, foreign]) {
      await createDesign(db, {
        workspaceId: repo.workspaceId,
        repoId: repo.id,
        ownerId: user.id,
        claudeAccountId: null,
        name: repo.fullName,
        branch: null,
        doc: emptyDoc(repo.fullName),
      });
    }
    await recordRepoAccess(db, [
      { userId: user.id, repoId: asked.id, permission: "write", checkedAt: at("12:00:00") },
      { userId: teammate.id, repoId: withDesign.id, permission: "read", checkedAt: at("12:00:00") },
      { userId: user.id, repoId: empty.id, permission: "read", checkedAt: at("12:00:00") },
    ]);

    await markReposRemoved(db, [asked.githubRepoId]);

    const listed = await listWorkspaceRepoAccess(db, {
      workspaceId: workspace.id,
      userId: user.id,
    });

    // Seeded in this order, so their GitHub ids are too. A removed repo is listed too.
    expect(listed.sort((a, b) => a.githubRepoId - b.githubRepoId)).toEqual([
      {
        repoId: withDesign.id,
        githubRepoId: withDesign.githubRepoId,
        fullName: "acme/site",
        hasDesign: true,
        permission: null,
        checkedAt: null,
      },
      {
        repoId: asked.id,
        githubRepoId: asked.githubRepoId,
        fullName: "acme/app",
        hasDesign: true,
        permission: "write",
        checkedAt: at("12:00:00"),
      },
      {
        repoId: empty.id,
        githubRepoId: empty.githubRepoId,
        fullName: "acme/empty",
        hasDesign: false,
        permission: "read",
        checkedAt: at("12:00:00"),
      },
    ]);
  });
});

describe("recordNoRepoAccess", () => {
  test("records none for every repo of the workspace, and replaces nothing newer", async () => {
    const [user, workspace, elsewhere] = await Promise.all([
      seedUser(db),
      seedWorkspace(db),
      seedWorkspace(db),
    ]);
    const [site, app, foreign] = await Promise.all([
      seedRepo(db, workspace.id, "nobody/site"),
      seedRepo(db, workspace.id, "nobody/app"),
      seedRepo(db, elsewhere.id, "nobody/foreign"),
    ]);
    await recordRepoAccess(db, [
      { userId: user.id, repoId: site.id, permission: "write", checkedAt: at("12:00:00") },
      { userId: user.id, repoId: app.id, permission: "write", checkedAt: at("12:10:00") },
      { userId: user.id, repoId: foreign.id, permission: "write", checkedAt: at("12:00:00") },
    ]);

    await recordNoRepoAccess(db, {
      workspaceId: workspace.id,
      userId: user.id,
      checkedAt: at("12:05:00"),
    });

    const of = (repoId: string) => getRepoAccess(db, { userId: user.id, repoId });
    expect(await of(site.id)).toEqual({ permission: "none", checkedAt: at("12:05:00") });
    expect(await of(app.id)).toEqual({ permission: "write", checkedAt: at("12:10:00") });
    expect(await of(foreign.id)).toEqual({ permission: "write", checkedAt: at("12:00:00") });
  });
});

let nextBase = 9_000;

describe("recordReachableRepos", () => {
  async function reacher({ publicRepo }: { publicRepo?: number } = {}) {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    nextBase += 1_000;
    const base = nextBase;
    const repo = (n: number) => ({
      githubRepoId: base + n,
      fullName: `a/${base + n}`,
      defaultBranch: "main",
      private: n !== publicRepo,
      pushedAt: null,
    });
    const rows = await upsertRepos(db, {
      workspaceId: workspace.id,
      repos: [repo(1), repo(2), repo(3)],
    });
    const idOf = (n: number) => rows.find((row) => row.githubRepoId === base + n)!.id;
    const record = (
      listed: [number, "write" | "read"][],
      { complete = true, time = "12:00:00" }: { complete?: boolean; time?: string } = {},
    ) =>
      recordReachableRepos(db, {
        workspaceId: workspace.id,
        userId: user.id,
        repos: listed.map(([n, permission]) => ({ githubRepoId: base + n, permission })),
        complete,
        checkedAt: at(time),
      });
    const held = async () =>
      Object.fromEntries(
        (await db.select().from(repoAccess).where(eq(repoAccess.userId, user.id))).map((row) => [
          row.repoId,
          row.permission,
        ]),
      );
    return { user, workspace, base, idOf, record, held };
  }

  test("records what a person reaches, and every other repo of the workspace as none", async () => {
    const { base, idOf, record, held } = await reacher();

    // Not a repo of this workspace (yet): it is reported, not recorded.
    expect(
      await record([
        [1, "read"],
        [2, "write"],
        [999, "write"],
      ]),
    ).toEqual({ missing: [base + 999] });
    expect(await held()).toEqual({ [idOf(1)]: "read", [idOf(2)]: "write", [idOf(3)]: "none" });

    // A whole list is the truth, and an empty one leaves them nothing.
    await record([[3, "read"]], { time: "12:01:00" });
    expect(await held()).toEqual({ [idOf(1)]: "none", [idOf(2)]: "none", [idOf(3)]: "read" });
    await record([], { time: "12:02:00" });
    expect(await held()).toEqual({ [idOf(1)]: "none", [idOf(2)]: "none", [idOf(3)]: "none" });
  });

  test("a public repo it leaves out is one they can read, as GitHub says of anyone", async () => {
    const { idOf, record, held } = await reacher({ publicRepo: 3 });

    await record([[1, "write"]]);
    expect(await held()).toEqual({ [idOf(1)]: "write", [idOf(2)]: "none", [idOf(3)]: "read" });
    await record([[3, "write"]], { time: "12:01:00" });
    expect(await held()).toEqual({ [idOf(1)]: "none", [idOf(2)]: "none", [idOf(3)]: "write" });
  });

  test("a list cut short only adds, and nothing replaces a newer answer", async () => {
    const { user, idOf, record, held } = await reacher();
    await record([[1, "read"]], { time: "12:00:00" });

    await record([[2, "write"]], { complete: false, time: "12:01:00" });
    expect(await held()).toEqual({ [idOf(1)]: "read", [idOf(2)]: "write", [idOf(3)]: "none" });

    // The App said none at 12:05; a sync that asked at 12:04 does not bring access back.
    await recordRepoAccess(db, [
      { userId: user.id, repoId: idOf(2), permission: "none", checkedAt: at("12:05:00") },
    ]);
    await record([[2, "write"]], { time: "12:04:00" });
    expect((await held())[idOf(2)]).toBe("none");
  });

  test("a repo listed twice is recorded once, and a removed one is still recorded", async () => {
    const { base, idOf, record, held } = await reacher();
    await markReposRemoved(db, [base + 2]);

    await record([
      [2, "write"],
      [2, "write"],
    ]);

    expect((await held())[idOf(2)]).toBe("write");
  });
});

describe("upsertRepos", () => {
  test("a repo that moves account or changes visibility has its answers asked again", async () => {
    const [user, from, to] = await Promise.all([
      seedUser(db),
      seedWorkspace(db),
      seedWorkspace(db),
    ]);
    const [moving, turning, staying] = await Promise.all([
      seedRepo(db, from.id, "moves/repo"),
      seedRepo(db, from.id, "turns/repo"),
      seedRepo(db, from.id, "stays/repo"),
    ]);
    const checkedAt = at("12:00:00");
    await recordRepoAccess(
      db,
      [moving, turning, staying].map((repo) => ({
        userId: user.id,
        repoId: repo.id,
        permission: "write" as const,
        checkedAt,
      })),
    );
    const as = (repo: typeof moving, changes: { private?: boolean } = {}) => ({
      githubRepoId: repo.githubRepoId,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      private: changes.private ?? repo.private,
      pushedAt: null,
    });

    await upsertRepos(db, { workspaceId: to.id, repos: [as(moving)] });
    await upsertRepos(db, {
      workspaceId: from.id,
      repos: [as(turning, { private: !turning.private }), as(staying)],
    });

    const of = (repoId: string) => getRepoAccess(db, { userId: user.id, repoId });
    expect(await of(moving.id)).toEqual({ permission: "write", checkedAt: new Date(0) });
    expect(await of(turning.id)).toEqual({ permission: "write", checkedAt: new Date(0) });
    expect(await of(staying.id)).toEqual({ permission: "write", checkedAt });
  });
});

describe("getRepoAccess and markRepoAccessStale", () => {
  test("a stale answer keeps its permission and loses its time, for the named target only", async () => {
    const [ines, omar, workspace, elsewhere] = await Promise.all([
      seedUser(db, "ines"),
      seedUser(db, "omar"),
      seedWorkspace(db, "acme"),
      seedWorkspace(db, "other"),
    ]);
    const [site, app, foreign] = await Promise.all([
      seedRepo(db, workspace.id, "acme/site"),
      seedRepo(db, workspace.id, "acme/app"),
      seedRepo(db, elsewhere.id, "other/site"),
    ]);
    const checkedAt = at("12:00:00");
    await recordRepoAccess(
      db,
      [ines, omar].flatMap((user) =>
        [site, app, foreign].map((repo) => ({
          userId: user.id,
          repoId: repo.id,
          permission: "write" as const,
          checkedAt,
        })),
      ),
    );
    const of = (userId: string, repoId: string) => getRepoAccess(db, { userId, repoId });

    expect(await of(ines.id, site.id)).toEqual({ permission: "write", checkedAt });
    expect(await markRepoAccessStale(db, { githubRepoIds: [site.githubRepoId] })).toBe(2);
    expect(await of(ines.id, site.id)).toEqual({ permission: "write", checkedAt: new Date(0) });
    expect(await of(ines.id, app.id)).toEqual({ permission: "write", checkedAt });

    // Already stale is not touched again.
    expect(await markRepoAccessStale(db, { workspaceId: workspace.id })).toBe(2);
    expect(await of(omar.id, foreign.id)).toEqual({ permission: "write", checkedAt });

    expect(await markRepoAccessStale(db, { userId: omar.id })).toBe(1);
    expect(await of(omar.id, foreign.id)).toEqual({ permission: "write", checkedAt: new Date(0) });
    expect(await of(ines.id, foreign.id)).toEqual({ permission: "write", checkedAt });
    expect(await markRepoAccessStale(db, { githubRepoIds: [] })).toBe(0);

    // Any real answer replaces a stale one.
    await recordRepoAccess(db, [
      { userId: ines.id, repoId: site.id, permission: "read", checkedAt: at("11:00:00") },
    ]);
    expect(await of(ines.id, site.id)).toEqual({ permission: "read", checkedAt: at("11:00:00") });
    expect(await of(ines.id, "repo_missing")).toBeNull();
  });
});
