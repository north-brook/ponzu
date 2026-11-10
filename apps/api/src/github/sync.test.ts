import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import {
  createDesign,
  getDesign,
  getWorkspaceByInstallation,
  listUserWorkspaces,
  listWorkspaceRepos,
  memberships,
  repos,
  setMemberRole,
  upsertWorkspace,
  workspaces,
} from "@ponzu/db";
import {
  createTestApp,
  type FakeInstallation,
  type FakeRepository,
  type SignedInPerson,
  type TestApp,
} from "../testing/index.ts";
import { reconcileInstallation } from "./installations.ts";
import { syncGithub } from "./sync.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

let nextId = 50_000;
const id = () => nextId++;

/** Long enough that a sync reads an installation again as the App. */
const LATER = 10 * 60_000;

/**
 * An installation of the App on an organization. Its owners and members are in the
 * organization; its collaborators only have its repos shared with them. Everyone given can
 * reach every repo unless the test says otherwise.
 */
function installOnOrg(
  login: string,
  {
    owners = [],
    members = [],
    collaborators = [],
    name = null,
    repoNames = ["app"],
  }: {
    owners?: SignedInPerson[];
    members?: SignedInPerson[];
    collaborators?: SignedInPerson[];
    name?: string | null;
    repoNames?: string[];
  } = {},
): FakeInstallation {
  const everyone = [...owners, ...members, ...collaborators];
  const installation: FakeInstallation = {
    id: id(),
    account: {
      id: id(),
      login,
      type: "Organization",
      name,
      owners: owners.map((person) => person.github.id),
      members: members.map((person) => person.github.id),
    },
    repositorySelection: "selected",
    repositories: repoNames.map((repo) => ({
      id: id(),
      fullName: `${login}/${repo}`,
      access: Object.fromEntries(everyone.map((person) => [person.github.id, "write" as const])),
    })),
  };
  t.github.installations.push(installation);
  return installation;
}

function installOnPerson(person: SignedInPerson, repoNames = ["site"]): FakeInstallation {
  const installation: FakeInstallation = {
    id: id(),
    account: { id: person.github.id, login: person.github.login, type: "User" },
    repositorySelection: "all",
    repositories: repoNames.map((repo) => ({
      id: id(),
      fullName: `${person.github.login}/${repo}`,
      access: { [person.github.id]: "write" },
    })),
  };
  t.github.installations.push(installation);
  return installation;
}

const sync = (person: SignedInPerson) => syncGithub(t.deps, person.userId);

async function rolesOf(person: SignedInPerson) {
  return Object.fromEntries(
    (await listUserWorkspaces(t.db, person.userId)).map((workspace) => [
      workspace.githubLogin,
      workspace.role,
    ]),
  );
}

/** Every repo of a workspace Ponzu has, and whether it is still there. */
async function reposOf(workspaceId: string) {
  const rows = (await t.db.select().from(repos)).filter((repo) => repo.workspaceId === workspaceId);
  return Object.fromEntries(rows.map((repo) => [repo.fullName, repo.removedAt === null]));
}

/** The repos of a workspace one person is shown. */
async function seenBy(person: SignedInPerson, workspaceId: string) {
  const listed = await listWorkspaceRepos(t.db, { workspaceId, userId: person.userId });
  return listed.map((repo) => repo.fullName).sort();
}

const uninstall = (installation: FakeInstallation) =>
  t.github.installations.splice(t.github.installations.indexOf(installation), 1);

