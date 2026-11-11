import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import {
  createDesign,
  getWorkspaceByInstallation,
  listWorkspacePeople,
  repos,
  users,
  workspacePeople,
  workspaces,
} from "@ponzu/db";
import type { FakeGithubUser } from "../testing/fake-github.ts";
import {
  createTestApp,
  type FakeInstallation,
  type SignedInPerson,
  type TestApp,
} from "../testing/index.ts";
import { reconcileInstallation } from "./installations.ts";
import { MAX_PEOPLE_REPOS, PEOPLE_AFTER_MS } from "./people.ts";
import { syncGithub } from "./sync.ts";

/*
 * Who can reach a workspace, as GitHub says, whether or not they have opened Ponzu: what the
 * "Where do you design?" count, Settings › Members and Share are made from.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

let nextId = 140_000;
const id = () => nextId++;

/** Someone on GitHub who has never opened Ponzu. */
function onGithubOnly(login: string, name: string | null = null): FakeGithubUser {
  return t.github.addUser({
    id: id(),
    login,
    name,
    avatarUrl: `https://avatars.example/${login}`,
    emails: [],
  });
}

type Someone = SignedInPerson | FakeGithubUser;
const githubIdOf = (who: Someone) => ("github" in who ? who.github.id : who.id);

/**
 * An installation on an organization. Owners and members are in the organization;
 * collaborators only have repos shared with them. `access` says who can reach each repo; by
 * default everyone given can push to its one repo.
 */
function installOnOrg(
  login: string,
  {
    owners = [],
    members = [],
    collaborators = [],
    repos,
  }: {
    owners?: Someone[];
    members?: Someone[];
    collaborators?: Someone[];
    repos?: Record<string, [Someone, "read" | "write"][]>;
  },
): FakeInstallation {
  const everyone = [...owners, ...members, ...collaborators];
  const layout = repos ?? { app: everyone.map((who) => [who, "write"] as [Someone, "write"]) };
  const installation: FakeInstallation = {
    id: id(),
    account: {
      id: id(),
      login,
      type: "Organization",
      name: login[0]!.toUpperCase() + login.slice(1),
      owners: owners.map(githubIdOf),
      members: members.map(githubIdOf),
    },
    repositorySelection: "selected",
    repositories: Object.entries(layout).map(([name, access], index) => ({
      id: id(),
      fullName: `${login}/${name}`,
      // Most recently pushed first, in the order given.
      pushedAt: new Date(Date.UTC(2026, 9, 1) - index * 60_000),
      access: Object.fromEntries(access.map(([who, can]) => [githubIdOf(who), can])),
    })),
  };
  t.github.installations.push(installation);
  return installation;
}

const sync = (person: SignedInPerson) => syncGithub(t.deps, person.userId);

async function workspaceOf(installation: FakeInstallation) {
  const workspace = await getWorkspaceByInstallation(t.db, installation.id);
  if (!workspace) throw new Error("no workspace for that installation");
  return workspace;
}

async function peopleOf(installation: FakeInstallation) {
  const workspace = await workspaceOf(installation);
  return (await listWorkspacePeople(t.db, workspace.id)).map((person) => person.githubLogin);
}

async function accountsFor(person: SignedInPerson) {
  const response = await t.app.request("/v1/github/accounts", { headers: person.headers });
  expect(response.status).toBe(200);
  const { accounts } = (await response.json()) as {
    accounts: { login: string; memberCount: number | null }[];
  };
  return Object.fromEntries(accounts.map((account) => [account.login, account.memberCount]));
}

