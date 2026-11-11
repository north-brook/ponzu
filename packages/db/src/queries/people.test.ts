import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { GithubAccess } from "../enums.ts";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { workspaces } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import {
  bestPermission,
  countWorkspacePeople,
  forgetWorkspacePeople,
  type GithubPerson,
  listPeopleRepoReads,
  listRepoPeople,
  listWorkspacePeople,
  type PeopleRepoRead,
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

/** A read of these repos (each whole unless it says), found these people. */
function record(
  workspaceId: string,
  people: GithubPerson[],
  {
    seenAt,
    repos = [{ githubRepoId: 1, complete: true }],
    installedRepoIds = null,
    complete = repos.every((repo) => repo.complete),
  }: {
    seenAt: Date;
    repos?: PeopleRepoRead[];
    installedRepoIds?: number[] | null;
    complete?: boolean;
  },
) {
  return recordWorkspacePeople(db, {
    workspaceId,
    people,
    reposRead: repos,
    installedRepoIds,
    complete,
    seenAt,
  });
}

/** Someone who has opened Ponzu and joined the workspace, reaching it as `access` says. */
async function joined(
  workspaceId: string,
  login: string,
  access: GithubAccess,
  role: "admin" | "member" = "member",
) {
  const user = await seedUser(db, login);
  await upsertMembership(db, { workspaceId, userId: user.id, role, githubAccess: access });
  return user;
}

/** Who `viewer` is shown in a workspace, by login, leaving out the viewer. */
async function shown(workspaceId: string, viewer: { id: string; githubLogin: string }) {
  return (await listWorkspacePeople(db, { workspaceId, viewerUserId: viewer.id }))
    .map((person) => person.githubLogin)
    .filter((login) => login !== viewer.githubLogin);
}

async function countFor(workspaceId: string, viewer: { id: string }) {
  const [row] = await countWorkspacePeople(db, {
    viewerUserId: viewer.id,
    workspaceIds: [workspaceId],
  });
  return row?.people;
}

test("bestPermission is the most any of them allows", () => {
  expect(bestPermission(["read", "admin", "write"])).toBe("admin");
  expect(bestPermission(["read", "write"])).toBe("write");
  expect(bestPermission([])).toBe("none");
});

test("a workspace never read has no count; one read counts everyone it found", async () => {
  const workspace = await seedWorkspace(db);
  const owner = await joined(workspace.id, "owner-a", "owner", "admin");
  expect(await countFor(workspace.id, owner)).toBeNull();

  await record(
    workspace.id,
    [someone(900_001, "ting", { "1": "admin" }), someone(900_002, "sam", { "1": "read" })],
    { seenAt: at(0) },
  );

  // Ting, sam and the owner, who has joined.
  expect(await countFor(workspace.id, owner)).toBe(3);
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id));
  expect(row?.peopleSyncedAt).toEqual(at(0));
  expect(row?.peopleComplete).toBe(true);
});

test("a repo read whole replaces what was known of it; one cut short only adds", async () => {
  const workspace = await seedWorkspace(db);
  const owner = await joined(workspace.id, "owner-b", "owner", "admin");
  const ting = someone(900_011, "ting", { "1": "write" });
  const sam = someone(900_012, "sam", { "1": "write" });
  // Uma reaches only repo 2, which the later reads do not ask about.
  const uma = someone(900_013, "uma", { "2": "read" });
  await record(workspace.id, [ting, sam, uma], {
    seenAt: at(0),
    repos: [
      { githubRepoId: 1, complete: true },
      { githubRepoId: 2, complete: true },
    ],
  });

  await record(workspace.id, [ting], {
    seenAt: at(1),
    repos: [{ githubRepoId: 1, complete: false }],
  });
  expect(await shown(workspace.id, owner)).toEqual(["sam", "ting", "uma"]);

  // Repo 1 read whole without sam: sam reaches nothing else, and is gone. Uma, whose repo
  // was not asked about, stays, though the read was not of every repo.
  await record(workspace.id, [ting], { seenAt: at(2) });
  expect(await shown(workspace.id, owner)).toEqual(["ting", "uma"]);
});

