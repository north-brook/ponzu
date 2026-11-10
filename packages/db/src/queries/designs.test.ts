import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq, sql } from "drizzle-orm";
import { actorFor, rename, seedDesign, seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { DESIGN_HEAD_COLUMNS, type LiveDesignHead, toDesignHead } from "../head.ts";
import { designReads, designs } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { readDocSource } from "./checkpoints.ts";
import {
  createDesign,
  getDesign,
  getDesignAssetKey,
  getDesignHead,
  head as headColumns,
  listWorkspaceDesigns,
  markDesignSeen,
} from "./designs.ts";
import { commitOps } from "./ops.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

describe("createDesign", () => {
  test("makes the design and its first checkpoint together", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id);
    const doc = { ...emptyDoc("Shorter onboarding"), tokens: ":root {\n  --ink: #111;\n}\n" };

    const design = await createDesign(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Shorter onboarding",
      branch: "pz/shorter-onboarding",
      model: "claude-opus",
      effort: "high",
      doc,
    });

    expect(design.id).toMatch(/^des_[0-9a-z]{16}$/);
    expect(design).toMatchObject({
      status: "active",
      seq: 0,
      agentState: "idle",
      agentArtboards: [],
      needsYouCount: 0,
      prNumber: null,
      prChecks: "none",
      sandboxId: null,
    });
    expect(await getDesign(db, design.id)).toEqual(design);
    expect(await readDocSource(db, design.id)).toEqual({
      seq: 0,
      checkpoint: { seq: 0, doc },
      ops: [],
    });
  });

  test("gives every design its own unguessable asset key", async () => {
    const [one, two] = await Promise.all([seedDesign(db), seedDesign(db)]);
    const [oneKey, twoKey] = await Promise.all([
      getDesignAssetKey(db, one.design.id),
      getDesignAssetKey(db, two.design.id),
    ]);
    expect(oneKey).toMatch(/^[0-9a-z]{32}$/);
    expect(oneKey).not.toBe(twoKey);
    expect(await getDesignAssetKey(db, "des_missing")).toBeNull();
  });

  test("leaves nothing behind when the design cannot be made", async () => {
    const user = await seedUser(db);
    const before = await db.$count(designs);

    const refused = createDesign(db, {
      workspaceId: "ws_missing",
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Orphan",
      branch: null,
      doc: emptyDoc("Orphan"),
    });

    await expect(refused).rejects.toThrow();
    expect(await db.$count(designs)).toBe(before);
  });

  test("refuses a repo that is not the workspace's", async () => {
    const [user, workspace, elsewhere] = await Promise.all([
      seedUser(db),
      seedWorkspace(db),
      seedWorkspace(db),
    ]);
    const repo = await seedRepo(db, elsewhere.id);

    const refused = createDesign(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Misfiled",
      branch: "pz/misfiled",
      doc: emptyDoc("Misfiled"),
    });

    await expect(refused).rejects.toThrow("designs_repo_id_workspace_id_fk");
  });

  test("refuses a document Postgres cannot store, before it sends anything", async () => {
    const { user, workspace } = await seedDesign(db);

    const refused = createDesign(db, {
      workspaceId: workspace.id,
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Broken",
      branch: null,
      doc: emptyDoc("half a pair \ud83d"),
    });

    await expect(refused).rejects.toThrow("cannot store");
  });
});

describe("getDesign", () => {
  test("is the row without its asset key, which has to be asked for by name", async () => {
    const { design } = await seedDesign(db);

    const row = await getDesign(db, design.id);

    expect(row).toMatchObject({ id: design.id, name: "Lisbon", sandboxId: null });
    expect(row).not.toHaveProperty("assetKey");
    expect(design).not.toHaveProperty("assetKey");
  });
});

describe("getDesignHead", () => {
  test("is the small part of the row that clients watch", async () => {
    const { design, user } = await seedDesign(db);
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("a", "One")],
    });

    const head = await getDesignHead(db, design.id);

    expect(head).toMatchObject({ id: design.id, workspaceId: design.workspaceId, seq: 1 });
    // Whatever joins this list is re-sent to every watcher on every op. Nothing secret, nothing large.
    expect(Object.keys(head!).sort()).toEqual([
      "agentArtboards",
      "agentState",
      "agentStatus",
      "icon",
      "id",
      "lastActivityAt",
      "name",
      "needsYouCount",
      "prAutoMerge",
      "prChecks",
      "prMergeable",
      "prNumber",
      "prState",
      "previewSeq",
      "seq",
      "status",
      "workspaceId",
    ]);
  });

  test("is null for a design that does not exist", async () => {
    expect(await getDesignHead(db, "des_missing")).toBeNull();
    expect(await getDesign(db, "des_missing")).toBeNull();
  });

  test("a live query's columns are the head's, by their own names", () => {
    expect<string[]>([...DESIGN_HEAD_COLUMNS]).toEqual(
      Object.values(headColumns).map((column) => column.name),
    );
  });

  test("a row as Realtime delivers it decodes to the same head", async () => {
    const { design, user } = await seedDesign(db);
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: Array.from({ length: 10 }, (_, i) => rename(`op-${i}`, `v${i}`)),
    });
    await db.update(designs).set({ previewSeq: 9 }).where(eq(designs.id, design.id));
    // What the Realtime SDK hands over: keys are column names, a bigint is a string.
    const { rows } = await db.execute<LiveDesignHead>(sql`
      select ${sql.raw(DESIGN_HEAD_COLUMNS.join(", "))} from designs where id = ${design.id}
    `);
    const live = { ...rows[0]!, seq: "10", preview_seq: "9" };

    const decoded = toDesignHead(live);

    expect(decoded).toEqual((await getDesignHead(db, design.id))!);
    expect(decoded.seq).toBe(10);
    expect(decoded.previewSeq).toBe(9);
    expect(toDesignHead({ ...live, preview_seq: null }).previewSeq).toBeNull();
  });
});