async function profileFor(person: SignedInPerson, workspaceId: string) {
  const response = await t.app.request(`/v1/workspaces/${workspaceId}`, {
    headers: person.headers,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    members: { userId: string; githubLogin: string }[];
    people: {
      githubUserId: number;
      githubLogin: string;
      name: string | null;
      avatarUrl: string | null;
      joined: boolean;
      userId: string | null;
      role: string | null;
      githubAccess: string;
    }[];
  };
}

/** Post a delivery as GitHub would, and wait for the work it started. */
async function deliver(event: string, payload: unknown) {
  const response = await t.app.request("/v1/github/webhook", t.github.delivery(event, payload));
  await t.backgroundDone();
  return response;
}

describe("who can reach an organization's workspace", () => {
  test("is everyone GitHub gives access to its repos, whether or not they opened Ponzu", async () => {
    const bryce = await t.signInAs({ login: "bryce-p" });
    const ting = onGithubOnly("ting-p", "Ting Gao");
    const alex = onGithubOnly("alex-p");
    // In the organization, with no access to any installed repo: not in the workspace.
    const idle = onGithubOnly("idle-p");
    const org = installOnOrg("brookco", {
      owners: [bryce, ting],
      members: [idle],
      collaborators: [alex],
      repos: {
        app: [
          [bryce, "write"],
          [ting, "write"],
          [alex, "read"],
        ],
      },
    });

    await sync(bryce);

    expect(await accountsFor(bryce)).toEqual({ "bryce-p": null, brookco: 3 });
    const workspace = await workspaceOf(org);
    const profile = await profileFor(bryce, workspace.id);
    // Unchanged for an app that reads `members`: who has opened Ponzu.
    expect(profile.members.map((member) => member.githubLogin)).toEqual(["bryce-p"]);
    expect(
      profile.people.map((person) => [
        person.githubLogin,
        person.joined,
        person.role,
        person.githubAccess,
      ]),
    ).toEqual([
      ["bryce-p", true, "admin", "owner"],
      ["alex-p", false, null, "collaborator"],
      ["ting-p", false, null, "owner"],
    ]);
    expect(profile.people[2]).toEqual({
      githubUserId: ting.id,
      githubLogin: "ting-p",
      name: "Ting Gao",
      avatarUrl: "https://avatars.example/ting-p",
      joined: false,
      userId: null,
      role: null,
      githubAccess: "owner",
    });
  });

  test("someone who signs in later is the same person, found by their GitHub id", async () => {
    const ines = await t.signInAs({ login: "ines-p" });
    // Sam is on GitHub, and has not opened Ponzu: the sign-in stops before the exchange.
    const samStarted = await t.startSignIn({ login: "sam-p" });
    const sam = samStarted.github;
    const org = installOnOrg("samco", { members: [ines, sam] });
    await sync(ines);
    expect(await peopleOf(org)).toEqual(["ines-p", "sam-p"]);
    const workspace = await workspaceOf(org);
    expect(
      (await listWorkspacePeople(t.db, workspace.id)).map((person) => person.userId !== null),
    ).toEqual([true, false]);

    // Sam opens Ponzu.
    const response = await t.app.request("/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: samStarted.code, code_verifier: samStarted.codeVerifier }),
    });
    expect(response.status).toBe(200);
    await t.backgroundDone();

    const samUser = (await t.db.select().from(users)).find((row) => row.githubUserId === sam.id);
    const people = await listWorkspacePeople(t.db, workspace.id);
    expect(people.map((person) => [person.githubLogin, person.userId])).toEqual([
      ["ines-p", ines.userId],
      ["sam-p", samUser!.id],
    ]);
    // Counted once.
    expect(await accountsFor(ines)).toMatchObject({ samco: 2 });
  });

  test("is read once for the whole installation, not once per person", async () => {
    const lee = await t.signInAs({ login: "lee-p" });
    const others = Array.from({ length: 6 }, (_, index) => onGithubOnly(`crowd-${index}`));
    const org = installOnOrg("crowdco", {
      members: [lee, ...others],
      repos: {
        web: [[lee, "write"], ...others.map((who) => [who, "write"] as [Someone, "write"])],
        api: [[lee, "read"]],
      },
    });
    const before = t.github.peopleRequests.length;

    await sync(lee);

    expect(t.github.peopleRequests.slice(before).toSorted()).toEqual([
      "org crowdco",
      "repo crowdco/api",
      "repo crowdco/web",
    ]);
    expect(await peopleOf(org)).toHaveLength(7);

    // Within the hour, a sync that reads the installation again leaves its people be.
    t.clock.advance(10 * 60_000);
    await sync(lee);
    expect(t.github.peopleRequests.length - before).toBe(3);
    t.clock.advance(PEOPLE_AFTER_MS);
    await sync(lee);
    expect(t.github.peopleRequests.length - before).toBe(6);
  });

  test("someone who loses access between reads is gone after the webhook says so", async () => {
    const ana = await t.signInAs({ login: "ana-p" });
    const leaving = onGithubOnly("leaving-p");
    const org = installOnOrg("leaveco", { members: [ana, leaving] });
    await sync(ana);
    expect(await peopleOf(org)).toEqual(["ana-p", "leaving-p"]);

    delete org.repositories[0]!.access[leaving.id];
    org.account.members = [ana.github.id];
    const response = await deliver("organization", {
      action: "member_removed",
      membership: { user: { id: leaving.id } },
      installation: { id: org.id },
    });
    expect(response.status).toBe(202);

    expect(await peopleOf(org)).toEqual(["ana-p"]);
    expect(await accountsFor(ana)).toMatchObject({ leaveco: 1 });
  });

  test("a collaborator added on GitHub is in at once, by the member webhook", async () => {
    const kim = await t.signInAs({ login: "kim-p" });
    const org = installOnOrg("addco", { members: [kim] });
    await sync(kim);
    expect(await peopleOf(org)).toEqual(["kim-p"]);

    const guest = onGithubOnly("guest-p");
    org.repositories[0]!.access[guest.id] = "read";
    await deliver("member", {
      action: "added",
      member: { id: guest.id },
      installation: { id: org.id },
    });

    // Who has opened Ponzu first.
    expect(await peopleOf(org)).toEqual(["kim-p", "guest-p"]);
  });

  test("a list cut short adds who it found and drops nobody", async () => {
    const ray = await t.signInAs({ login: "ray-p" });
    const many = Array.from({ length: 12 }, (_, index) => onGithubOnly(`many-${index}`));
    const org = installOnOrg("manyco", { members: [ray, ...many] });
    await sync(ray);
    expect(await peopleOf(org)).toHaveLength(13);

    // GitHub hands over one person a page: the API reads ten pages and stops.
    t.github.peoplePageSize = 1;
    try {
      delete org.repositories[0]!.access[many[11]!.id];
      await reconcileInstallation(t.deps, org.id, { people: "refresh" });
    } finally {
      t.github.peoplePageSize = 100;
    }

    expect(await peopleOf(org)).toHaveLength(13);
    expect((await workspaceOf(org)).peopleComplete).toBe(false);
    expect(t.logs.some((line) => line.event === "github_people_cut_short")).toBe(true);

    // Read whole again, the one who left is gone.
    await reconcileInstallation(t.deps, org.id, { people: "refresh" });
    expect(await peopleOf(org)).toHaveLength(12);
  });

  test(`reads at most ${MAX_PEOPLE_REPOS} repos, the most recently pushed, and says it stopped`, async () => {
    const zoe = await t.signInAs({ login: "zoe-p" });
    const old = onGithubOnly("old-p");
    const layout: Record<string, [Someone, "read" | "write"][]> = {};
    for (let index = 0; index < MAX_PEOPLE_REPOS; index++) layout[`r${index}`] = [[zoe, "read"]];
    // Pushed longest ago, so past the ones read.
    layout.oldest = [[old, "read"]];
    const org = installOnOrg("wideco", { members: [zoe, old], repos: layout });

    await sync(zoe);

    expect(await peopleOf(org)).toEqual(["zoe-p"]);
    expect((await workspaceOf(org)).peopleComplete).toBe(false);
  });

  test("without members: read granted, it lists the repos' people and is marked cut short", async () => {
    const una = await t.signInAs({ login: "una-p" });
    const pat = onGithubOnly("pat-p");
    const org = installOnOrg("grantco", { members: [una, pat] });
    org.grantsMembers = false;

    await sync(una);

    expect(await peopleOf(org)).toEqual(["una-p", "pat-p"]);
    expect((await workspaceOf(org)).peopleComplete).toBe(false);
  });

  test("a suspended installation keeps its people as last seen, and nobody reads them", async () => {
    const vic = await t.signInAs({ login: "vic-p" });
    const wes = onGithubOnly("wes-p");
    const org = installOnOrg("pauseco", { members: [vic, wes] });
    await sync(vic);

    org.suspendedAt = new Date(t.clock.now());
    const before = t.github.peopleRequests.length;
    await deliver("installation", {
      action: "suspend",
      installation: { id: org.id },
      sender: { id: vic.github.id },
    });

    expect(t.github.peopleRequests.length).toBe(before);
    expect(await peopleOf(org)).toEqual(["vic-p", "wes-p"]);
  });

  test("an uninstalled installation's people are forgotten", async () => {
    const xia = await t.signInAs({ login: "xia-p" });
    const org = installOnOrg("goneco", { members: [xia, onGithubOnly("yan-p")] });
    await sync(xia);
    const workspace = await workspaceOf(org);

    t.github.installations.splice(t.github.installations.indexOf(org), 1);
    await deliver("installation", {
      action: "deleted",
      installation: { id: org.id },
      sender: { id: xia.github.id },
    });

    const kept = (await t.db.select().from(workspacePeople)).filter(
      (row) => row.workspaceId === workspace.id,
    );
    expect(kept).toEqual([]);
    const [row] = (await t.db.select().from(workspaces)).filter((w) => w.id === workspace.id);
    expect(row?.peopleSyncedAt).toBeNull();
  });
});

