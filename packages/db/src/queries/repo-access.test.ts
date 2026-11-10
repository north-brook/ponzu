import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { repoAccess } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { createDesign } from "./designs.ts";
import { listDesignRepoAccess, recordRepoAccess } from "./repo-access.ts";

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

describe("listDesignRepoAccess", () => {
  test("lists the workspace's repos that hold a design, with what one person may do in each", async () => {
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

    const listed = await listDesignRepoAccess(db, { workspaceId: workspace.id, userId: user.id });

    // Seeded in this order, so their GitHub ids are too.
    expect(listed.sort((a, b) => a.githubRepoId - b.githubRepoId)).toEqual([
      {
        repoId: withDesign.id,
        githubRepoId: withDesign.githubRepoId,
        permission: null,
        checkedAt: null,
      },
      {
        repoId: asked.id,
        githubRepoId: asked.githubRepoId,
        permission: "write",
        checkedAt: at("12:00:00"),
      },
    ]);
  });
});