test("someone who reaches two repos stays until both are read without them", async () => {
  const workspace = await seedWorkspace(db);
  const owner = await joined(workspace.id, "owner-c", "owner", "admin");
  const vic = someone(900_021, "vic", { "1": "write", "2": "read" });
  await record(workspace.id, [vic], {
    seenAt: at(0),
    repos: [
      { githubRepoId: 1, complete: true },
      { githubRepoId: 2, complete: true },
    ],
  });
  await record(workspace.id, [], { seenAt: at(1), repos: [{ githubRepoId: 1, complete: true }] });
  expect(await shown(workspace.id, owner)).toEqual(["vic"]);
  await record(workspace.id, [], { seenAt: at(2), repos: [{ githubRepoId: 2, complete: true }] });
  expect(await shown(workspace.id, owner)).toEqual([]);
});

test("a repo the installation no longer has takes its people with it", async () => {
  const workspace = await seedWorkspace(db);
  const owner = await joined(workspace.id, "owner-d", "owner", "admin");
  await record(workspace.id, [someone(900_031, "wes", { "7": "write" })], {
    seenAt: at(0),
    repos: [{ githubRepoId: 7, complete: true }],
  });
  // Repo 7 left the installation: its list is not read, and its entry is dropped.
  await record(workspace.id, [], { seenAt: at(1), repos: [], installedRepoIds: [] });
  expect(await shown(workspace.id, owner)).toEqual([]);
});

test("a read older than the one kept changes nothing", async () => {
  const workspace = await seedWorkspace(db);
  const owner = await joined(workspace.id, "owner-e", "owner", "admin");
  const ting = someone(900_041, "ting", { "1": "write" });
  const sam = someone(900_042, "sam", { "1": "write" });
  expect(await record(workspace.id, [ting], { seenAt: at(5) })).toBe(true);

  // Began before sam lost access, finished after the read that saw it.
  expect(await record(workspace.id, [ting, sam], { seenAt: at(4) })).toBe(false);
  expect(await shown(workspace.id, owner)).toEqual(["ting"]);
});

test("someone found with no permission at all is not written", async () => {
  const workspace = await seedWorkspace(db);
  const owner = await joined(workspace.id, "owner-f", "owner", "admin");
  await record(workspace.id, [someone(900_051, "nobody", {})], { seenAt: at(0) });
  expect(await shown(workspace.id, owner)).toEqual([]);
});

test("the repos asked about are stamped, for the next read to ask the others first", async () => {
  const workspace = await seedWorkspace(db);
  const one = await seedRepo(db, workspace.id, "north-brook/asked-one");
  const two = await seedRepo(db, workspace.id, "north-brook/asked-two");
  await record(workspace.id, [], {
    seenAt: at(3),
    repos: [{ githubRepoId: one.githubRepoId, complete: false }],
  });
  const reads = new Map(
    (await listPeopleRepoReads(db, workspace.id)).map((read) => [
      read.githubRepoId,
      read.peopleReadAt,
    ]),
  );
  expect(reads.get(one.githubRepoId)).toEqual(at(3));
  expect(reads.get(two.githubRepoId)).toBeNull();
});

test("a read that cannot tell how someone reaches it keeps what was known", async () => {
  const workspace = await seedWorkspace(db);
  const owner = await joined(workspace.id, "owner-g", "owner", "admin");
  await record(workspace.id, [someone(900_061, "known", { "1": "write" }, "member")], {
    seenAt: at(0),
  });
  await record(
    workspace.id,
    [
      someone(900_061, "known", { "1": "write" }, null),
      someone(900_062, "unknown", { "1": "write" }, null),
    ],
    { seenAt: at(1) },
  );
  const people = await listWorkspacePeople(db, { workspaceId: workspace.id, viewerUserId: owner.id });
  expect(
    people
      .filter((person) => person.userId === null)
      .map((person) => [person.githubLogin, person.githubAccess]),
  ).toEqual([
    ["known", "member"],
    // Taken for an outside collaborator, who is shown to the fewest.
    ["unknown", "collaborator"],
  ]);
});