describe("from nothing", () => {
  test("a person's own account and the organizations they reach become workspaces", async () => {
    const ana = await t.signInAs({ login: "ana" });
    const other = await t.signInAs({ login: "ana-colleague" });
    installOnPerson(ana);
    const org = installOnOrg("brightline", { members: [ana], name: "Brightline Studio" });
    // A repo Ana cannot see is still the installation's: the workspace has it.
    org.repositories.push({
      id: id(),
      fullName: "brightline/private",
      access: { [other.github.id]: "write" },
    });

    const synced = await sync(ana);

    expect(synced.map((workspace) => workspace.githubLogin).sort()).toEqual(["ana", "brightline"]);
    const brightline = synced.find((workspace) => workspace.githubLogin === "brightline")!;
    expect(brightline).toMatchObject({
      kind: "org",
      name: "Brightline Studio",
      installationId: org.id,
      repositorySelection: "selected",
      suspendedAt: null,
    });
    expect(await reposOf(brightline.id)).toEqual({
      "brightline/app": true,
      "brightline/private": true,
    });
    // But she is shown only what GitHub shows her.
    expect(await seenBy(ana, brightline.id)).toEqual(["brightline/app"]);
    // Her own account; and the first member of an organization with no admin in Ponzu yet.
    expect(await rolesOf(ana)).toEqual({ ana: "admin", brightline: "admin" });
  });

  test("an organization's owners are admins, its members members, however they arrive", async () => {
    const owner = await t.signInAs({ login: "owner-o" });
    const member = await t.signInAs({ login: "member-m" });
    const late = await t.signInAs({ login: "late-l" });
    installOnOrg("ownedco", { owners: [owner], members: [member, late] });

    await sync(owner);
    await sync(member);
    await sync(late);

    expect(await rolesOf(owner)).toEqual({ ownedco: "admin" });
    expect(await rolesOf(member)).toEqual({ ownedco: "member" });
    expect(await rolesOf(late)).toEqual({ ownedco: "member" });
  });

  test("whoever installed the App is an admin of its workspace", async () => {
    const installer = await t.signInAs({ login: "installer-i" });
    const someone = await t.signInAs({ login: "someone-s" });
    const org = installOnOrg("installedco", { owners: [someone], members: [installer] });
    const [workspace] = await sync(someone);
    // As the installation's webhook records it.
    await upsertWorkspace(t.db, {
      ...workspace!,
      installationId: org.id,
      repositorySelection: "selected",
      installedByUserId: installer.userId,
      reconciledAt: undefined,
    });

    await sync(installer);

    expect(await rolesOf(installer)).toEqual({ installedco: "admin" });
  });

  test("someone who reaches nothing has no workspaces, and their own account is not one", async () => {
    const loner = await t.signInAs({ login: "loner" });
    expect(await sync(loner)).toEqual([]);
    expect(await listUserWorkspaces(t.db, loner.userId)).toEqual([]);
  });
});

describe("who can take a workspace", () => {
  test("a collaborator in first is not an admin of someone's own account, and its owner is", async () => {
    const owner = await t.signInAs({ login: "owneracct" });
    const collab = await t.signInAs({ login: "collabacct" });
    const installation = installOnPerson(owner, ["secret-acquisition", "shared"]);
    installation.repositories[1]!.access[collab.github.id] = "read";

    // The owner installed from github.com, and the collaborator came back to Ponzu first.
    const [workspace] = await sync(collab);
    expect(await rolesOf(collab)).toEqual({ owneracct: "member" });
    expect(await seenBy(collab, workspace!.id)).toEqual(["owneracct/shared"]);

    await sync(owner);
    expect(await rolesOf(owner)).toEqual({ owneracct: "admin" });
    expect(await seenBy(owner, workspace!.id)).toEqual([
      "owneracct/secret-acquisition",
      "owneracct/shared",
    ]);
  });

  test("an outside collaborator is never made an organization's admin, a member is", async () => {
    const outsider = await t.signInAs({ login: "outsider-x" });
    const member = await t.signInAs({ login: "member-y" });
    installOnOrg("nobodyco", { members: [member], collaborators: [outsider] });

    await sync(outsider);
    expect(await rolesOf(outsider)).toEqual({ nobodyco: "member" });

    await sync(member);
    expect(await rolesOf(member)).toEqual({ nobodyco: "admin" });
    expect(await rolesOf(outsider)).toEqual({ nobodyco: "member" });
  });

  test("someone made an owner on GitHub is an admin from their next sync", async () => {
    const first = await t.signInAs({ login: "floor-first" });
    const promoted = await t.signInAs({ login: "floor-promoted" });
    const org = installOnOrg("floorco", { owners: [first], members: [promoted] });
    await sync(first);
    await sync(promoted);
    expect(await rolesOf(promoted)).toEqual({ floorco: "member" });

    org.account.owners!.push(promoted.github.id);
    await sync(promoted);

    expect(await rolesOf(promoted)).toEqual({ floorco: "admin" });
  });

  test("a role an admin set is not undone by a later sync", async () => {
    const fay = await t.signInAs({ login: "fay" });
    const gus = await t.signInAs({ login: "gus" });
    const hil = await t.signInAs({ login: "hil" });
    installOnOrg("rolesco", { owners: [fay], members: [gus, hil] });
    const [workspace] = await sync(fay);
    await sync(gus);
    await sync(hil);
    await setMemberRole(t.db, { workspaceId: workspace!.id, userId: gus.userId, role: "admin" });

    await sync(gus);
    await sync(hil);

    expect(await rolesOf(gus)).toEqual({ rolesco: "admin" });
    expect(await rolesOf(hil)).toEqual({ rolesco: "member" });
  });
});

