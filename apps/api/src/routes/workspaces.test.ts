import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTestApp,
  type FakeInstallation,
  type SignedInPerson,
  type TestApp,
} from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

let nextId = 90_000;
const id = () => nextId++;

/**
 * An organization with the App, with its owners and members, and outside collaborators who
 * can reach only its `web` repo, all synced in that order.
 */
async function team(
  login: string,
  {
    owners = [],
    members = [],
    collaborators = [],
  }: { owners?: SignedInPerson[]; members?: SignedInPerson[]; collaborators?: SignedInPerson[] },
) {
  const inOrg = Object.fromEntries(
    [...owners, ...members].map((person) => [person.github.id, "write" as const]),
  );
  const outside = Object.fromEntries(
    collaborators.map((person) => [person.github.id, "read" as const]),
  );
  const installation: FakeInstallation = {
    id: id(),
    account: {
      id: id(),
      login,
      type: "Organization",
      name: `${login[0]!.toUpperCase()}${login.slice(1)}`,
      owners: owners.map((person) => person.github.id),
      members: members.map((person) => person.github.id),
    },
    repositorySelection: "selected",
    repositories: [
      { id: id(), fullName: `${login}/web`, access: { ...inOrg, ...outside } },
      { id: id(), fullName: `${login}/api`, access: inOrg },
    ],
  };
  t.github.installations.push(installation);
  const everyone = [...owners, ...members, ...collaborators];
  for (const person of everyone) await sync(person);
  const switcher = await (
    await t.app.request("/v1/workspaces", { headers: everyone[0]!.headers })
  ).json();
  const workspace = switcher.workspaces.find((w: any) => w.githubLogin === login);
  return { installation, workspaceId: workspace.id as string };
}

const sync = (person: SignedInPerson) =>
  t.app.request("/v1/github/sync", { method: "POST", headers: person.headers });

const profile = async (person: SignedInPerson, workspaceId: string) =>
  (await t.app.request(`/v1/workspaces/${workspaceId}`, { headers: person.headers })).json();

