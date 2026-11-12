import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedCanvas, seedUser } from "../fixtures.ts";
import { presence } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { deleteStalePresence, listPresence, removePresence, touchPresence } from "./presence.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

// The time is the caller's: these move it by hand.
const start = new Date("2026-11-10T12:00:00Z");
const after = (seconds: number) => new Date(start.getTime() + seconds * 1000);

test("touching says who has a canvas open, with who they are", async () => {
  const { canvas, user } = await seedCanvas(db);
  const teammate = await seedUser(db, "maya");

  await touchPresence(db, { canvasId: canvas.id, userId: user.id, pageId: "pg_home", now: start });
  await touchPresence(db, { canvasId: canvas.id, userId: teammate.id, now: start });

  const here = await listPresence(db, { canvasId: canvas.id, now: start });
  expect(here.map((p) => [p.userId, p.githubLogin, p.pageId]).sort()).toEqual(
    [
      [user.id, "bryce", "pg_home"],
      [teammate.id, "maya", null],
    ].sort(),
  );
  expect(here[0]!.seenAt).toEqual(start);
});

test("touching again refreshes the one row and follows the person to another page", async () => {
  const { canvas, user } = await seedCanvas(db);
  await touchPresence(db, { canvasId: canvas.id, userId: user.id, pageId: "pg_home", now: start });

  await touchPresence(db, {
    canvasId: canvas.id,
    userId: user.id,
    pageId: "pg_pricing",
    now: after(40),
  });

  const here = await listPresence(db, { canvasId: canvas.id, now: after(40) });
  expect(here).toEqual([
    expect.objectContaining({ pageId: "pg_pricing", joinedAt: start, seenAt: after(40) }),
  ]);
});

test("a refresh that names no page leaves the person on the page they were on", async () => {
  const { canvas, user } = await seedCanvas(db);
  await touchPresence(db, { canvasId: canvas.id, userId: user.id, pageId: "pg_home", now: start });

  await touchPresence(db, { canvasId: canvas.id, userId: user.id, now: start });

  const list = () => listPresence(db, { canvasId: canvas.id, now: start });
  expect(await list()).toMatchObject([{ pageId: "pg_home" }]);
  // Null is a page too: it says they are on none.
  await touchPresence(db, { canvasId: canvas.id, userId: user.id, pageId: null, now: start });
  expect(await list()).toMatchObject([{ pageId: null }]);
});

test("someone who comes back after going stale joins afresh", async () => {
  const { canvas, user } = await seedCanvas(db);
  const teammate = await seedUser(db, "maya");
  await touchPresence(db, { canvasId: canvas.id, userId: user.id, now: start });
  await touchPresence(db, { canvasId: canvas.id, userId: teammate.id, now: after(60) });
  // The teammate keeps refreshing; the person stops, and the sweep has not run.
  await touchPresence(db, { canvasId: canvas.id, userId: teammate.id, now: after(110) });

  await touchPresence(db, { canvasId: canvas.id, userId: user.id, now: after(120) });

  const here = await listPresence(db, { canvasId: canvas.id, now: after(120) });
  // Longest here first: the teammate who stayed, then the person who just came back.
  expect(here.map((p) => [p.userId, p.joinedAt])).toEqual([
    [teammate.id, after(60)],
    [user.id, after(120)],
  ]);
});

test("someone who stopped refreshing is gone after the TTL", async () => {
  const { canvas, user } = await seedCanvas(db);
  const teammate = await seedUser(db, "maya");
  await touchPresence(db, { canvasId: canvas.id, userId: user.id, now: after(20) });
  await touchPresence(db, { canvasId: canvas.id, userId: teammate.id, now: start });

  // One missed refresh is not enough to drop someone; 75 seconds without one is.
  const here = await listPresence(db, { canvasId: canvas.id, now: after(80) });

  expect(here.map((p) => p.userId)).toEqual([user.id]);
  expect(await listPresence(db, { canvasId: canvas.id, now: after(80), ttlSeconds: 30 })).toEqual(
    [],
  );
});

test("presence is per canvas", async () => {
  const one = await seedCanvas(db);
  const other = await seedCanvas(db);
  await touchPresence(db, { canvasId: one.canvas.id, userId: one.user.id, now: start });

  expect(await listPresence(db, { canvasId: other.canvas.id, now: start })).toEqual([]);
});

test("removing takes a person out at once", async () => {
  const { canvas, user } = await seedCanvas(db);
  await touchPresence(db, { canvasId: canvas.id, userId: user.id, now: start });

  await removePresence(db, { canvasId: canvas.id, userId: user.id });

  expect(await listPresence(db, { canvasId: canvas.id, now: start })).toEqual([]);
});

test("the sweep deletes stale rows and leaves fresh ones", async () => {
  // The sweep is not one canvas's, so it gets a database with nothing else in it.
  const db = await createTestDb();
  const { canvas, user } = await seedCanvas(db);
  const teammate = await seedUser(db, "maya");
  await touchPresence(db, { canvasId: canvas.id, userId: teammate.id, now: start });
  await touchPresence(db, { canvasId: canvas.id, userId: user.id, now: after(300) });

  expect(await deleteStalePresence(db, { now: after(300) })).toBe(1);

  const rows = await db.select().from(presence);
  expect(rows.map((row) => row.userId)).toEqual([user.id]);
  await db.$client.close();
});