describe("listWorkspaceDesigns", () => {
  async function workspaceWithDesigns() {
    const [user, workspace, elsewhere] = await Promise.all([
      seedUser(db),
      seedWorkspace(db),
      seedWorkspace(db),
    ]);
    const repo = await seedRepo(db, workspace.id);
    const make = (workspaceId: string, name: string, repoId: string | null) =>
      createDesign(db, {
        workspaceId,
        repoId,
        ownerId: user.id,
        claudeAccountId: null,
        name,
        branch: repoId ? `pz/${name.toLowerCase()}` : null,
        doc: emptyDoc(name),
      });
    const oldest = await make(workspace.id, "Oldest", repo.id);
    const settled = await make(workspace.id, "Settled", null);
    const newest = await make(workspace.id, "Newest", null);
    await make(elsewhere.id, "Elsewhere", null);
    const at = (id: string, time: string) =>
      db
        .update(designs)
        .set({ lastActivityAt: new Date(time) })
        .where(eq(designs.id, id));
    await at(oldest.id, "2026-11-01T00:00:00Z");
    await at(settled.id, "2026-11-02T00:00:00Z");
    await at(newest.id, "2026-11-03T00:00:00Z");
    await db
      .update(designs)
      .set({ status: "settled", settledAt: new Date() })
      .where(eq(designs.id, settled.id));
    return { user, workspace, oldest, settled, newest };
  }

  test("lists one workspace's designs, most recently active first", async () => {
    const { user, workspace } = await workspaceWithDesigns();

    const all = await listWorkspaceDesigns(db, { workspaceId: workspace.id, userId: user.id });

    expect(all.map((design) => design.name)).toEqual(["Newest", "Settled", "Oldest"]);
    expect(all.map((design) => design.repoFullName)).toEqual([null, null, "north-brook/fernwood"]);
  });

  test("lists what a sidebar row shows, and no asset key or sandbox", async () => {
    const { user, workspace, oldest } = await workspaceWithDesigns();

    const all = await listWorkspaceDesigns(db, { workspaceId: workspace.id, userId: user.id });

    const row = all.find((design) => design.id === oldest.id)!;
    expect(row).toMatchObject({
      ...(await getDesignHead(db, oldest.id))!,
      repoId: oldest.repoId,
      ownerId: user.id,
      branch: "pz/oldest",
      settledAt: null,
    });
    // One `c.json(designs)` must not hand every design's files to everyone in the workspace.
    for (const design of all) {
      expect(design).not.toHaveProperty("assetKey");
      expect(design).not.toHaveProperty("sandboxId");
    }
  });

  test("filters by status", async () => {
    const { user, workspace } = await workspaceWithDesigns();
    const list = (status: "active" | "settled") =>
      listWorkspaceDesigns(db, { workspaceId: workspace.id, userId: user.id, status });

    expect((await list("active")).map((design) => design.name)).toEqual(["Newest", "Oldest"]);
    expect((await list("settled")).map((design) => design.name)).toEqual(["Settled"]);
  });

  test("says how far the viewer has looked, and only the viewer", async () => {
    const { user, workspace, newest, oldest } = await workspaceWithDesigns();
    const teammate = await seedUser(db, "maya");
    await markDesignSeen(db, { userId: user.id, designId: newest.id, seq: 4, threadSeq: 9 });
    await markDesignSeen(db, { userId: teammate.id, designId: oldest.id, seq: 2 });

    const mine = await listWorkspaceDesigns(db, { workspaceId: workspace.id, userId: user.id });

    expect(mine.map((d) => [d.name, d.seenSeq, d.seenThreadSeq])).toEqual([
      ["Newest", 4, 9],
      ["Settled", null, null],
      ["Oldest", null, null],
    ]);
  });
});

describe("markDesignSeen", () => {
  test("only ever moves forward", async () => {
    const { design, user } = await seedDesign(db);
    const read = async () => {
      const [row] = await db.select().from(designReads).where(eq(designReads.userId, user.id));
      return [row!.seenSeq, row!.seenThreadSeq];
    };
    const key = { userId: user.id, designId: design.id };

    await markDesignSeen(db, { ...key, seq: 5, threadSeq: 3 });
    expect(await read()).toEqual([5, 3]);

    // A slow request from another device, and one that only saw the thread.
    await markDesignSeen(db, { ...key, seq: 2, threadSeq: 1 });
    expect(await read()).toEqual([5, 3]);
    await markDesignSeen(db, { ...key, threadSeq: 8 });
    expect(await read()).toEqual([5, 8]);
  });
});