const setRole = (person: SignedInPerson, workspaceId: string, userId: string, role: string) =>
  t.app.request(`/v1/workspaces/${workspaceId}/members/${userId}`, {
    method: "PATCH",
    headers: { ...person.headers, "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });

describe("GET /v1/workspaces", () => {
  test("the switcher: the person's own account first, then their teams by name", async () => {
    const dot = await t.signInAs({ login: "dot" });
    t.github.installations.push({
      id: id(),
      account: { id: dot.github.id, login: "dot", type: "User" },
      repositorySelection: "all",
      repositories: [],
    });
    await team("zinc", { owners: [dot] });
    await team("amber", { owners: [dot] });

    const response = await t.app.request("/v1/workspaces", { headers: dot.headers });

    expect(response.status).toBe(200);
    const { workspaces } = await response.json();
    expect(workspaces.map((w: any) => [w.githubLogin, w.kind, w.role])).toEqual([
      ["dot", "personal", "admin"],
      ["amber", "org", "admin"],
      ["zinc", "org", "admin"],
    ]);
    expect(workspaces[1]).toEqual({
      id: expect.stringMatching(/^ws_/),
      githubAccountId: expect.any(Number),
      githubLogin: "amber",
      name: "Amber",
      kind: "org",
      avatarUrl: null,
      role: "admin",
      installed: true,
      suspended: false,
    });
  });
});

describe("GET /v1/workspaces/:id", () => {
  test("a member sees the profile, the installation, the repos and everyone's role", async () => {
    const eli = await t.signInAs({ login: "eli", name: "Eli Ek" });
    const fen = await t.signInAs({ login: "fen", name: null });
    const { installation, workspaceId } = await team("northwind", {
      owners: [eli],
      members: [fen],
    });

    const response = await t.app.request(`/v1/workspaces/${workspaceId}`, { headers: fen.headers });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workspace).toMatchObject({
      id: workspaceId,
      githubLogin: "northwind",
      name: "Northwind",
      role: "member",
      installation: {
        id: installation.id,
        repositorySelection: "selected",
        installedBy: null,
        suspendedAt: null,
      },
    });
    expect(body.repos.map((repo: any) => [repo.name, repo.fullName, repo.canPush]).sort()).toEqual([
      ["api", "northwind/api", true],
      ["web", "northwind/web", true],
    ]);
    expect(body.members).toEqual([
      {
        userId: eli.userId,
        githubLogin: "eli",
        name: "Eli Ek",
        avatarUrl: "https://avatars.example/eli",
        role: "admin",
        githubAccess: "owner",
      },
      {
        userId: fen.userId,
        githubLogin: "fen",
        name: null,
        avatarUrl: "https://avatars.example/fen",
        role: "member",
        githubAccess: "member",
      },
    ]);
    // Nothing of the billing side of the row comes with it.
    expect(JSON.stringify(body)).not.toContain("stripe");
  });

  test("an outside collaborator sees only the repos shared with them, and only themselves", async () => {
    const oak = await t.signInAs({ login: "oak" });
    const pip = await t.signInAs({ login: "pip" });
    const { workspaceId } = await team("hiddenco", { owners: [oak], collaborators: [pip] });

    const body = await profile(pip, workspaceId);

    expect(body.workspace.role).toBe("member");
    expect(body.repos.map((repo: any) => [repo.fullName, repo.canPush])).toEqual([
      ["hiddenco/web", false],
    ]);
    expect(body.members.map((member: any) => member.userId)).toEqual([pip.userId]);
    // The owner sees every repo, and everyone.
    const owners = await profile(oak, workspaceId);
    expect(owners.repos).toHaveLength(2);
    expect(owners.members).toHaveLength(2);
  });

  test("a workspace someone is not in is not found, the same as one that does not exist", async () => {
    const gia = await t.signInAs({ login: "gia" });
    const outsider = await t.signInAs({ login: "outsider" });
    const { workspaceId } = await team("private-co", { owners: [gia] });

    for (const path of [`/v1/workspaces/${workspaceId}`, "/v1/workspaces/ws_nothing"]) {
      const response = await t.app.request(path, { headers: outsider.headers });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("not_found");
    }
  });
});

describe("PATCH /v1/workspaces/:id/members/:userId", () => {
  test("an admin sets roles, and a later sync keeps them", async () => {
    const hu = await t.signInAs({ login: "hu" });
    const ida = await t.signInAs({ login: "ida" });
    const { workspaceId } = await team("rolesetco", { owners: [hu], members: [ida] });

    const promoted = await setRole(hu, workspaceId, ida.userId, "admin");

    expect(promoted.status).toBe(200);
    expect((await promoted.json()).member).toMatchObject({ userId: ida.userId, role: "admin" });
    await sync(ida);
    expect((await profile(ida, workspaceId)).workspace.role).toBe("admin");

    // And back.
    expect((await setRole(hu, workspaceId, ida.userId, "member")).status).toBe(200);
    await sync(ida);
    expect((await profile(ida, workspaceId)).workspace.role).toBe("member");
  });

  test("a member may not set roles", async () => {
    const jun = await t.signInAs({ login: "jun" });
    const kai = await t.signInAs({ login: "kai" });
    const { workspaceId } = await team("memberco", { owners: [jun], members: [kai] });

    const response = await setRole(kai, workspaceId, kai.userId, "admin");

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  test("an owner of the account is always an admin, whoever asks", async () => {
    const own = await t.signInAs({ login: "own" });
    const adm = await t.signInAs({ login: "adm" });
    const { workspaceId } = await team("ownerco", { owners: [own], members: [adm] });
    await setRole(own, workspaceId, adm.userId, "admin");

    for (const asker of [adm, own]) {
      const response = await setRole(asker, workspaceId, own.userId, "member");
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("owner_is_admin");
    }
    expect((await profile(own, workspaceId)).workspace.role).toBe("admin");
  });

  test("a collaborator in before the owner cannot take their own account from them", async () => {
    const owner = await t.signInAs({ login: "owneracct" });
    const collab = await t.signInAs({ login: "collabacct" });
    t.github.installations.push({
      id: id(),
      account: { id: owner.github.id, login: "owneracct", type: "User" },
      repositorySelection: "all",
      repositories: [
        {
          id: id(),
          fullName: "owneracct/secret-acquisition",
          access: { [owner.github.id]: "write" },
        },
        {
          id: id(),
          fullName: "owneracct/shared",
          access: { [owner.github.id]: "write", [collab.github.id]: "read" },
        },
      ],
    });
    // The owner installed from github.com; the collaborator happened to sync first.
    await sync(collab);
    await sync(owner);
    const [workspace] = (
      await (await t.app.request("/v1/workspaces", { headers: collab.headers })).json()
    ).workspaces;

    const takeover = await setRole(collab, workspace.id, owner.userId, "member");
    expect(takeover.status).toBe(403);
    expect((await setRole(collab, workspace.id, collab.userId, "admin")).status).toBe(403);

    expect((await profile(owner, workspace.id)).workspace.role).toBe("admin");
    const seen = await profile(collab, workspace.id);
    expect(seen.workspace.role).toBe("member");
    expect(seen.repos.map((repo: any) => repo.fullName)).toEqual(["owneracct/shared"]);
  });

  test("the last admin cannot be demoted, by anyone", async () => {
    // Nobody who owns the organization has signed in: its first member in is its admin.
    const max = await t.signInAs({ login: "max" });
    const lea = await t.signInAs({ login: "lea" });
    const { workspaceId } = await team("lastadminco", { members: [max, lea] });

    const response = await setRole(max, workspaceId, max.userId, "member");

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("last_admin");

    // With a second admin, the first can step down.
    await setRole(max, workspaceId, lea.userId, "admin");
    expect((await setRole(max, workspaceId, max.userId, "member")).status).toBe(200);
    expect((await setRole(lea, workspaceId, lea.userId, "member")).status).toBe(409);
  });

  test("someone who is not a member is not found; a role that does not exist is refused", async () => {
    const nia = await t.signInAs({ login: "nia" });
    const elsewhere = await t.signInAs({ login: "elsewhere" });
    const { workspaceId } = await team("notmemberco", { owners: [nia] });

    expect((await setRole(nia, workspaceId, elsewhere.userId, "admin")).status).toBe(404);
    expect((await setRole(nia, workspaceId, nia.userId, "owner")).status).toBe(400);
  });
});
