import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import {
  createDesign,
  getDesign,
  listUserWorkspaces,
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
import { syncGithub } from "./sync.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

let nextId = 50_000;
const id = () => nextId++;

/** An installation of the App on an organization, with repos the given people can reach. */
function installOnOrg(
  login: string,
  {
    reachedBy = [],
    owners = [],
    name = null,
    repoNames = ["app"],
  }: {
    reachedBy?: SignedInPerson[];
    owners?: SignedInPerson[];
    name?: string | null;
    repoNames?: string[];
  } = {},
): FakeInstallation {
  const access = Object.fromEntries(
    [...reachedBy, ...owners].map((person) => [person.github.id, "write" as const]),
  );
  const installation: FakeInstallation = {
    id: id(),
    account: {
      id: id(),
      login,
      type: "Organization",
      name,
      owners: owners.map((owner) => owner.github.id),
    },
    repositorySelection: "selected",
    repositories: repoNames.map((repo) => ({ id: id(), fullName: `${login}/${repo}`, access })),
  };
  t.github.installations.push(installation);
  return installation;
}

function installOnPerson(person: SignedInPerson): FakeInstallation {
  const installation: FakeInstallation = {
    id: id(),
    account: { id: person.github.id, login: person.github.login, type: "User" },
    repositorySelection: "all",
    repositories: [
      {
        id: id(),
        fullName: `${person.github.login}/site`,
        access: { [person.github.id]: "write" },
      },
    ],
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

async function reposOf(workspaceId: string) {
  const rows = (await t.db.select().from(repos)).filter((repo) => repo.workspaceId === workspaceId);
  return Object.fromEntries(rows.map((repo) => [repo.fullName, repo.removedAt === null]));
}

const uninstall = (installation: FakeInstallation) =>
  t.github.installations.splice(t.github.installations.indexOf(installation), 1);

describe("from nothing", () => {
  test("a person's own account and the organizations they reach become workspaces", async () => {
    const ana = await t.signInAs({ login: "ana" });
    const other = await t.signInAs({ login: "ana-colleague" });
    installOnPerson(ana);
    const org = installOnOrg("brightline", { reachedBy: [ana], name: "Brightline Studio" });
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
    // Her own account, and the first person into a workspace with no admin.
    expect(await rolesOf(ana)).toEqual({ ana: "admin", brightline: "admin" });
  });

  test("an organization's owner is its admin, and someone who is not is a member", async () => {
    const owner = await t.signInAs({ login: "owner-o" });
    const member = await t.signInAs({ login: "member-m" });
    installOnOrg("ownedco", { owners: [owner], reachedBy: [member] });

    await sync(member);
    await sync(owner);

    expect(await rolesOf(owner)).toEqual({ ownedco: "admin" });
    // First in, with nobody else there: an admin, so the workspace is never without one.
    expect(await rolesOf(member)).toEqual({ ownedco: "admin" });

    const late = await t.signInAs({ login: "late-l" });
    t.github.installations.find(({ account }) => account.login === "ownedco")!
      .repositories[0]!.access[late.github.id] = "read";
    await sync(late);
    expect(await rolesOf(late)).toEqual({ ownedco: "member" });
  });

  test("whoever installed the App is an admin of its workspace", async () => {
    const installer = await t.signInAs({ login: "installer-i" });
    const someone = await t.signInAs({ login: "someone-s" });
    const org = installOnOrg("installedco", { reachedBy: [installer, someone] });
    const [workspace] = await sync(someone);
    // As the installation's webhook records it.
    await upsertWorkspace(t.db, {
      ...workspace!,
      installationId: org.id,
      repositorySelection: "selected",
      installedByUserId: installer.userId,
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

describe("from an earlier sync", () => {
  test("a reinstall comes back to the same workspace and its designs", async () => {
    const bo = await t.signInAs({ login: "bo" });
    const first = installOnOrg("reinstallco", { reachedBy: [bo] });
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
    expect(await sync(bo)).toEqual([]);
    const again = installOnOrg("reinstallco", { reachedBy: [bo] });
    again.account.id = first.account.id;
    again.repositories = first.repositories;
    const [after] = await sync(bo);

    expect(after!.id).toBe(before!.id);
    expect(after!.installationId).toBe(again.id);
    expect((await getDesign(t.db, design.id))!.workspaceId).toBe(before!.id);
    expect(await reposOf(before!.id)).toEqual({ "reinstallco/app": true });
  });

  test("losing access drops the membership and keeps the workspace for everyone else", async () => {
    const cy = await t.signInAs({ login: "cy" });
    const dee = await t.signInAs({ login: "dee" });
    const org = installOnOrg("leaverco", { reachedBy: [cy, dee] });
    await sync(cy);
    await sync(dee);

    for (const repository of org.repositories) delete repository.access[cy.github.id];
    await sync(cy);

    expect(await rolesOf(cy)).toEqual({});
    // Cy was the admin; Dee, the one left, is now.
    expect(await rolesOf(dee)).toEqual({ leaverco: "admin" });
  });

  test("repos that left the installation are marked removed, and renamed ones follow", async () => {
    const eve = await t.signInAs({ login: "eve" });
    const org = installOnOrg("reposco", { reachedBy: [eve], repoNames: ["one", "two"] });
    const [workspace] = await sync(eve);

    org.repositories.pop();
    org.repositories[0]!.fullName = "reposco/uno";
    await sync(eve);

    expect(await reposOf(workspace!.id)).toEqual({ "reposco/uno": true, "reposco/two": false });
  });

  test("a role an admin set is not undone by a later sync", async () => {
    const fay = await t.signInAs({ login: "fay" });
    const gus = await t.signInAs({ login: "gus" });
    const org = installOnOrg("rolesco", { owners: [fay], reachedBy: [gus] });
    const [workspace] = await sync(fay);
    await sync(gus);
    await setMemberRole(t.db, { workspaceId: workspace!.id, userId: gus.userId, role: "admin" });
    await setMemberRole(t.db, { workspaceId: workspace!.id, userId: fay.userId, role: "member" });

    await sync(fay);
    await sync(gus);

    expect(org.account.owners).toContain(fay.github.id);
    expect(await rolesOf(fay)).toEqual({ rolesco: "member" });
    expect(await rolesOf(gus)).toEqual({ rolesco: "admin" });
  });

  test("a suspended installation keeps its workspace, members and repos, marked suspended", async () => {
    const hal = await t.signInAs({ login: "hal" });
    const org = installOnOrg("suspendedco", { reachedBy: [hal] });
    const [workspace] = await sync(hal);

    org.suspendedAt = new Date("2026-11-09T08:00:00Z");
    const synced = await sync(hal);

    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ id: workspace!.id, suspendedAt: org.suspendedAt });
    expect(await rolesOf(hal)).toEqual({ suspendedco: "admin" });
    expect(await reposOf(workspace!.id)).toEqual({ "suspendedco/app": true });

    org.suspendedAt = null;
    expect((await sync(hal))[0]!.suspendedAt).toBeNull();
  });

  test("a suspended installation Ponzu never saw makes no workspace", async () => {
    const ivy = await t.signInAs({ login: "ivy" });
    const org = installOnOrg("neverseenco", { reachedBy: [ivy] });
    org.suspendedAt = new Date();

    expect(await sync(ivy)).toEqual([]);
    const all = await t.db.select().from(workspaces);
    expect(all.find((row) => row.githubLogin === org.account.login)).toBeUndefined();
  });
});

describe("when things go wrong", () => {
  test("two syncs at once leave one of everything", async () => {
    const jo = await t.signInAs({ login: "jo" });
    installOnPerson(jo);
    installOnOrg("twiceco", { reachedBy: [jo], repoNames: ["a", "b", "c"] });

    const [one, two] = await Promise.all([sync(jo), sync(jo)]);

    expect(one.map((workspace) => workspace.id).sort()).toEqual(
      two.map((workspace) => workspace.id).sort(),
    );
    const rows = (await t.db.select().from(memberships)).filter((row) => row.userId === jo.userId);
    expect(rows).toHaveLength(2);
    expect(await reposOf(one.find((w) => w.githubLogin === "twiceco")!.id)).toEqual({
      "twiceco/a": true,
      "twiceco/b": true,
      "twiceco/c": true,
    });
  });

  test("a failure partway drops no membership, and running again finishes the job", async () => {
    const kit = await t.signInAs({ login: "kit" });
    const kept = installOnOrg("keptco", { reachedBy: [kit] });
    await sync(kit);
    const added = installOnOrg("addedco", { reachedBy: [kit] });
    t.github.failNext("/installation/repositories");

    await expect(sync(kit)).rejects.toMatchObject({ status: 500 });
    // Whichever installation failed, Kit is still in the one she had.
    expect(Object.keys(await rolesOf(kit))).toContain("keptco");

    const synced = await sync(kit);
    expect(synced.map((workspace) => workspace.installationId).sort()).toEqual(
      [kept.id, added.id].sort(),
    );
  });

  test("a token GitHub has revoked is github_reauth_required, and nothing changes", async () => {
    const lu = await t.signInAs({ login: "lu" });
    installOnOrg("revokedco", { reachedBy: [lu] });
    await sync(lu);
    t.github.revokeTokens(lu.github.id);

    await expect(sync(lu)).rejects.toMatchObject({ status: 401, code: "github_reauth_required" });
    expect(await rolesOf(lu)).toEqual({ revokedco: "admin" });
  });

  test("an installation with hundreds of repos is read to its end", async () => {
    const mo = await t.signInAs({ login: "mo" });
    const repositories: FakeRepository[] = Array.from({ length: 230 }, (_, index) => ({
      id: id(),
      fullName: `bigco/r${index}`,
      access: { [mo.github.id]: "read" },
    }));
    const org = installOnOrg("bigco", { reachedBy: [mo], repoNames: [] });
    org.repositories.push(...repositories);

    const [workspace] = await sync(mo);

    expect(Object.keys(await reposOf(workspace!.id))).toHaveLength(230);
  });

  test("the App's installation tokens are minted per sync, read-only, and never kept", async () => {
    const ned = await t.signInAs({ login: "ned" });
    const org = installOnOrg("tokenco", { reachedBy: [ned] });
    const before = t.github.installationTokenRequests.length;

    await sync(ned);

    expect(t.github.installationTokenRequests.slice(before)).toEqual([
      { installationId: org.id, body: { permissions: { metadata: "read" } } },
    ]);
    const stored = JSON.stringify(await t.db.select().from(workspaces));
    expect(stored).not.toContain("ghs_");
    expect(JSON.stringify(t.logs)).not.toContain("ghs_");
  });
});

test("the exchange starts a sync, so a person is in their workspaces once signed in", async () => {
  const fresh = await t.startSignIn({ login: "fresh" });
  installOnOrg("freshco", {
    reachedBy: [{ github: fresh.github } as SignedInPerson],
  });

  const person = await t.signInAs({ login: "fresh" });

  expect(await rolesOf(person)).toEqual({ freshco: "admin" });
});

test("a workspace a sync made is the same row an earlier webhook made", async () => {
  const oz = await t.signInAs({ login: "oz" });
  const org = installOnOrg("webhookfirstco", { reachedBy: [oz] });
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
