import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { actorFor, rename, seedDesign, seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { designReads, designs } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { readDocSource } from "./checkpoints.ts";
import {
  createDesign,
  getDesign,
  getDesignHead,
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
    expect(one.design.assetKey).toMatch(/^[0-9a-z]{32}$/);
    expect(one.design.assetKey).not.toBe(two.design.assetKey);
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
