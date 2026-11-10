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

/** An organization with the App, its owner, and the people who reach its repos, all synced. */
async function team(login: string, owner: SignedInPerson, members: SignedInPerson[]) {
  const access = Object.fromEntries(
    [owner, ...members].map((person) => [person.github.id, "write" as const]),
  );
  const installation: FakeInstallation = {
    id: id(),
    account: {
      id: id(),
      login,
      type: "Organization",
      name: `${login[0]!.toUpperCase()}${login.slice(1)}`,
      owners: [owner.github.id],
    },
    repositorySelection: "selected",
    repositories: [
      { id: id(), fullName: `${login}/web`, access },
      { id: id(), fullName: `${login}/api`, access },
    ],
  };
  t.github.installations.push(installation);
  for (const person of [owner, ...members]) await sync(person);
  const switcher = await (await t.app.request("/v1/workspaces", { headers: owner.headers })).json();
  const workspace = switcher.workspaces.find((w: any) => w.githubLogin === login);
  return { installation, workspaceId: workspace.id as string };
}

const sync = (person: SignedInPerson) =>
  t.app.request("/v1/github/sync", { method: "POST", headers: person.headers });

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
    await team("zinc", dot, []);
    await team("amber", dot, []);

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
    const { installation, workspaceId } = await team("northwind", eli, [fen]);

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
    expect(body.repos.map((repo: any) => [repo.name, repo.fullName]).sort()).toEqual([
      ["api", "northwind/api"],
      ["web", "northwind/web"],
    ]);
    expect(body.members).toEqual([
      {
        userId: eli.userId,
        githubLogin: "eli",
        name: "Eli Ek",
        avatarUrl: "https://avatars.example/eli",
        role: "admin",
      },
      {
        userId: fen.userId,
        githubLogin: "fen",
        name: null,
        avatarUrl: "https://avatars.example/fen",
        role: "member",
      },
    ]);
    // Nothing of the billing side of the row comes with it.
    expect(JSON.stringify(body)).not.toContain("stripe");
  });

  test("a workspace someone is not in is not found, the same as one that does not exist", async () => {
    const gia = await t.signInAs({ login: "gia" });
    const outsider = await t.signInAs({ login: "outsider" });
    const { workspaceId } = await team("private-co", gia, []);

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
    const { workspaceId } = await team("rolesetco", hu, [ida]);

    const promoted = await setRole(hu, workspaceId, ida.userId, "admin");

    expect(promoted.status).toBe(200);
    expect((await promoted.json()).member).toMatchObject({ userId: ida.userId, role: "admin" });
    await sync(ida);
    const profile = await t.app.request(`/v1/workspaces/${workspaceId}`, { headers: ida.headers });
    expect((await profile.json()).workspace.role).toBe("admin");
  });

  test("a member may not set roles", async () => {
    const jun = await t.signInAs({ login: "jun" });
    const kai = await t.signInAs({ login: "kai" });
    const { workspaceId } = await team("memberco", jun, [kai]);

    const response = await setRole(kai, workspaceId, kai.userId, "admin");

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  test("the last admin cannot be demoted, by anyone", async () => {
    const lea = await t.signInAs({ login: "lea" });
    const max = await t.signInAs({ login: "max" });
    const { workspaceId } = await team("lastadminco", lea, [max]);

    const response = await setRole(lea, workspaceId, lea.userId, "member");

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("last_admin");

    // With a second admin, the first can step down.
    await setRole(lea, workspaceId, max.userId, "admin");
    expect((await setRole(lea, workspaceId, lea.userId, "member")).status).toBe(200);
    expect((await setRole(max, workspaceId, max.userId, "member")).status).toBe(409);
  });

  test("someone who is not a member is not found; a role that does not exist is refused", async () => {
    const nia = await t.signInAs({ login: "nia" });
    const elsewhere = await t.signInAs({ login: "elsewhere" });
    const { workspaceId } = await team("notmemberco", nia, []);

    expect((await setRole(nia, workspaceId, elsewhere.userId, "admin")).status).toBe(404);
    expect((await setRole(nia, workspaceId, nia.userId, "owner")).status).toBe(400);
  });
});