test("listWorkspacePeople matches who has joined by GitHub id, joined admins first", async () => {
  const workspace = await seedWorkspace(db);
  const bryce = await joined(workspace.id, "bryce", "member");
  const maya = await joined(workspace.id, "maya", "owner", "admin");
  await record(
    workspace.id,
    [
      someone(bryce.githubUserId, "bryce", { "1": "write" }),
      someone(900_071, "alex", { "1": "read" }, "collaborator"),
      someone(900_072, "ting", { "1": "admin" }),
    ],
    { seenAt: at(0) },
  );

  const people = await listWorkspacePeople(db, { workspaceId: workspace.id, viewerUserId: maya.id });
  expect(people.map((p) => [p.githubLogin, p.userId !== null, p.role])).toEqual([
    ["maya", true, "admin"],
    ["bryce", true, "member"],
    ["alex", false, null],
    ["ting", false, null],
  ]);
  // Their GitHub profile as the App last read it; their role and reach as their own sync said.
  expect(people[1]).toEqual({
    githubUserId: bryce.githubUserId,
    githubLogin: "bryce",
    name: "BRYCE",
    avatarUrl: "https://avatars.example/bryce",
    githubAccess: "member",
    userId: bryce.id,
    role: "member",
  });
  expect(people[3]).toEqual({
    githubUserId: 900_072,
    githubLogin: "ting",
    name: "TING",
    avatarUrl: "https://avatars.example/ting",
    githubAccess: "member",
    userId: null,
    role: null,
  });
  // Maya joined before any read found her: she is counted once, and so is bryce.
  expect(await countFor(workspace.id, maya)).toBe(4);
});

test("a login renamed on GitHub shows the new one before its person signs in again", async () => {
  const workspace = await seedWorkspace(db);
  const owner = await joined(workspace.id, "owner-h", "owner", "admin");
  const renamed = await joined(workspace.id, "old-name", "member");
  await record(workspace.id, [someone(renamed.githubUserId, "new-name", { "1": "write" })], {
    seenAt: at(0),
  });
  expect(await shown(workspace.id, owner)).toEqual(["new-name"]);
});

test("each is shown only whom GitHub would show them", async () => {
  const workspace = await seedWorkspace(db);
  const app = await seedRepo(db, workspace.id, "leakco/app");
  const secret = await seedRepo(db, workspace.id, "leakco/secret");
  const owner = await joined(workspace.id, "own-q", "owner", "admin");
  const member = await joined(workspace.id, "mem-q", "member");
  const pusher = await joined(workspace.id, "push-q", "member");
  const guest = await joined(workspace.id, "guest-q", "collaborator");
  await recordRepoAccess(db, [
    { userId: member.id, repoId: app.id, permission: "write", checkedAt: at(0) },
    { userId: member.id, repoId: secret.id, permission: "none", checkedAt: at(0) },
    { userId: pusher.id, repoId: secret.id, permission: "write", checkedAt: at(0) },
    { userId: guest.id, repoId: app.id, permission: "read", checkedAt: at(0) },
  ]);
  const a = String(app.githubRepoId);
  const s = String(secret.githubRepoId);
  await record(
    workspace.id,
    [
      someone(owner.githubUserId, "own-q", { [a]: "admin", [s]: "admin" }, "owner"),
      someone(member.githubUserId, "mem-q", { [a]: "write" }),
      someone(pusher.githubUserId, "push-q", { [s]: "write" }),
      someone(guest.githubUserId, "guest-q", { [a]: "read" }, "collaborator"),
      someone(900_081, "contractor-q", { [s]: "write" }, "collaborator"),
    ],
    {
      seenAt: at(0),
      repos: [
        { githubRepoId: app.githubRepoId, complete: true },
        { githubRepoId: secret.githubRepoId, complete: true },
      ],
    },
  );

  expect(await shown(workspace.id, owner)).toEqual([
    "guest-q",
    "mem-q",
    "push-q",
    "contractor-q",
  ]);
  // Mem-q cannot see the secret repo: not its contractor. The guest shares app, which mem-q
  // can push to, so GitHub shows mem-q the guest.
  expect(await shown(workspace.id, member)).toEqual(["own-q", "guest-q", "push-q"]);
  expect(await countFor(workspace.id, member)).toBe(4);
  // Push-q pushes to secret, not app: the contractor, and not the guest.
  expect(await shown(workspace.id, pusher)).toEqual(["own-q", "mem-q", "contractor-q"]);
  expect(await shown(workspace.id, guest)).toEqual([]);
  expect(await countFor(workspace.id, guest)).toBe(1);
});

