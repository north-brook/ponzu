import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { workspaces } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import {
  bestPermission,
  countWorkspacePeople,
  forgetWorkspacePeople,
  type GithubPerson,
  listRepoPeople,
  listWorkspacePeople,
  recordWorkspacePeople,
} from "./people.ts";
import { recordRepoAccess } from "./repo-access.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 11, 12, minutes));

function someone(
  githubUserId: number,
  githubLogin: string,
  repoPermissions: GithubPerson["repoPermissions"],
  githubAccess: GithubPerson["githubAccess"] = "member",
): GithubPerson {
  return {
    githubUserId,
    githubLogin,
    name: githubLogin.toUpperCase(),
    avatarUrl: `https://avatars.example/${githubLogin}`,
    githubAccess,
    repoPermissions,
  };
}

test("bestPermission is the most any of them allows", () => {
  expect(bestPermission(["read", "admin", "write"])).toBe("admin");
  expect(bestPermission(["read", "write"])).toBe("write");
  expect(bestPermission([])).toBe("none");
});

test("a workspace never read has no count; one read counts everyone it found", async () => {
  const workspace = await seedWorkspace(db);
  expect(await countWorkspacePeople(db, [workspace.id])).toEqual([
    { workspaceId: workspace.id, people: null },
  ]);

  await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [someone(900_001, "ting", { "1": "admin" }), someone(900_002, "sam", { "1": "read" })],
    complete: true,
    seenAt: at(0),
  });

  expect(await countWorkspacePeople(db, [workspace.id])).toEqual([
    { workspaceId: workspace.id, people: 2 },
  ]);
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id));
  expect(row?.peopleSyncedAt).toEqual(at(0));
  expect(row?.peopleComplete).toBe(true);
});

test("a complete read drops whoever it did not find; one cut short keeps them", async () => {
  const workspace = await seedWorkspace(db);
  const ting = someone(900_011, "ting", { "1": "write" });
  const sam = someone(900_012, "sam", { "1": "write" });
  await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [ting, sam],
    complete: true,
    seenAt: at(0),
  });

  await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [ting],
    complete: false,
    seenAt: at(1),
  });
  expect((await listWorkspacePeople(db, workspace.id)).map((p) => p.githubLogin)).toEqual([
    "sam",
    "ting",
  ]);

  await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [ting],
    complete: true,
    seenAt: at(2),
  });
  expect((await listWorkspacePeople(db, workspace.id)).map((p) => p.githubLogin)).toEqual(["ting"]);
});

test("a read older than the one kept changes nothing", async () => {
  const workspace = await seedWorkspace(db);
  const ting = someone(900_021, "ting", { "1": "write" });
  const sam = someone(900_022, "sam", { "1": "write" });
  expect(
    await recordWorkspacePeople(db, {
      workspaceId: workspace.id,
      people: [ting],
      complete: true,
      seenAt: at(5),
    }),
  ).toBe(true);

  // Began before sam lost access, finished after the read that saw it.
  expect(
    await recordWorkspacePeople(db, {
      workspaceId: workspace.id,
      people: [ting, sam],
      complete: true,
      seenAt: at(4),
    }),
  ).toBe(false);
  expect((await listWorkspacePeople(db, workspace.id)).map((p) => p.githubLogin)).toEqual(["ting"]);
});

test("someone found with no permission at all is not written", async () => {
  const workspace = await seedWorkspace(db);
  await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [someone(900_031, "nobody", {})],
    complete: true,
    seenAt: at(0),
  });
  expect(await listWorkspacePeople(db, workspace.id)).toEqual([]);
});

