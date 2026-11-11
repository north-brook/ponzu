import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { getRepoAccess, removeMembership, upsertMembership } from "@ponzu/db";
import { syncGithub } from "../github/sync.ts";
import { call, designIn, workspaceWithRepo } from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

/*
 * One model of who may see or steer a repo (`repo_access`), written by a person's sync and by
 * questions asked as the App, read by every route and live query that asks, and kept true
 * between syncs by GitHub's webhooks.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

async function deliver(event: string, payload: unknown) {
  const response = await t.app.request("/v1/github/webhook", t.github.delivery(event, payload));
  await t.backgroundDone();
  return response;
}

const askedAbout = (login: string) =>
  t.github.permissionRequests.filter((line) => line.endsWith(` ${login}`)).length;

describe("one answer for every question", () => {
  test("a sync's answers are what opening a design and listing repos and designs read", async () => {
    const ws = await workspaceWithRepo(t, { kai: "write", lin: "read" });
    const design = await designIn(t, ws, "kai", emptyDoc("Synced"));
    for (const login of ["kai", "lin"]) await syncGithub(t.deps, ws.people[login]!.userId);
    const as = (login: string) => ws.people[login]!.headers;

    expect((await call(t, as("kai"), "GET", `/v1/designs/${design.id}`)).body.access).toBe("write");
    expect((await call(t, as("lin"), "GET", `/v1/designs/${design.id}`)).body.access).toBe("read");
    const profile = await call(t, as("lin"), "GET", `/v1/workspaces/${ws.id}`);
    expect(profile.body.repos).toMatchObject([{ id: ws.repo.id, canPush: false }]);
    const listed = await call(t, as("lin"), "GET", `/v1/workspaces/${ws.id}/designs`);
    expect(listed.body.designs.map((row: { id: string }) => row.id)).toEqual([design.id]);
    // Nobody had to ask GitHub as the App: the sync had said already.
    expect([askedAbout("kai"), askedAbout("lin")]).toEqual([0, 0]);
  });

  test("an answer asked as the App is what a sync and a list see next, and the newest wins", async () => {
    const ws = await workspaceWithRepo(t, { noa: "write" });
    const design = await designIn(t, ws, "noa", emptyDoc("Asked"));
    const noa = ws.people.noa!;

    expect((await call(t, noa.headers, "GET", `/v1/designs/${design.id}`)).status).toBe(200);
    expect(askedAbout("noa")).toBe(1);
    expect(await getRepoAccess(t.db, { userId: noa.userId, repoId: ws.repo.id })).toMatchObject({
      permission: "write",
    });

    // GitHub takes her push away; her next sync says so, and the design is read-only at once.
    t.clock.advance(1_000);
    ws.grant("noa", "read");
    await syncGithub(t.deps, noa.userId);
    const after = await call(t, noa.headers, "GET", `/v1/designs/${design.id}`);
    expect(after.body.access).toBe("read");
    expect(askedAbout("noa")).toBe(1);
  });

  test("someone who leaves the workspace loses its designs at once, whatever answer is kept", async () => {
    const ws = await workspaceWithRepo(t, { ora: "write" });
    const design = await designIn(t, ws, "ora", emptyDoc("Left"));
    const ora = ws.people.ora!;
    expect((await call(t, ora.headers, "GET", `/v1/designs/${design.id}`)).status).toBe(200);

    await removeMembership(t.db, { installationId: ws.installationId, userId: ora.userId });

    expect((await call(t, ora.headers, "GET", `/v1/designs/${design.id}`)).status).toBe(404);
    expect(askedAbout("ora")).toBe(1);
  });
});

describe("webhooks keep it true", () => {
  test("a collaborator removed loses the repo's designs at once, not a minute later", async () => {
    const ws = await workspaceWithRepo(t, { pia: "write", quinn: "read" });
    const design = await designIn(t, ws, "pia", emptyDoc("Removed"));
    const quinn = ws.people.quinn!;
    await syncGithub(t.deps, quinn.userId);
    expect((await call(t, quinn.headers, "GET", `/v1/designs/${design.id}`)).status).toBe(200);

    ws.grant("quinn", "none");
    await deliver("member", {
      action: "removed",
      member: { id: quinn.github.id },
      installation: { id: ws.installationId },
    });

    expect((await call(t, quinn.headers, "GET", `/v1/designs/${design.id}`)).status).toBe(404);
    const listed = await call(t, quinn.headers, "GET", `/v1/workspaces/${ws.id}/designs`);
    // The repo was all they reached of the workspace, so they are no longer in it.
    expect(listed.status).toBe(404);
  });

  test("repos changing in the installation make kept answers stale: GitHub is asked again", async () => {
    const ws = await workspaceWithRepo(t, { rae: "write" });
    const design = await designIn(t, ws, "rae", emptyDoc("Stale"));
    const rae = ws.people.rae!;
    await syncGithub(t.deps, rae.userId);
    const open = async () => (await call(t, rae.headers, "GET", `/v1/designs/${design.id}`)).status;
    expect(await open()).toBe(200);

    await deliver("installation_repositories", { installation: { id: ws.installationId } });

    // A stale answer is not taken as fresh, and never stands in while GitHub fails.
    t.github.failNext(`/repos/${ws.repo.fullName}/collaborators/rae/permission`);
    expect(await open()).toBe(502);
    expect(await open()).toBe(200);
    expect(askedAbout("rae")).toBe(1);
  });

  test("a repo going private makes everyone's answers about it stale", async () => {
    const ws = await workspaceWithRepo(t, { sol: "write", tam: "read" });
    const design = await designIn(t, ws, "sol", emptyDoc("Private"));
    const tam = ws.people.tam!;
    expect((await call(t, tam.headers, "GET", `/v1/designs/${design.id}`)).status).toBe(200);

    ws.grant("tam", "none");
    await deliver("repository", {
      action: "privatized",
      repository: { id: ws.repo.githubRepoId },
      installation: { id: ws.installationId },
    });

    expect((await call(t, tam.headers, "GET", `/v1/designs/${design.id}`)).status).toBe(404);
  });

  test("when someone's token is dead, a webhook about them has the App asked for them", async () => {
    const ws = await workspaceWithRepo(t, { uma: "write", vik: "write" });
    const design = await designIn(t, ws, "uma", emptyDoc("Dead token"));
    const vik = ws.people.vik!;
    await syncGithub(t.deps, vik.userId);
    expect((await call(t, vik.headers, "GET", `/v1/designs/${design.id}`)).body.access).toBe(
      "write",
    );

    ws.grant("vik", "read");
    t.github.revokeTokens(vik.github.id);
    await deliver("team", {
      action: "edited",
      installation: { id: ws.installationId },
      changes: { repository: {} },
    });

    // Their session at Ponzu outlives their GitHub token; what they may do does not.
    expect((await call(t, vik.headers, "GET", `/v1/designs/${design.id}`)).body.access).toBe(
      "read",
    );
    expect(askedAbout("vik")).toBe(1);
  });
});

describe("every reader, every repo", () => {
  const repoNames = async (headers: Record<string, string>, workspaceId: string) => {
    const profile = await call(t, headers, "GET", `/v1/workspaces/${workspaceId}`);
    expect(profile.status).toBe(200);
    return profile.body.repos.map((repo: { fullName: string }) => repo.fullName).sort();
  };
  const designIds = async (headers: Record<string, string>, workspaceId: string) => {
    const listed = await call(t, headers, "GET", `/v1/workspaces/${workspaceId}/designs`);
    expect(listed.status).toBe(200);
    return listed.body.designs.map((row: { id: string }) => row.id);
  };

  test("a repo with no designs that goes private leaves the repo list of someone who lost it", async () => {
    const ws = await workspaceWithRepo(t, { wes: "read" });
    const wes = ws.people.wes!;
    await syncGithub(t.deps, wes.userId);
    expect(await repoNames(wes.headers, ws.id)).toEqual([ws.repo.fullName]);

    ws.grant("wes", "none");
    await deliver("repository", {
      action: "privatized",
      repository: { id: ws.repo.githubRepoId },
      installation: { id: ws.installationId },
    });

    expect(await repoNames(wes.headers, ws.id)).toEqual([]);
    t.clock.advance(5 * 60_000);
    expect(await repoNames(wes.headers, ws.id)).toEqual([]);
  });

  test("a repo transferred to another workspace shows there only to those GitHub lets in", async () => {
    const from = await workspaceWithRepo(t, { xia: "write" });
    const to = await workspaceWithRepo(t, { yan: "write" });
    const xia = from.people.xia!;
    const yan = to.people.yan!;
    await syncGithub(t.deps, xia.userId);
    // Also in the other workspace, where they reach nothing.
    await upsertMembership(t.db, { workspaceId: to.id, userId: xia.userId, role: "member" });
    expect(await repoNames(xia.headers, from.id)).toEqual([from.repo.fullName]);
    expect(await repoNames(xia.headers, to.id)).toEqual([]);

    // GitHub moves the repo into the other installation, without them.
    const moved = from.github.repository;
    from.github.installation.repositories.splice(0, 1);
    to.github.installation.repositories.push(moved);
    from.grant("xia", "none");
    await deliver("repository", {
      action: "transferred",
      repository: { id: moved.id },
      installation: { id: to.installationId },
    });

    expect(await repoNames(xia.headers, to.id)).toEqual([]);
    expect(await repoNames(xia.headers, from.id)).toEqual([]);
    t.clock.advance(5 * 60_000);
    expect(await repoNames(xia.headers, to.id)).toEqual([]);
    // Someone GitHub gives it to in its new home sees it there.
    moved.access[yan.github.id] = "write";
    await syncGithub(t.deps, yan.userId);
    expect(await repoNames(yan.headers, to.id)).toEqual([moved.fullName, to.repo.fullName].sort());
  });

  test("a public repo is readable to every member, listed or opened, collaborator or not", async () => {
    const ws = await workspaceWithRepo(t, { zed: "write", ada: "none" }, { private: false });
    const design = await designIn(t, ws, "zed", emptyDoc("Public"));
    const ada = ws.people.ada!;
    const open = () => call(t, ada.headers, "GET", `/v1/designs/${design.id}`);

    expect(await designIds(ada.headers, ws.id)).toEqual([design.id]);
    expect((await open()).body.access).toBe("read");
    t.clock.advance(61_000);
    expect((await open()).body.access).toBe("read");
    expect(await designIds(ada.headers, ws.id)).toEqual([design.id]);
    t.clock.advance(61_000);
    expect(await designIds(ada.headers, ws.id)).toEqual([design.id]);
    expect((await open()).body.access).toBe("read");
    const profile = await call(t, ada.headers, "GET", `/v1/workspaces/${ws.id}`);
    expect(profile.body.repos).toMatchObject([{ id: ws.repo.id, canPush: false }]);
    expect(await getRepoAccess(t.db, { userId: ada.userId, repoId: ws.repo.id })).toMatchObject({
      permission: "read",
    });
  });

  test("a suspended installation shuts its designs at once, and no 502 follows", async () => {
    const ws = await workspaceWithRepo(t, { bo: "write" });
    const design = await designIn(t, ws, "bo", emptyDoc("Suspended"));
    const bo = ws.people.bo!;
    let { headers } = bo;
    const open = () => call(t, headers, "GET", `/v1/designs/${design.id}`);
    expect((await open()).body.access).toBe("write");
    expect(await designIds(headers, ws.id)).toEqual([design.id]);

    ws.github.installation.suspendedAt = new Date(t.clock.now());
    await deliver("installation", {
      action: "suspend",
      installation: { id: ws.installationId },
      sender: { id: bo.github.id },
    });

    expect((await open()).status).toBe(404);
    expect(await designIds(headers, ws.id)).toEqual([]);
    expect(await repoNames(headers, ws.id)).toEqual([]);
    const started = await call(t, headers, "POST", "/v1/designs", {
      workspaceId: ws.id,
      repoId: ws.repo.id,
    });
    expect(started.status).toBe(404);
    // Past the time a kept answer could stand in for GitHub: still a refusal, not a 502.
    t.clock.advance(11 * 60_000);
    ({ headers } = await t.signInAs({ login: "bo" }));
    expect((await open()).status).toBe(404);
    expect(await designIds(headers, ws.id)).toEqual([]);

    ws.github.installation.suspendedAt = null;
    await deliver("installation", {
      action: "unsuspend",
      installation: { id: ws.installationId },
      sender: { id: bo.github.id },
    });
    expect((await open()).body.access).toBe("write");
    expect(await designIds(headers, ws.id)).toEqual([design.id]);
  });

  test("a repo list GitHub cuts short still loses a repo the person lost", async () => {
    const ws = await workspaceWithRepo(t, { cy: "write", dee: "read" });
    const design = await designIn(t, ws, "cy", emptyDoc("Cut short"));
    const dee = ws.people.dee!;
    await syncGithub(t.deps, dee.userId);
    expect(await designIds(dee.headers, ws.id)).toEqual([design.id]);

    ws.grant("dee", "none");
    const { github } = t.deps;
    const listInstallationRepositories = github.listInstallationRepositories;
    // Past the pages Ponzu reads, so what it does not list is not known to be gone.
    github.listInstallationRepositories = async () => ({ items: [], complete: false });
    try {
      t.clock.advance(61_000);
      expect(await designIds(dee.headers, ws.id)).toEqual([]);
      expect(await repoNames(dee.headers, ws.id)).toEqual([]);
      expect((await call(t, dee.headers, "GET", `/v1/designs/${design.id}`)).status).toBe(404);
    } finally {
      github.listInstallationRepositories = listInstallationRepositories;
    }
  });
});
