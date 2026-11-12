import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { type GithubAccess, memberships, users } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import {
  countJoinedMembers,
  ensureWorkspaceAdmin,
  listWorkspaceMembers,
  removeMembership,
  setMemberRole,
  workspaceHasAdmin,
} from "./members.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

async function team(
  ...people: [login: string, role: "admin" | "member", githubAccess?: GithubAccess][]
) {
  const workspace = await seedWorkspace(db);
  const members = [];
  for (const [login, role, githubAccess] of people) {
    const user = await seedUser(db, login);
    await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role, githubAccess });
    members.push(user);
  }
  return { workspace, members };
}

const roleOf = async (workspaceId: string, userId: string) =>
  (await db.select().from(memberships).where(eq(memberships.workspaceId, workspaceId))).find(
    (row) => row.userId === userId,
  )?.role;

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
    githubAccess: "collaborator",
  });
});

test("countJoinedMembers counts each workspace asked about", async () => {
  const one = await team(["a", "admin"], ["b", "member"]);
  const two = await team(["c", "admin"]);
  const empty = await seedWorkspace(db);

  const counts = await countJoinedMembers(db, [one.workspace.id, two.workspace.id, empty.id]);

  expect(counts.sort((x, y) => y.members - x.members)).toEqual([
    { workspaceId: one.workspace.id, members: 2 },
    { workspaceId: two.workspace.id, members: 1 },
  ]);
  expect(await countJoinedMembers(db, [])).toEqual([]);
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

test("setMemberRole never demotes an owner of the account, however many admins there are", async () => {
  const {
    workspace,
    members: [owner, other],
  } = await team(["owner", "admin", "owner"], ["other", "admin", "member"]);
  const key = (userId: string) => ({ workspaceId: workspace.id, userId });

  expect(await setMemberRole(db, { ...key(owner!.id), role: "member" })).toBe("owner");
  expect(await roleOf(workspace.id, owner!.id)).toBe("admin");
  // Making them what they are is no refusal, and someone else can still be demoted.
  expect(await setMemberRole(db, { ...key(owner!.id), role: "admin" })).toBe("updated");
  expect(await setMemberRole(db, { ...key(other!.id), role: "member" })).toBe("updated");
});

test("ensureWorkspaceAdmin promotes the longest-standing organization member, and only then", async () => {
  const {
    workspace,
    members: [outsider, early, late],
  } = await team(
    ["outsider", "member", "collaborator"],
    ["early", "member", "member"],
    ["late", "member", "member"],
  );
  // The outsider came first, and still is not the one.
  await db
    .update(memberships)
    .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
    .where(eq(memberships.userId, outsider!.id));
  await db
    .update(memberships)
    .set({ createdAt: new Date("2026-01-02T00:00:00Z") })
    .where(eq(memberships.userId, early!.id));

  expect(await ensureWorkspaceAdmin(db, workspace.id)).toBe(early!.id);
  expect(await roleOf(workspace.id, early!.id)).toBe("admin");
  // It has one now.
  expect(await ensureWorkspaceAdmin(db, workspace.id)).toBeNull();
  expect(await roleOf(workspace.id, late!.id)).toBe("member");
  expect(await roleOf(workspace.id, outsider!.id)).toBe("member");
});

test("ensureWorkspaceAdmin leaves a workspace of outside collaborators without one", async () => {
  const { workspace } = await team(["shared-with", "member", "collaborator"]);
  expect(await ensureWorkspaceAdmin(db, workspace.id)).toBeNull();
  expect(await workspaceHasAdmin(db, workspace.id)).toBe(false);
});

test("removeMembership drops one person from the workspace an installation belongs to", async () => {
  const {
    workspace,
    members: [gone, stays],
  } = await team(["gone", "member"], ["stays", "admin"]);

  expect(
    await removeMembership(db, { installationId: workspace.installationId!, userId: gone!.id }),
  ).toBe(workspace.id);
  expect(await roleOf(workspace.id, gone!.id)).toBeUndefined();
  expect(await roleOf(workspace.id, stays!.id)).toBe("admin");
  expect(
    await removeMembership(db, { installationId: workspace.installationId!, userId: gone!.id }),
  ).toBeNull();
  expect(await removeMembership(db, { installationId: 404_404, userId: stays!.id })).toBeNull();
});
