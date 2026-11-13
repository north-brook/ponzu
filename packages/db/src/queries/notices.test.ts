import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { emailNotices, users } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership, upsertWorkspace } from "./accounts.ts";
import {
  claimEmailNotice,
  countWithoutAddress,
  emailNoticeRecords,
  existingUsers,
  finishEmailNotice,
  noticeAudience,
} from "./email.ts";

/*
 * Legal notices' reads and writes (docs/cloud.md, "Email"): who each notice is for, and the
 * record that makes each person's go at most once.
 */

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

test("billing notices go to organisations' admins and personal workspaces' own people, once each", async () => {
  const org = await seedWorkspace(db, "acme");
  const other = await seedWorkspace(db, "globex");
  const [admin, member, twoHats, owner, guest, loner] = await Promise.all(
    ["n-admin", "n-member", "n-twohats", "n-owner", "n-guest", "n-loner"].map((login) =>
      seedUser(db, login),
    ),
  );
  await upsertMembership(db, { workspaceId: org.id, userId: admin!.id, role: "admin" });
  await upsertMembership(db, { workspaceId: org.id, userId: member!.id, role: "member" });
  await upsertMembership(db, { workspaceId: org.id, userId: twoHats!.id, role: "admin" });
  await upsertMembership(db, { workspaceId: other.id, userId: twoHats!.id, role: "admin" });
  const personal = await upsertWorkspace(db, {
    githubAccountId: owner!.githubUserId,
    githubLogin: owner!.githubLogin,
    kind: "personal",
    name: owner!.githubLogin,
    avatarUrl: null,
    installationId: 880_001,
    repositorySelection: "all",
    installedByUserId: owner!.id,
  });
  await upsertMembership(db, { workspaceId: personal.id, userId: owner!.id, role: "admin" });
  // A collaborator on someone's personal workspace, even one made an admin, does not pay.
  await upsertMembership(db, { workspaceId: personal.id, userId: guest!.id, role: "admin" });

  const billing = await noticeAudience(db, "billing");
  expect(billing).toEqual([admin!.id, owner!.id, twoHats!.id].sort());
  expect(billing).not.toContain(member!.id);
  expect(billing).not.toContain(guest!.id);
  expect(billing).not.toContain(loner!.id);

  const everyone = await noticeAudience(db, "everyone");
  for (const person of [admin, member, twoHats, owner, guest, loner]) {
    expect(everyone).toContain(person!.id);
  }
  expect(everyone).toEqual([...everyone].sort());
});

test("existingUsers and countWithoutAddress read only what is there", async () => {
  const [a, b] = await Promise.all([seedUser(db, "n-a"), seedUser(db, "n-b")]);
  await db.update(users).set({ email: null }).where(eq(users.id, b!.id));
  expect(await existingUsers(db, [b!.id, "usr_nobody", a!.id])).toEqual([a!.id, b!.id].sort());
  expect(await existingUsers(db, [])).toEqual([]);
  expect(await countWithoutAddress(db, [a!.id, b!.id, "usr_nobody"])).toBe(1);
  expect(await countWithoutAddress(db, [])).toBe(0);
});

test("a record is claimed once, and only a pending one is ever finished", async () => {
  const person = await seedUser(db, "n-record");
  const first = new Date("2026-03-01T10:00:00.000Z");
  const claimed = await claimEmailNotice(db, {
    noticeId: "n-test",
    userId: person.id,
    workspaceId: null,
    now: first,
  });
  expect(claimed).toEqual({ userId: person.id, outcome: "pending", createdAt: first });

  // Claiming again keeps the first row and its time.
  const again = await claimEmailNotice(db, {
    noticeId: "n-test",
    userId: person.id,
    workspaceId: "ws_other",
    now: new Date("2026-03-02T10:00:00.000Z"),
  });
  expect(again.createdAt).toEqual(first);

  const sentAt = new Date("2026-03-01T10:00:01.000Z");
  expect(
    await finishEmailNotice(db, {
      noticeId: "n-test",
      userId: person.id,
      outcome: "sent",
      address: "n-record@example.com",
      resendId: "eml_1",
      sentAt,
    }),
  ).toBe(true);
  // A second outcome never overwrites the first.
  expect(
    await finishEmailNotice(db, {
      noticeId: "n-test",
      userId: person.id,
      outcome: "refused",
      address: null,
      resendId: null,
      sentAt: null,
    }),
  ).toBe(false);
  const [row] = await db.select().from(emailNotices).where(eq(emailNotices.userId, person.id));
  expect(row).toMatchObject({
    outcome: "sent",
    address: "n-record@example.com",
    resendId: "eml_1",
    sentAt,
    workspaceId: null,
  });
  expect(
    (
      await claimEmailNotice(db, {
        noticeId: "n-test",
        userId: person.id,
        workspaceId: null,
        now: first,
      })
    ).outcome,
  ).toBe("sent");

  const records = await emailNoticeRecords(db, "n-test");
  expect(records.get(person.id)?.outcome).toBe("sent");
  expect((await emailNoticeRecords(db, "n-elsewhere")).size).toBe(0);
});
