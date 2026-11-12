import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { actorFor, rename, seedCanvas, seedRepo } from "../fixtures.ts";
import { migrationsFolder } from "../migrations.ts";
import { getCanvas } from "../queries/canvases.ts";
import { commitOps } from "../queries/ops.ts";
import { createQuestion } from "../queries/questions.ts";
import { appendThreadItem } from "../queries/thread.ts";
import { recordUsage } from "../queries/usage.ts";
import { createTestDb } from "../testing.ts";
import * as schema from "./index.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

/** A Drizzle query can be awaited but is not a promise, and `rejects` wants a promise. */
const run = (query: PromiseLike<unknown>) => Promise.resolve(query);

describe("migrations", () => {
  test("are in step with the schema", async () => {
    const meta = join(migrationsFolder, "meta");
    const latest = readdirSync(meta)
      .filter((name) => name.endsWith("_snapshot.json"))
      .sort()
      .at(-1)!;
    const migrated = JSON.parse(readFileSync(join(meta, latest), "utf8"));

    const pending = await generateMigration(migrated, generateDrizzleJson(schema, migrated.id));

    // Not empty? The schema changed without `bun run db:generate`.
    expect(pending).toEqual([]);
  });

  test("create a primary key on every table, which a live query needs", async () => {
    const { rows } = await db.execute<{ table_name: string }>(sql`
      select t.table_name
        from information_schema.tables t
       where t.table_schema = 'public'
         and not exists (
           select 1
             from information_schema.table_constraints c
            where c.table_schema = t.table_schema
              and c.table_name = t.table_name
              and c.constraint_type = 'PRIMARY KEY'
         )
    `);
    expect(rows).toEqual([]);
  });

  test("index every foreign key that deleting a canvas follows", async () => {
    // Postgres finds the rows that point at a deleted row by scanning for them. Without an
    // index whose first columns are the key's (a partial index does not count), every canvas
    // deleted reads the whole table, and usage and events only ever grow.
    const { rows } = await db.execute<{ key: string }>(sql`
      select c.conrelid::regclass::text || '.' || c.conname as key
        from pg_constraint c
       where c.contype = 'f'
         and c.confrelid in ('canvases'::regclass, 'sandboxes'::regclass)
         and not exists (
           select 1
             from pg_index i
            where i.indrelid = c.conrelid
              and i.indpred is null
              and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
         )
    `);
    expect(rows).toEqual([]);
  });

  test("store ops and documents as json and never jsonb", async () => {
    const { rows } = await db.execute<{ column: string; data_type: string }>(sql`
      select table_name || '.' || column_name as column, data_type
        from information_schema.columns
       where table_schema = 'public'
         and (table_name, column_name) in (
           ('canvas_ops', 'op'), ('canvas_ops', 'inverse'), ('canvas_checkpoints', 'doc')
         )
       order by 1
    `);
    expect(rows).toEqual([
      { column: "canvas_checkpoints.doc", data_type: "json" },
      { column: "canvas_ops.inverse", data_type: "json" },
      { column: "canvas_ops.op", data_type: "json" },
    ]);
  });

  test("seed the first rate card", async () => {
    const [card] = await db.select().from(schema.rateCards);
    expect(card).toMatchObject({
      version: 1,
      creditMicrousd: 100_000,
      sandboxCreditsPerAwakeHour: 5,
      freeCreditsPerMember: 100,
      defaultCapCents: 10_000,
      capWarningFraction: 0.8,
      idleSleepSeconds: 300,
      modelRates: {},
    });
  });
});