describe("from an earlier sync", () => {
  test("a reinstall comes back to the same workspace and its designs", async () => {
    const bo = await t.signInAs({ login: "bo" });
    const first = installOnOrg("reinstallco", { members: [bo] });
    const [before] = await sync(bo);
    const repo = (await t.db.select().from(repos)).find(
      (candidate) => candidate.workspaceId === before!.id,
    )!;
    const design = await createDesign(t.db, {
      workspaceId: before!.id,
      repoId: repo.id,
      ownerId: bo.userId,
      claudeAccountId: null,
      name: "Checkout",
      branch: "pz/checkout",
      doc: emptyDoc("Checkout"),
    });

    uninstall(first);
    // As its webhook does.
    await reconcileInstallation(t.deps, first.id);
    expect(await sync(bo)).toEqual([]);
    const again = installOnOrg("reinstallco", { members: [bo] });
    again.account.id = first.account.id;
    again.repositories = first.repositories;
    const [after] = await sync(bo);

    expect(after!.id).toBe(before!.id);
    expect(after!.installationId).toBe(again.id);
    expect((await getDesign(t.db, design.id))!.workspaceId).toBe(before!.id);
    expect(await reposOf(before!.id)).toEqual({ "reinstallco/app": true });
  });

  test("losing access drops the membership, and an organization member takes over as admin", async () => {
    const cy = await t.signInAs({ login: "cy" });
    const dee = await t.signInAs({ login: "dee" });
    const org = installOnOrg("leaverco", { members: [cy, dee] });
    await sync(cy);
    await sync(dee);
    expect(await rolesOf(cy)).toEqual({ leaverco: "admin" });

    for (const repository of org.repositories) delete repository.access[cy.github.id];
    org.account.members = [dee.github.id];
    await sync(cy);

    expect(await rolesOf(cy)).toEqual({});
    expect(await rolesOf(dee)).toEqual({ leaverco: "admin" });
  });

  test("the App taken off someone's own account leaves them in its workspace", async () => {
    const solo = await t.signInAs({ login: "solo" });
    const own = installOnPerson(solo);
    const [workspace] = await sync(solo);

    uninstall(own);
    await reconcileInstallation(t.deps, own.id);
    await sync(solo);

    expect(await rolesOf(solo)).toEqual({ solo: "admin" });
    const [kept] = await listUserWorkspaces(t.db, solo.userId);
    expect(kept).toMatchObject({ id: workspace!.id, installationId: null });
    expect(await seenBy(solo, workspace!.id)).toEqual([]);
  });

  test("repos that left the installation are marked removed, and renamed ones follow", async () => {
    const eve = await t.signInAs({ login: "eve" });
    const org = installOnOrg("reposco", { members: [eve], repoNames: ["one", "two"] });
    const [workspace] = await sync(eve);

    org.repositories.pop();
    org.repositories[0]!.fullName = "reposco/uno";
    t.clock.advance(LATER);
    await sync(eve);

    expect(await reposOf(workspace!.id)).toEqual({ "reposco/uno": true, "reposco/two": false });
    expect(await seenBy(eve, workspace!.id)).toEqual(["reposco/uno"]);
  });

  test("losing one repo of an installation stops it being shown, at the next sync", async () => {
    const fin = await t.signInAs({ login: "fin" });
    const org = installOnOrg("narrowco", { members: [fin], repoNames: ["kept", "taken"] });
    const [workspace] = await sync(fin);
    expect(await seenBy(fin, workspace!.id)).toEqual(["narrowco/kept", "narrowco/taken"]);

    delete org.repositories[1]!.access[fin.github.id];
    await sync(fin);

    expect(await seenBy(fin, workspace!.id)).toEqual(["narrowco/kept"]);
  });

  test("a repo the person reaches that Ponzu has not seen has the installation read again", async () => {
    const gil = await t.signInAs({ login: "gil" });
    const org = installOnOrg("newrepoco", { members: [gil] });
    const [workspace] = await sync(gil);

    // Added to the installation; its webhook has not arrived.
    org.repositories.push({
      id: id(),
      fullName: "newrepoco/fresh",
      access: { [gil.github.id]: "read" },
    });
    await sync(gil);

    expect(await seenBy(gil, workspace!.id)).toEqual(["newrepoco/app", "newrepoco/fresh"]);
  });

  test("a suspended installation keeps its workspace, members and repos, marked suspended", async () => {
    const hal = await t.signInAs({ login: "hal" });
    const org = installOnOrg("suspendedco", { members: [hal] });
    const [workspace] = await sync(hal);

    org.suspendedAt = new Date("2026-11-09T08:00:00Z");
    const synced = await sync(hal);

    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ id: workspace!.id, suspendedAt: org.suspendedAt });
    expect(await rolesOf(hal)).toEqual({ suspendedco: "admin" });
    expect(await reposOf(workspace!.id)).toEqual({ "suspendedco/app": true });
    expect(await seenBy(hal, workspace!.id)).toEqual(["suspendedco/app"]);

    org.suspendedAt = null;
    expect((await sync(hal))[0]!.suspendedAt).toBeNull();
  });

  test("a suspended installation Ponzu never saw makes no workspace", async () => {
    const ivy = await t.signInAs({ login: "ivy" });
    const org = installOnOrg("neverseenco", { members: [ivy] });
    org.suspendedAt = new Date();

    expect(await sync(ivy)).toEqual([]);
    const all = await t.db.select().from(workspaces);
    expect(all.find((row) => row.githubLogin === org.account.login)).toBeUndefined();
  });
});

