import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { memberships, users } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import {
  countWorkspaceMembers,
  listWorkspaceMembers,
  setMemberRole,
  workspaceHasAdmin,
} from "./members.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

async function team(...people: [login: string, role: "admin" | "member"][]) {
  const workspace = await seedWorkspace(db);
  const members = [];
  for (const [login, role] of people) {
    const user = await seedUser(db, login);
    await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role });
    members.push(user);
  }
  return { workspace, members };
}

test("listWorkspaceMembers puts admins first, then everyone by name", async () => {
  const { workspace, members } = await team(
    ["zed", "member"],
    ["amy", "member"],
    ["yolanda", "admin"],
    ["bo", "admin"],
  );
  await db.update(users).set({ name: "Abe" }).where(eq(users.id, members[0]!.id));

  const listed = await listWorkspaceMembers(db, workspace.id);

  expect(listed.map((member) => [member.githubLogin, member.role])).toEqual([
    ["bo", "admin"],
    ["yolanda", "admin"],
    ["zed", "member"],
    ["amy", "member"],
  ]);
  expect(listed[2]).toEqual({
    userId: members[0]!.id,
    githubLogin: "zed",
    name: "Abe",
    avatarUrl: null,
    role: "member",
  });
});

test("countWorkspaceMembers counts each workspace asked about", async () => {
  const one = await team(["a", "admin"], ["b", "member"]);
  const two = await team(["c", "admin"]);
  const empty = await seedWorkspace(db);

  const counts = await countWorkspaceMembers(db, [one.workspace.id, two.workspace.id, empty.id]);

  expect(counts.sort((x, y) => y.members - x.members)).toEqual([
    { workspaceId: one.workspace.id, members: 2 },
    { workspaceId: two.workspace.id, members: 1 },
  ]);
  expect(await countWorkspaceMembers(db, [])).toEqual([]);
});

test("workspaceHasAdmin", async () => {
  const led = await team(["lead", "admin"]);
  const unled = await team(["follower", "member"]);
  expect(await workspaceHasAdmin(db, led.workspace.id)).toBe(true);
  expect(await workspaceHasAdmin(db, unled.workspace.id)).toBe(false);
});

test("setMemberRole changes a role, and never demotes the last admin", async () => {
  const {
    workspace,
    members: [first, second],
  } = await team(["first", "admin"], ["second", "member"]);
  const key = (userId: string) => ({ workspaceId: workspace.id, userId });
  const role = async (userId: string) =>
    (await db.select().from(memberships).where(eq(memberships.userId, userId)))[0]!.role;

  expect(await setMemberRole(db, { ...key(first!.id), role: "member" })).toBe("last_admin");
  expect(await role(first!.id)).toBe("admin");

  expect(await setMemberRole(db, { ...key(second!.id), role: "admin" })).toBe("updated");
  expect(await setMemberRole(db, { ...key(first!.id), role: "member" })).toBe("updated");
  expect(await role(first!.id)).toBe("member");
  // Setting the role a member already has is fine.
  expect(await setMemberRole(db, { ...key(second!.id), role: "admin" })).toBe("updated");
  expect(await setMemberRole(db, { ...key(second!.id), role: "member" })).toBe("last_admin");

  expect(await setMemberRole(db, { ...key("usr_nobody"), role: "admin" })).toBe("not_member");
});