describe("who can reach a personal account's workspace", () => {
  test("is its person and whoever they shared its repos with", async () => {
    const owner = await t.signInAs({ login: "solo-p" });
    const friend = onGithubOnly("friend-p", "A Friend");
    const installation: FakeInstallation = {
      id: id(),
      account: { id: owner.github.id, login: "solo-p", type: "User" },
      repositorySelection: "all",
      repositories: [
        {
          id: id(),
          fullName: "solo-p/site",
          access: { [owner.github.id]: "write", [friend.id]: "write" },
        },
      ],
    };
    t.github.installations.push(installation);

    await sync(owner);

    const workspace = await workspaceOf(installation);
    const people = await listWorkspacePeople(t.db, workspace.id);
    expect(
      people.map((person) => [person.githubLogin, person.githubAccess, person.userId !== null]),
    ).toEqual([
      ["solo-p", "owner", true],
      ["friend-p", "collaborator", false],
    ]);
    // No members: read asked of a personal account.
    expect(
      t.github.installationTokenRequests
        .filter((request) => request.installationId === installation.id)
        .map((request) => request.body),
    ).toEqual([{ permissions: { metadata: "read" } }, { permissions: { metadata: "read" } }]);
  });
});

describe("what each person is shown", () => {
  test("an outside collaborator sees only themselves, and no count", async () => {
    const host = await t.signInAs({ login: "host-p" });
    const visitor = await t.signInAs({ login: "visitor-p" });
    const org = installOnOrg("visitco", {
      members: [host],
      collaborators: [visitor],
      repos: {
        app: [
          [host, "write"],
          [visitor, "read"],
        ],
        secret: [[host, "write"]],
      },
    });
    await sync(host);
    await sync(visitor);
    const workspace = await workspaceOf(org);

    expect(await accountsFor(visitor)).toMatchObject({ visitco: null });
    expect(await accountsFor(host)).toMatchObject({ visitco: 2 });
    const profile = await profileFor(visitor, workspace.id);
    expect(profile.people.map((person) => person.githubLogin)).toEqual(["visitor-p"]);
  });

  test("Share lists everyone with access to the design's repo, and nobody else", async () => {
    const maya = await t.signInAs({ login: "maya-p" });
    const ines = await t.signInAs({ login: "ines-share" });
    const reader = onGithubOnly("reader-p", "Rita Reader");
    const elsewhere = onGithubOnly("elsewhere-p");
    const org = installOnOrg("shareco", {
      members: [maya, ines, reader, elsewhere],
      repos: {
        fernwood: [
          [maya, "write"],
          [ines, "write"],
          [reader, "read"],
        ],
        other: [[elsewhere, "write"]],
      },
    });
    await sync(maya);
    await sync(ines);
    const workspace = await workspaceOf(org);
    const repoId = await repoIdOf(workspace.id, "shareco/fernwood");
    const design = await createDesign(t.db, {
      workspaceId: workspace.id,
      repoId,
      ownerId: ines.userId,
      claudeAccountId: null,
      name: "Quieter shop hero",
      branch: "pz/quieter-shop-hero",
      doc: emptyDoc("Quieter shop hero"),
    });

    const response = await t.app.request(`/v1/designs/${design.id}/people`, {
      headers: maya.headers,
    });
    expect(response.status).toBe(200);
    const { people } = (await response.json()) as {
      people: { githubLogin: string; joined: boolean; access: string }[];
    };
    expect(people.map((person) => [person.githubLogin, person.joined, person.access])).toEqual([
      ["ines-share", true, "owner"],
      ["maya-p", true, "edit"],
      ["reader-p", false, "view"],
    ]);

    // Someone outside the workspace is told there is no such design.
    const stranger = await t.signInAs({ login: "stranger-p" });
    const refused = await t.app.request(`/v1/designs/${design.id}/people`, {
      headers: stranger.headers,
    });
    expect(refused.status).toBe(404);
  });
});

/** A repo's Ponzu id by its full name. */
async function repoIdOf(workspaceId: string, fullName: string) {
  const repo = (await t.db.select().from(repos)).find(
    (row) => row.workspaceId === workspaceId && row.fullName === fullName,
  );
  if (!repo) throw new Error(`no repo ${fullName}`);
  return repo.id;
}