describe("GitHub's budgets", () => {
  test("a person's syncs read the installation as the App only when Ponzu's copy is old", async () => {
    const ned = await t.signInAs({ login: "ned" });
    const org = installOnOrg("tokenco", { members: [ned] });
    const minted = () =>
      t.github.installationTokenRequests.filter(({ installationId }) => installationId === org.id);

    await sync(ned);
    expect(minted()).toEqual([
      { installationId: org.id, body: { permissions: { metadata: "read" } } },
    ]);

    // Focus, focus, focus: the person's own view each time, and nothing of the installation's.
    await sync(ned);
    await sync(ned);
    expect(minted()).toHaveLength(1);

    t.clock.advance(LATER);
    await sync(ned);
    expect(minted()).toHaveLength(2);

    const stored = JSON.stringify(await t.db.select().from(workspaces));
    expect(stored).not.toContain("ghs_");
    expect(JSON.stringify(t.logs)).not.toContain("ghs_");
  });

  test("an installation with hundreds of repos is read to its end", async () => {
    const mo = await t.signInAs({ login: "mo" });
    const repositories: FakeRepository[] = Array.from({ length: 230 }, (_, index) => ({
      id: id(),
      fullName: `bigco/r${index}`,
      access: { [mo.github.id]: "read" },
    }));
    const org = installOnOrg("bigco", { members: [mo], repoNames: [] });
    org.repositories.push(...repositories);

    const [workspace] = await sync(mo);

    expect(Object.keys(await reposOf(workspace!.id))).toHaveLength(230);
    expect(await seenBy(mo, workspace!.id)).toHaveLength(230);
  });

  test("a list longer than the API reads marks nothing past its end removed", async () => {
    const vast = await t.signInAs({ login: "vast" });
    const org = installOnOrg("vastco", { members: [vast], repoNames: [] });
    const repositories: FakeRepository[] = Array.from({ length: 2_001 }, (_, index) => ({
      id: id(),
      fullName: `vastco/r${String(index).padStart(4, "0")}`,
      access: { [vast.github.id]: "read" },
    }));
    org.repositories.push(...repositories);
    const [workspace] = await sync(vast);
    expect(Object.keys(await reposOf(workspace!.id))).toHaveLength(2_000);

    // The last one was seen another way (its webhook, say); it is still there after a read.
    const [last] = await t.db
      .insert(repos)
      .values({
        id: "repo_vast_last",
        workspaceId: workspace!.id,
        githubRepoId: repositories[2_000]!.id,
        fullName: repositories[2_000]!.fullName,
        defaultBranch: "main",
      })
      .returning();
    t.clock.advance(LATER);
    await sync(vast);

    expect((await reposOf(workspace!.id))[last!.fullName]).toBe(true);
    expect(t.logs.some((line) => line.event === "github_repositories_cut_short")).toBe(true);
  }, 30_000);
});

