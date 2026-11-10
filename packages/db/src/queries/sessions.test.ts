import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedUser } from "../fixtures.ts";
import { users } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { admitSession, endSession, getSessionUser } from "./sessions.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

test("an admitted session answers with its person, and an unknown one with nobody", async () => {
  const user = await seedUser(db);
  await admitSession(db, { id: "session_mac", userId: user.id });
  await admitSession(db, { id: "session_phone", userId: user.id });

  expect(await getSessionUser(db, "session_mac")).toEqual(user);
  expect(await getSessionUser(db, "session_phone")).toEqual(user);
  expect(await getSessionUser(db, "session_never_admitted")).toBeNull();
});

test("admitting a session again never hands it to someone else", async () => {
  const [maya, ines] = [await seedUser(db, "maya"), await seedUser(db, "ines")];
  await admitSession(db, { id: "session_shared", userId: maya.id });

  await admitSession(db, { id: "session_shared", userId: ines.id });

  expect((await getSessionUser(db, "session_shared"))!.id).toBe(maya.id);
});

test("an ended session is nobody's, and the person's other sessions are untouched", async () => {
  const user = await seedUser(db);
  await admitSession(db, { id: "session_one", userId: user.id });
  await admitSession(db, { id: "session_two", userId: user.id });

  await endSession(db, "session_one");
  await endSession(db, "session_one");

  expect(await getSessionUser(db, "session_one")).toBeNull();
  expect(await getSessionUser(db, "session_two")).not.toBeNull();
});

test("deleting a person ends their sessions", async () => {
  const user = await seedUser(db);
  await admitSession(db, { id: "session_gone", userId: user.id });

  await db.delete(users).where(eq(users.id, user.id));

  expect(await getSessionUser(db, "session_gone")).toBeNull();
});