describe("deleting", () => {
  test("a canvas takes everything that was only its own", async () => {
    const { canvas, user } = await seedCanvas(db);
    await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("a", "One")],
    });
    await appendThreadItem(db, { canvasId: canvas.id, kind: "notice", payload: {} });
    await createQuestion(db, { canvasId: canvas.id, kind: "question", payload: {} });

    await db.delete(schema.canvases).where(eq(schema.canvases.id, canvas.id));

    for (const table of [
      schema.canvasOps,
      schema.canvasCheckpoints,
      schema.threadItems,
      schema.questions,
    ]) {
      expect(await db.$count(table, eq(table.canvasId, canvas.id))).toBe(0);
    }
  });

  test("a canvas leaves its usage behind, for the bill", async () => {
    const seeded = await seedCanvas(db);
    await recordUsage(db, {
      id: "use_kept",
      workspaceId: seeded.workspace.id,
      canvasId: seeded.canvas.id,
      userId: seeded.user.id,
      kind: "sandbox",
      seconds: 720,
      credits: 1,
      costMicrousd: 0,
      payer: "ponzu",
      rateCardVersion: 1,
      occurredAt: new Date(),
      periodStart: new Date("2026-11-01T00:00:00Z"),
    });

    await db.delete(schema.canvases).where(eq(schema.canvases.id, seeded.canvas.id));

    const [usage] = await db
      .select()
      .from(schema.usageEvents)
      .where(eq(schema.usageEvents.id, "use_kept"));
    expect(usage).toMatchObject({ canvasId: null, credits: 1 });
  });

  test("a person leaves their canvases to the workspace", async () => {
    const { canvas, user } = await seedCanvas(db);

    await db.delete(schema.users).where(eq(schema.users.id, user.id));

    expect(await getCanvas(db, canvas.id)).toMatchObject({ id: canvas.id, ownerId: null });
  });

  test("a workspace or a repo is refused while it has canvases", async () => {
    const { canvas, workspace } = await seedCanvas(db);
    const repo = await seedRepo(db, workspace.id);
    await db
      .update(schema.canvases)
      .set({ repoId: repo.id })
      .where(eq(schema.canvases.id, canvas.id));

    await expect(
      run(db.delete(schema.repos).where(eq(schema.repos.id, repo.id))),
    ).rejects.toThrow();
    await expect(
      run(db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspace.id))),
    ).rejects.toThrow();
    expect(await getCanvas(db, canvas.id)).not.toBeNull();
  });
});

describe("constraints", () => {
  test("one canvas, one branch in a repo", async () => {
    const one = await seedCanvas(db);
    const two = await seedCanvas(db);
    const repo = await seedRepo(db, one.workspace.id);
    const onBranch = (canvasId: string) =>
      run(
        db
          .update(schema.canvases)
          .set({ repoId: repo.id, branch: "pz/shorter-onboarding" })
          .where(eq(schema.canvases.id, canvasId)),
      );

    await onBranch(one.canvas.id);

    await expect(onBranch(two.canvas.id)).rejects.toThrow();
  });

  test("one canvas, one sandbox", async () => {
    const { canvas } = await seedCanvas(db);
    const sandbox = (state: "asleep" | "waking") =>
      run(db.insert(schema.sandboxes).values({ canvasId: canvas.id, state }));

    await sandbox("asleep");
    await expect(sandbox("waking")).rejects.toThrow();
  });

  test("a value outside an enum is refused by the database, not only by the types", async () => {
    const { canvas } = await seedCanvas(db);
    const set = (column: string, value: string) =>
      run(
        db.execute(
          sql`update canvases set ${sql.identifier(column)} = ${value} where id = ${canvas.id}`,
        ),
      );

    await expect(set("status", "archived")).rejects.toThrow();
    await expect(set("agent_state", "thinking")).rejects.toThrow();
    await expect(set("pr_checks", "green")).rejects.toThrow();
    // Settled needs its time, and a pull request number needs its state.
    await expect(set("status", "settled")).rejects.toThrow();
    await expect(
      run(
        db.update(schema.canvases).set({ prNumber: 12 }).where(eq(schema.canvases.id, canvas.id)),
      ),
    ).rejects.toThrow();
  });
});
