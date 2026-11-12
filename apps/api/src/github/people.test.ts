import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import {
  createCanvas,
  getWorkspaceByInstallation,
  listWorkspacePeople,
  repos,
  users,
  workspacePeople,
  workspaces,
} from "@ponzu/db";
import { runDueJobs } from "../jobs/run.ts";
import type { FakeGithubUser } from "../testing/fake-github.ts";
import {
  createTestApp,
  type FakeInstallation,
  type SignedInPerson,
  type TestApp,
} from "../testing/index.ts";
import { reconcileInstallation } from "./installations.ts";
import { MAX_PEOPLE_REPOS, PEOPLE_AFTER_MS, PEOPLE_WINDOW_MS } from "./people.ts";
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

/** A person's sync, and the read of people it starts beside it. */
async function sync(person: SignedInPerson) {
  await syncGithub(t.deps, person.userId);
  await t.backgroundDone();
}

/** The cron at the end of the minute: the reads webhooks recorded are made. */
async function cron() {
  t.clock.advance(PEOPLE_WINDOW_MS);
  await runDueJobs(t.deps, "people-test");
}

async function workspaceOf(installation: FakeInstallation) {
  const workspace = await getWorkspaceByInstallation(t.db, installation.id);
  if (!workspace) throw new Error("no workspace for that installation");
  return workspace;
}

/** Everyone kept for an installation's workspace, as an owner of it would see them. */
async function peopleOf(installation: FakeInstallation) {
  const workspace = await workspaceOf(installation);
  const rows = (await t.db.select().from(workspacePeople)).filter(
    (row) => row.workspaceId === workspace.id,
  );
  const joined = new Set(
    (await t.db.select().from(users))
      .filter((user) => rows.some((row) => row.githubUserId === user.githubUserId))
      .map((user) => user.githubUserId),
  );
  // Who has opened Ponzu first, then by login.
  return rows
    .toSorted(
      (a, b) =>
        Number(joined.has(b.githubUserId)) - Number(joined.has(a.githubUserId)) ||
        a.githubLogin.localeCompare(b.githubLogin),
    )
    .map((row) => row.githubLogin);
}

async function accountsFor(person: SignedInPerson) {
  const response = await t.app.request("/v1/github/accounts", { headers: person.headers });
  expect(response.status).toBe(200);
  const { accounts } = (await response.json()) as {
    accounts: { login: string; memberCount: number | null }[];
  };
  return Object.fromEntries(accounts.map((account) => [account.login, account.memberCount]));
}

const profileRequest = (person: SignedInPerson, workspaceId: string) =>
  t.app.request(`/v1/workspaces/${workspaceId}`, { headers: person.headers });