describe("when things go wrong", () => {
  test("two syncs at once leave one of everything", async () => {
    const jo = await t.signInAs({ login: "jo" });
    installOnPerson(jo);
    installOnOrg("twiceco", { members: [jo], repoNames: ["a", "b", "c"] });

    const [one, two] = await Promise.all([sync(jo), sync(jo)]);

    expect(one.map((workspace) => workspace.id).sort()).toEqual(
      two.map((workspace) => workspace.id).sort(),
    );
    const rows = (await t.db.select().from(memberships)).filter((row) => row.userId === jo.userId);
    expect(rows).toHaveLength(2);
    const twiceco = one.find((w) => w.githubLogin === "twiceco")!;
    expect(await reposOf(twiceco.id)).toEqual({
      "twiceco/a": true,
      "twiceco/b": true,
      "twiceco/c": true,
    });
    expect(await seenBy(jo, twiceco.id)).toEqual(["twiceco/a", "twiceco/b", "twiceco/c"]);
  });

  test("a failure partway drops no membership, and running again finishes the job", async () => {
    const kit = await t.signInAs({ login: "kit" });
    const kept = installOnOrg("keptco", { members: [kit] });
    await sync(kit);
    const added = installOnOrg("addedco", { members: [kit] });
    t.github.failNext("/installation/repositories");

    await expect(sync(kit)).rejects.toMatchObject({ status: 500 });
    expect(Object.keys(await rolesOf(kit))).toContain("keptco");

    const synced = await sync(kit);
    expect(synced.map((workspace) => workspace.installationId).sort()).toEqual(
      [kept.id, added.id].sort(),
    );
  });

  test("a token GitHub has revoked is github_reauth_required, and nothing changes", async () => {
    const lu = await t.signInAs({ login: "lu" });
    installOnOrg("revokedco", { members: [lu] });
    await sync(lu);
    t.github.revokeTokens(lu.github.id);

    await expect(sync(lu)).rejects.toMatchObject({ status: 401, code: "github_reauth_required" });
    expect(await rolesOf(lu)).toEqual({ revokedco: "admin" });
  });

  test("an uninstall while a read of the installation is under way is not undone by it", async () => {
    const pat = await t.signInAs({ login: "pat" });
    const org = installOnOrg("raceco", { members: [pat] });
    const [workspace] = await sync(pat);

    // A read of the installation (an earlier webhook's, a sync's) is held mid-way.
    const held = t.github.holdNext("/installation/repositories");
    const slow = reconcileInstallation(t.deps, org.id);
    await held.reached;
    // Meanwhile the App is removed, and its webhook is handled.
    uninstall(org);
    expect(await reconcileInstallation(t.deps, org.id)).toBeNull();
    held.release();

    expect(await slow).toBeNull();
    expect(await getWorkspaceByInstallation(t.db, org.id)).toBeNull();
    expect(await reposOf(workspace!.id)).toEqual({ "raceco/app": false });
  });
});

test("the exchange starts a sync, so a person is in their workspaces once signed in", async () => {
  const fresh = await t.startSignIn({ login: "fresh" });
  installOnOrg("freshco", {
    members: [{ github: fresh.github } as SignedInPerson],
  });

  const person = await t.signInAs({ login: "fresh" });

  expect(await rolesOf(person)).toEqual({ freshco: "admin" });
});

test("a workspace a sync made is the same row an earlier webhook made", async () => {
  const oz = await t.signInAs({ login: "oz" });
  const org = installOnOrg("webhookfirstco", { members: [oz] });
  const early = await upsertWorkspace(t.db, {
    githubAccountId: org.account.id,
    githubLogin: org.account.login,
    kind: "org",
    name: org.account.login,
    avatarUrl: null,
    installationId: org.id,
    repositorySelection: "selected",
    installedByUserId: null,
  });

  const [synced] = await sync(oz);

  expect(synced!.id).toBe(early.id);
});
