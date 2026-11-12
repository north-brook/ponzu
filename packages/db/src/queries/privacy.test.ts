import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedUser } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { getUser, upsertUser } from "./accounts.ts";
import { listUsageOptOuts, setShareUsage } from "./privacy.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

test("everyone shares usage data until they turn it off, and only those who did are listed", async () => {
  const ada = await seedUser(db, "ada");
  const bo = await seedUser(db, "bo");
  expect(ada.shareUsage).toBe(true);
  expect(await listUsageOptOuts(db)).toEqual([]);

  expect(await setShareUsage(db, { userId: ada.id, shareUsage: false })).toEqual({
    shareUsage: false,
  });
  expect(await listUsageOptOuts(db)).toEqual([ada.id]);
  expect((await getUser(db, bo.id))?.shareUsage).toBe(true);

  expect(await setShareUsage(db, { userId: ada.id, shareUsage: true })).toEqual({
    shareUsage: true,
  });
  expect(await listUsageOptOuts(db)).toEqual([]);
});

test("signing in again keeps the switch where the person left it", async () => {
  const cy = await seedUser(db, "cy");
  await setShareUsage(db, { userId: cy.id, shareUsage: false });
  await upsertUser(db, {
    workosUserId: cy.workosUserId,
    githubUserId: cy.githubUserId,
    githubLogin: "cy-renamed",
    name: "Cy",
    email: "cy@example.com",
    avatarUrl: null,
  });
  expect((await getUser(db, cy.id))?.shareUsage).toBe(false);
  await setShareUsage(db, { userId: cy.id, shareUsage: true });
});

test("no such person: nothing changes, and null says so", async () => {
  expect(await setShareUsage(db, { userId: "usr_nobody", shareUsage: false })).toBeNull();
  expect(await listUsageOptOuts(db)).toEqual([]);
});