test("listRepoPeople is everyone with access to that one repo, as each is shown it", async () => {
  const workspace = await seedWorkspace(db);
  const fernwood = await seedRepo(db, workspace.id, "north-brook/fernwood-people");
  const other = await seedRepo(db, workspace.id, "north-brook/other-people");
  const bryce = await joined(workspace.id, "bryce", "member");
  const ines = await joined(workspace.id, "ines", "member");
  const left = await joined(workspace.id, "left", "member");
  const owner = await joined(workspace.id, "owner-i", "owner", "admin");
  // Ines has joined and her own answer says she reads fernwood; no read as the App found her.
  // Left's own answer, newer than the App's read, says she lost it.
  await recordRepoAccess(db, [
    { userId: ines.id, repoId: fernwood.id, permission: "read", checkedAt: at(0) },
    { userId: bryce.id, repoId: fernwood.id, permission: "write", checkedAt: at(0) },
    { userId: left.id, repoId: fernwood.id, permission: "none", checkedAt: at(1) },
  ]);
  const f = String(fernwood.githubRepoId);
  await record(
    workspace.id,
    [
      someone(bryce.githubUserId, "bryce", { [f]: "read" }),
      someone(left.githubUserId, "left", { [f]: "write" }),
      someone(900_091, "ting", { [f]: "admin" }),
      someone(900_092, "sam", { [other.githubRepoId]: "write" }),
      someone(900_093, "guest", { [f]: "write" }, "collaborator"),
    ],
    {
      seenAt: at(0),
      repos: [
        { githubRepoId: fernwood.githubRepoId, complete: true },
        { githubRepoId: other.githubRepoId, complete: true },
      ],
    },
  );

  const asOwner = await listRepoPeople(db, {
    workspaceId: workspace.id,
    repoId: fernwood.id,
    viewerUserId: owner.id,
  });
  // Bryce's own answer wins over the App's read; left's says none, so she is not listed.
  expect(asOwner.map((p) => [p.githubLogin, p.permission, p.userId !== null])).toEqual([
    ["bryce", "write", true],
    ["ines", "read", true],
    ["guest", "write", false],
    ["ting", "admin", false],
  ]);
  // Ines can only read fernwood: GitHub does not show her its outside collaborators.
  const asReader = await listRepoPeople(db, {
    workspaceId: workspace.id,
    repoId: fernwood.id,
    viewerUserId: ines.id,
  });
  expect(asReader.map((p) => p.githubLogin)).toEqual(["bryce", "ines", "ting"]);
  // A repo of another workspace lists nobody.
  const elsewhere = await seedWorkspace(db);
  expect(
    await listRepoPeople(db, {
      workspaceId: elsewhere.id,
      repoId: fernwood.id,
      viewerUserId: owner.id,
    }),
  ).toEqual([]);
});

test("forgetWorkspacePeople leaves the count unknown again", async () => {
  const workspace = await seedWorkspace(db);
  const owner = await joined(workspace.id, "owner-j", "owner", "admin");
  await record(workspace.id, [someone(900_101, "ting", { "1": "write" })], { seenAt: at(0) });
  await forgetWorkspacePeople(db, workspace.id);
  expect(await shown(workspace.id, owner)).toEqual([]);
  expect(await countFor(workspace.id, owner)).toBeNull();
});