test("listWorkspacePeople matches who has joined by GitHub id, joined admins first", async () => {
  const workspace = await seedWorkspace(db);
  const bryce = await seedUser(db, "bryce");
  const maya = await seedUser(db, "maya");
  await upsertMembership(db, {
    workspaceId: workspace.id,
    userId: bryce.id,
    role: "member",
    githubAccess: "member",
  });
  await upsertMembership(db, {
    workspaceId: workspace.id,
    userId: maya.id,
    role: "admin",
    githubAccess: "owner",
  });
  await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [
      someone(bryce.githubUserId, "bryce", { "1": "write" }),
      someone(900_041, "alex", { "1": "read" }, "collaborator"),
      someone(900_042, "ting", { "1": "admin" }),
    ],
    complete: true,
    seenAt: at(0),
  });

  const people = await listWorkspacePeople(db, workspace.id);
  expect(people.map((p) => [p.githubLogin, p.userId !== null, p.role])).toEqual([
    ["maya", true, "admin"],
    ["bryce", true, "member"],
    ["alex", false, null],
    ["ting", false, null],
  ]);
  // What Ponzu has of someone who joined wins, and GitHub's fills what it lacks.
  expect(people[1]).toEqual({
    githubUserId: bryce.githubUserId,
    githubLogin: "bryce",
    name: "bryce",
    avatarUrl: "https://avatars.example/bryce",
    githubAccess: "member",
    userId: bryce.id,
    role: "member",
  });
  expect(people[3]).toEqual({
    githubUserId: 900_042,
    githubLogin: "ting",
    name: "TING",
    avatarUrl: "https://avatars.example/ting",
    githubAccess: "member",
    userId: null,
    role: null,
  });
  // Maya joined before any read found her: she is counted once, and so is bryce.
  expect(await countWorkspacePeople(db, [workspace.id])).toEqual([
    { workspaceId: workspace.id, people: 4 },
  ]);
});

test("listRepoPeople is everyone with access to that one repo", async () => {
  const workspace = await seedWorkspace(db);
  const fernwood = await seedRepo(db, workspace.id, "north-brook/fernwood-people");
  const other = await seedRepo(db, workspace.id, "north-brook/other-people");
  const bryce = await seedUser(db, "bryce");
  const ines = await seedUser(db, "ines");
  for (const user of [bryce, ines]) {
    await upsertMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      role: "member",
      githubAccess: "member",
    });
  }
  // Ines has joined and her own answer says she reads fernwood; no read as the App found her.
  await recordRepoAccess(db, [
    { userId: ines.id, repoId: fernwood.id, permission: "read", checkedAt: at(0) },
    { userId: bryce.id, repoId: fernwood.id, permission: "read", checkedAt: at(0) },
  ]);
  await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [
      someone(bryce.githubUserId, "bryce", { [fernwood.githubRepoId]: "write" }),
      someone(900_051, "ting", { [fernwood.githubRepoId]: "admin" }),
      someone(900_052, "sam", { [other.githubRepoId]: "write" }),
    ],
    complete: true,
    seenAt: at(0),
  });

  const people = await listRepoPeople(db, { workspaceId: workspace.id, repoId: fernwood.id });
  expect(people.map((p) => [p.githubLogin, p.permission, p.userId !== null])).toEqual([
    ["bryce", "write", true],
    ["ines", "read", true],
    ["ting", "admin", false],
  ]);
  // A repo of another workspace lists nobody.
  const elsewhere = await seedWorkspace(db);
  expect(await listRepoPeople(db, { workspaceId: elsewhere.id, repoId: fernwood.id })).toEqual([]);
});

test("forgetWorkspacePeople leaves the count unknown again", async () => {
  const workspace = await seedWorkspace(db);
  await recordWorkspacePeople(db, {
    workspaceId: workspace.id,
    people: [someone(900_061, "ting", { "1": "write" })],
    complete: true,
    seenAt: at(0),
  });
  await forgetWorkspacePeople(db, workspace.id);
  expect(await listWorkspacePeople(db, workspace.id)).toEqual([]);
  expect(await countWorkspacePeople(db, [workspace.id])).toEqual([
    { workspaceId: workspace.id, people: null },
  ]);
});