async function profileFor(person: SignedInPerson, workspaceId: string) {
  const response = await profileRequest(person, workspaceId);
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
    const asInes = { workspaceId: workspace.id, viewerUserId: ines.userId };
    expect(
      (await listWorkspacePeople(t.db, asInes)).map((person) => person.userId !== null),
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
    const people = await listWorkspacePeople(t.db, asInes);
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
    // The read is the cron's, at the end of the minute: the webhook's work does not wait on it.
    expect(await peopleOf(org)).toEqual(["ana-p", "leaving-p"]);

    await cron();
    expect(await peopleOf(org)).toEqual(["ana-p"]);
    expect(await accountsFor(ana)).toMatchObject({ leaveco: 1 });
  });

  test("taking access away never waits on, nor fails with, the read of people", async () => {
    const own = await t.signInAs({ login: "own-o" });
    const leaving = await t.signInAs({ login: "b-q" });
    const org = installOnOrg("orderco", { owners: [own], members: [leaving] });
    await sync(own);
    await sync(leaving);
    const workspace = await workspaceOf(org);
    expect((await profileRequest(leaving, workspace.id)).status).toBe(200);

    delete org.repositories[0]!.access[leaving.github.id];
    org.account.members = [];
    for (let attempt = 0; attempt < 20; attempt++) t.github.failNext("/graphql", 502);
    try {
      const response = await deliver("member", {
        action: "removed",
        member: { id: leaving.github.id },
        installation: { id: org.id },
      });
      expect(response.status).toBe(202);
      // Their access is gone at once, though GitHub would not list anyone's people.
      expect((await profileRequest(leaving, workspace.id)).status).toBe(404);

      await cron();
      // The read failed, and is left to be tried again on its own.
      expect(await peopleOf(org)).toEqual(["b-q", "own-o"]);
    } finally {
      t.github.clearFailures();
    }
  });

  test("a burst of membership webhooks is one read of the installation's people", async () => {
    const lead = await t.signInAs({ login: "lead-p" });
    const team = Array.from({ length: 30 }, (_, index) => onGithubOnly(`team-${index}`));
    const org = installOnOrg("burstco", { owners: [lead], members: team });
    org.repositories[0]!.access = { [lead.github.id]: "write" };
    await sync(lead);
    const before = t.github.peopleRequests.length;

    // A team of thirty added to the repo: thirty deliveries within the minute.
    for (const who of team) {
      org.repositories[0]!.access[who.id] = "write";
      await deliver("membership", {
        action: "added",
        member: { id: who.id },
        installation: { id: org.id },
      });
    }
    await cron();

    expect(
      t.github.peopleRequests.slice(before).filter((request) => request.includes("burstco")),
    ).toEqual(["org burstco", "repo burstco/app"]);
    expect(await peopleOf(org)).toHaveLength(31);
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
    await cron();

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
      await reconcileInstallation(t.deps, org.id, { people: "read" });
    } finally {
      t.github.peoplePageSize = 100;
    }

    expect(await peopleOf(org)).toHaveLength(13);
    expect((await workspaceOf(org)).peopleComplete).toBe(false);
    expect(t.logs.some((line) => line.event === "github_people_cut_short")).toBe(true);

    // Read whole again, the one who left is gone.
    await reconcileInstallation(t.deps, org.id, { people: "read" });
    expect(await peopleOf(org)).toHaveLength(12);
  });

  test(`reads at most ${MAX_PEOPLE_REPOS} repos at a time, and the rest on the next read`, async () => {
    const zoe = await t.signInAs({ login: "zoe-p" });
    const old = onGithubOnly("old-p");
    const layout: Record<string, [Someone, "read" | "write"][]> = {};
    for (let index = 0; index < MAX_PEOPLE_REPOS; index++) layout[`r${index}`] = [[zoe, "read"]];
    // Pushed longest ago, so past the ones read first.
    layout.oldest = [[old, "read"]];
    const org = installOnOrg("wideco", { members: [zoe, old], repos: layout });

    await sync(zoe);
    expect(await peopleOf(org)).toEqual(["zoe-p"]);
    expect((await workspaceOf(org)).peopleComplete).toBe(false);

    // The next read asks about the repo never asked about first.
    const read = async () => {
      t.clock.advance(60_000);
      const before = t.github.peopleRequests.length;
      await reconcileInstallation(t.deps, org.id, { people: "read" });
      return t.github.peopleRequests.slice(before);
    };
    expect(await read()).toContain("repo wideco/oldest");
    expect(await peopleOf(org)).toEqual(["zoe-p", "old-p"]);

    // Old-p loses the one repo they reach: once it comes round to be read again, they are
    // gone, though no read is ever of every repo.
    delete org.repositories.find((repo) => repo.fullName === "wideco/oldest")!.access[old.id];
    expect(await read()).not.toContain("repo wideco/oldest");
    expect(await peopleOf(org)).toEqual(["zoe-p", "old-p"]);
    expect(await read()).toContain("repo wideco/oldest");
    expect(await peopleOf(org)).toEqual(["zoe-p"]);
  });

  test("without members: read granted, it lists the repos' people and drops who leaves", async () => {
    const una = await t.signInAs({ login: "una-p" });
    const pat = onGithubOnly("pat-p");
    const org = installOnOrg("staleco", { members: [una, pat] });
    org.grantsMembers = false;

    await sync(una);
    expect(await peopleOf(org)).toEqual(["una-p", "pat-p"]);

    delete org.repositories[0]!.access[pat.id];
    await reconcileInstallation(t.deps, org.id, { people: "read" });
    expect(await peopleOf(org)).toEqual(["una-p"]);
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
    const people = await listWorkspacePeople(t.db, {
      workspaceId: workspace.id,
      viewerUserId: owner.userId,
    });
    expect(
      people.map((person) => [person.githubLogin, person.githubAccess, person.userId !== null]),
    ).toEqual([
      ["solo-p", "owner", true],
      ["friend-p", "collaborator", false],
    ]);
    expect(await accountsFor(owner)).toEqual({ "solo-p": null });
    // No members: read asked of a personal account.
    const asked = t.github.installationTokenRequests
      .filter((request) => request.installationId === installation.id)
      .map((request) => request.body);
    expect(asked.length).toBeGreaterThan(0);
    for (const body of asked) expect(body).toEqual({ permissions: { metadata: "read" } });
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

  test("a member is not shown an outside collaborator on a repo they cannot read", async () => {
    const owner = await t.signInAs({ login: "own-q" });
    const member = await t.signInAs({ login: "mem-q" });
    const contractor = onGithubOnly("contractor-q", "Secret Contractor");
    const org = installOnOrg("leakco", {
      owners: [owner],
      members: [member],
      collaborators: [contractor],
      repos: {
        app: [
          [owner, "write"],
          [member, "write"],
        ],
        secret: [
          [owner, "write"],
          [contractor, "write"],
        ],
      },
    });
    await sync(owner);
    await sync(member);
    const workspace = await workspaceOf(org);

    // GitHub shows a member the organization's people, and a repo's outside collaborators
    // only to someone who can push to it.
    const asMember = await profileFor(member, workspace.id);
    expect(asMember.people.map((person) => person.githubLogin)).toEqual(["own-q", "mem-q"]);
    expect(await accountsFor(member)).toMatchObject({ leakco: 2 });
    // An owner sees everyone.
    const asOwner = await profileFor(owner, workspace.id);
    expect(asOwner.people.map((person) => person.githubLogin)).toEqual([
      "own-q",
      "mem-q",
      "contractor-q",
    ]);
    expect(await accountsFor(owner)).toMatchObject({ leakco: 3 });
  });

  test("Share does not show someone who can only read the repo its outside collaborators", async () => {
    const writer = await t.signInAs({ login: "writer-s" });
    const reader = await t.signInAs({ login: "reader-s" });
    const guest = onGithubOnly("guest-s", "A Guest");
    const org = installOnOrg("readco", {
      members: [writer, reader],
      collaborators: [guest],
      repos: {
        site: [
          [writer, "write"],
          [reader, "read"],
          [guest, "write"],
        ],
      },
    });
    await sync(writer);
    await sync(reader);
    const workspace = await workspaceOf(org);
    const canvas = await createCanvas(t.db, {
      workspaceId: workspace.id,
      repoId: await repoIdOf(workspace.id, "readco/site"),
      ownerId: writer.userId,
      claudeAccountId: null,
      name: "Calmer pricing",
      branch: "pz/calmer-pricing",
      doc: emptyDoc("Calmer pricing"),
    });
    const shareFor = async (person: SignedInPerson) => {
      const response = await t.app.request(`/v1/canvases/${canvas.id}/people`, {
        headers: person.headers,
      });
      expect(response.status).toBe(200);
      const { people } = (await response.json()) as { people: { githubLogin: string }[] };
      return people.map((p) => p.githubLogin);
    };

    expect(await shareFor(reader)).toEqual(["writer-s", "reader-s"]);
    expect(await shareFor(writer)).toEqual(["writer-s", "reader-s", "guest-s"]);
  });

  test("Share lists everyone with access to the canvas's repo, and nobody else", async () => {
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
    const canvas = await createCanvas(t.db, {
      workspaceId: workspace.id,
      repoId,
      ownerId: ines.userId,
      claudeAccountId: null,
      name: "Quieter shop hero",
      branch: "pz/quieter-shop-hero",
      doc: emptyDoc("Quieter shop hero"),
    });

    const response = await t.app.request(`/v1/canvases/${canvas.id}/people`, {
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

    // Someone outside the workspace is told there is no such canvas.
    const stranger = await t.signInAs({ login: "stranger-p" });
    const refused = await t.app.request(`/v1/canvases/${canvas.id}/people`, {
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
