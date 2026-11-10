import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { seedDesign, seedUser } from "../fixtures.ts";
import { presence } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { deleteStalePresence, listPresence, removePresence, touchPresence } from "./presence.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

/** Pretend a person's last refresh was `seconds` ago. */
const lastSeen = (db: Db, designId: string, userId: string, seconds: number) =>
  db
    .update(presence)
    .set({ seenAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(and(eq(presence.designId, designId), eq(presence.userId, userId)));

test("touching says who has a design open, with who they are", async () => {
  const { design, user } = await seedDesign(db);
  const teammate = await seedUser(db, "maya");

  await touchPresence(db, { designId: design.id, userId: user.id, pageId: "pg_home" });
  await touchPresence(db, { designId: design.id, userId: teammate.id });

  const here = await listPresence(db, { designId: design.id });
  expect(here.map((p) => [p.userId, p.githubLogin, p.pageId]).sort()).toEqual(
    [
      [user.id, "bryce", "pg_home"],
      [teammate.id, "maya", null],
    ].sort(),
  );
  expect(here[0]!.seenAt).toBeInstanceOf(Date);
});

test("touching again refreshes the one row and follows the person to another page", async () => {
  const { design, user } = await seedDesign(db);
  await touchPresence(db, { designId: design.id, userId: user.id, pageId: "pg_home" });
  await lastSeen(db, design.id, user.id, 40);
  const [before] = await listPresence(db, { designId: design.id });

  await touchPresence(db, { designId: design.id, userId: user.id, pageId: "pg_pricing" });

  const here = await listPresence(db, { designId: design.id });
  expect(here).toHaveLength(1);
  expect(here[0]).toMatchObject({ pageId: "pg_pricing", joinedAt: before!.joinedAt });
  expect(here[0]!.seenAt.getTime()).toBeGreaterThan(before!.seenAt.getTime());
});

test("someone who stopped refreshing is gone after the TTL", async () => {
  const { design, user } = await seedDesign(db);
  const teammate = await seedUser(db, "maya");
  await touchPresence(db, { designId: design.id, userId: user.id });
  await touchPresence(db, { designId: design.id, userId: teammate.id });
  // One missed refresh is not enough to drop someone; 75 seconds without one is.
  await lastSeen(db, design.id, user.id, 60);
  await lastSeen(db, design.id, teammate.id, 80);

  const here = await listPresence(db, { designId: design.id });

  expect(here.map((p) => p.userId)).toEqual([user.id]);
  expect(await listPresence(db, { designId: design.id, ttlSeconds: 30 })).toEqual([]);
});

test("presence is per design", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  await touchPresence(db, { designId: one.design.id, userId: one.user.id });

  expect(await listPresence(db, { designId: other.design.id })).toEqual([]);
});

test("removing takes a person out at once", async () => {
  const { design, user } = await seedDesign(db);
  await touchPresence(db, { designId: design.id, userId: user.id });

  await removePresence(db, { designId: design.id, userId: user.id });

  expect(await listPresence(db, { designId: design.id })).toEqual([]);
});

test("the sweep deletes stale rows and leaves fresh ones", async () => {
  // The sweep is not one design's, so it gets a database with nothing else in it.
  const db = await createTestDb();
  const { design, user } = await seedDesign(db);
  const teammate = await seedUser(db, "maya");
  await touchPresence(db, { designId: design.id, userId: user.id });
  await touchPresence(db, { designId: design.id, userId: teammate.id });
  await lastSeen(db, design.id, teammate.id, 300);

  expect(await deleteStalePresence(db)).toBe(1);

  const rows = await db.select().from(presence);
  expect(rows.map((row) => row.userId)).toEqual([user.id]);
  await db.$client.close();
});
