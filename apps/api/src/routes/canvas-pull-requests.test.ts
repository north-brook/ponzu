import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { createCanvas, getCanvas, getUser, threadItems } from "@ponzu/db";
import { linkPullRequests, unlinkPullRequests } from "../pull-requests/links.ts";
import { refreshLinkedPullRequest, refreshPullRequest } from "../pull-requests/sync.ts";
import { addRepo, call, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type FakeRepoAccess, type TestApp } from "../testing/index.ts";

/*
 * The pull requests a canvas links (docs/cloud.md, "Linked pull requests"), through the person's
 * routes and the function the MCP shares, on PGlite and the fake GitHub.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

let branches = 0;

/** Maya's canvas on a branch of the workspace's repo, and a second repo she can push to. */
async function setup(access: Record<string, "write" | "read" | "none"> = { maya: "write" }) {
  const ws = await workspaceWithRepo(t, { ...access, maya: "write" });
  const api = await addRepo(t, ws, `api-${++branches}`, { maya: "write" });
  const branch = `pz/linked-${branches}`;
  const canvas = await createCanvas(t.db, {
    workspaceId: ws.id,
    repoId: ws.repo.id,
    ownerId: ws.people.maya!.userId,
    claudeAccountId: null,
    name: "Linked",
    branch,
    doc: emptyDoc("Linked"),
  });
  return { ws, api, canvas, branch, maya: ws.people.maya! };
}

/** A pull request someone opened on GitHub in `fullName`, from a branch of its own. */
function openIn(fullName: string, head = `feature-${++branches}`) {
  const repo = t.github.repo(fullName)!;
  t.github.pulls.push(repo, head);
  return { repo, pull: t.github.pulls.openAsSomeone(repo, { head, login: "sam" }) };
}

function mergeOnGithub(repo: FakeRepoAccess, pull: ReturnType<typeof openIn>["pull"]) {
  pull.mergedHead = t.github.pulls.head(repo, pull.head) ?? null;
  pull.state = "closed";
  pull.merged = true;
  pull.closedAt = t.clock.now();
  pull.updatedAt = t.clock.now();
}

function closeOnGithub(pull: ReturnType<typeof openIn>["pull"]) {
  pull.state = "closed";
  pull.closedAt = t.clock.now();
  pull.updatedAt = t.clock.now();
}

const urlOf = (fullName: string, number: number) => `https://github.com/${fullName}/pull/${number}`;

const link = (headers: Record<string, string>, canvasId: string, urls: string[]) =>
  call(t, headers, "POST", `/v1/canvases/${canvasId}/pull-requests`, { urls });

test("linking a pull request in another repo of the workspace records it, and the thread says so", async () => {
  const { api, canvas, maya } = await setup();
  const { pull } = openIn(api.fullName);

  const linked = await link(maya.headers, canvas.id, [urlOf(api.fullName, pull.number)]);
  expect(linked.status).toBe(200);
  expect(linked.body.results).toEqual([
    {
      ref: urlOf(api.fullName, pull.number),
      result: "linked",
      pullRequest: expect.objectContaining({
        repoId: api.id,
        repository: api.fullName,
        number: pull.number,
        title: pull.title,
        state: "open",
        source: "person",
        via: null,
        linkedBy: expect.objectContaining({ id: maya.userId }),
      }),
    },
  ]);
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prLinkedCount: 1, prLinkedOpen: 1 });
  const notices = (await t.db.select().from(threadItems)).filter(
    (item) => item.canvasId === canvas.id && item.kind === "notice",
  );
  expect(notices.map((item) => item.payload)).toEqual([
    {
      type: "pull_request_linked",
      repository: api.fullName,
      number: pull.number,
      url: urlOf(api.fullName, pull.number),
      title: pull.title,
      state: "open",
      via: null,
    },
  ]);

  // Again: already linked, nothing written.
  const again = await link(maya.headers, canvas.id, [urlOf(api.fullName, pull.number)]);
  expect(again.body.results[0]).toMatchObject({ result: "alreadyLinked", branch: false });

  const listed = await call(t, maya.headers, "GET", `/v1/canvases/${canvas.id}/pull-requests`);
  expect(listed.status).toBe(200);
  expect(listed.body).toMatchObject({
    branch: null,
    linked: [{ repository: api.fullName, number: pull.number }],
  });
});

test("each refusal has its code and a sentence an agent can act on", async () => {
  const { ws, canvas, maya } = await setup({ maya: "write", ines: "write" });
  const hidden = await addRepo(t, ws, `secret-${branches}`, { maya: "write" });
  const elsewhere = await workspaceWithRepo(t, { maya: "write" });
  const { pull: hiddenPull } = openIn(hidden.fullName);
  const ines = ws.people.ines!;

  const results = (
    await link(ines.headers, canvas.id, [
      "https://gitlab.com/a/b/merge_requests/1",
      urlOf(elsewhere.repo.fullName, 1),
      urlOf(hidden.fullName, hiddenPull.number),
      urlOf(ws.repo.fullName, 999),
    ])
  ).body.results;
  expect(results.map((result: { code: string }) => result.code)).toEqual([
    "invalid_url",
    "repo_not_in_workspace",
    "forbidden",
    "not_found",
  ]);
  expect(results[0].message).toBe(
    "That isn't a GitHub pull request link. Pass one like https://github.com/owner/repo/pull/12.",
  );
  expect(results[1].message).toBe(
    `Ponzu's GitHub App isn't installed on ${elsewhere.repo.fullName} for ${ws.github.installation.account.login}, so Ponzu can't follow that pull request. Link a pull request in one of ${ws.github.installation.account.login}'s repositories, or ask the person to add ${elsewhere.repo.fullName} to Ponzu on GitHub.`,
  );
  expect(results[2].message).toBe(
    `Ines can't read ${hidden.fullName} on GitHub, so Ponzu won't link it.`,
  );
  expect(results[3].message).toContain(`GitHub has no pull request #999 in ${ws.repo.fullName}`);

  // A repo the App lost, or the App suspended on the workspace: nothing there can be followed.
  // (A person's route is refused before this while suspended; the MCP's shares the function.)
  const user = (await getUser(t.db, maya.userId))!;
  const linkAsMaya = async (url: string) =>
    (
      await linkPullRequests(t.deps, { canvasId: canvas.id, user, refs: [url], source: "person" })
    )[0];
  await t.db.execute(`update repos set removed_at = now() where id = '${hidden.id}'`);
  expect(await linkAsMaya(urlOf(hidden.fullName, hiddenPull.number))).toMatchObject({
    result: "refused",
    code: "repo_not_in_workspace",
  });
  await t.db.execute(`update workspaces set suspended_at = now() where id = '${ws.id}'`);
  expect(await linkAsMaya(urlOf(ws.repo.fullName, 1))).toMatchObject({
    result: "refused",
    code: "repo_not_in_workspace",
  });
  await t.db.execute(`update workspaces set suspended_at = null where id = '${ws.id}'`);
});

test("at most twenty links a canvas", async () => {
  const { api, canvas, maya } = await setup();
  const urls = Array.from({ length: 21 }, () =>
    urlOf(api.fullName, openIn(api.fullName).pull.number),
  );
  const first = await link(maya.headers, canvas.id, urls.slice(0, 20));
  expect(first.body.results.every((r: { result: string }) => r.result === "linked")).toBe(true);
  const over = await link(maya.headers, canvas.id, urls.slice(20));
  expect(over.body.results[0]).toMatchObject({ result: "refused", code: "too_many_pull_requests" });
  // More than twenty in one request is the request's fault.
  const many = await link(maya.headers, canvas.id, urls);
  expect(many.status).toBe(400);
});

test("the canvas's own pull request is already its, never a link", async () => {
  const { ws, canvas, branch, maya } = await setup();
  const repo = t.github.repo(ws.repo.fullName)!;
  t.github.pulls.push(repo, branch);
  const pull = t.github.pulls.openAsSomeone(repo, { head: branch, login: "maya" });

  // Before any read recorded it on the canvas, and after.
  const before = await link(maya.headers, canvas.id, [urlOf(ws.repo.fullName, pull.number)]);
  expect(before.body.results[0]).toMatchObject({
    result: "alreadyLinked",
    alreadyLinked: true,
    branch: true,
    pullRequest: null,
  });
  await refreshPullRequest(t.deps, canvas.id);
  const after = await link(maya.headers, canvas.id, [urlOf(ws.repo.fullName, pull.number)]);
  expect(after.body.results[0]).toMatchObject({ result: "alreadyLinked", branch: true });
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({
    prNumber: pull.number,
    prLinkedCount: 0,
  });
});

test("a reader can list but not link; unlinking takes the link off", async () => {
  const { api, canvas, maya, ws } = await setup({ maya: "write", ines: "read" });
  const { pull } = openIn(api.fullName);
  const ines = ws.people.ines!;
  expect((await link(ines.headers, canvas.id, [urlOf(api.fullName, pull.number)])).status).toBe(
    403,
  );
  await link(maya.headers, canvas.id, [urlOf(api.fullName, pull.number)]);
  expect(
    (await call(t, ines.headers, "GET", `/v1/canvases/${canvas.id}/pull-requests`)).body.linked,
  ).toHaveLength(1);

  const path = `/v1/canvases/${canvas.id}/pull-requests/${api.id}/${pull.number}`;
  expect((await call(t, ines.headers, "DELETE", path)).status).toBe(403);
  expect((await call(t, maya.headers, "DELETE", path)).status).toBe(204);
  expect((await call(t, maya.headers, "DELETE", path)).status).toBe(404);
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prLinkedCount: 0, prLinkedOpen: 0 });
});

test("the MCP's way in: an agent's links name it, and unlink takes URLs", async () => {
  const { api, canvas, maya } = await setup();
  const { pull } = openIn(api.fullName);
  const user = (await getUser(t.db, maya.userId))!;
  const [linked] = await linkPullRequests(t.deps, {
    canvasId: canvas.id,
    user,
    refs: [{ repository: api.fullName, number: pull.number }],
    source: "agent",
    via: "Claude Code",
  });
  expect(linked).toMatchObject({
    result: "linked",
    pullRequest: { source: "agent", via: "Claude Code" },
  });
  expect(
    await unlinkPullRequests(t.deps, {
      canvasId: canvas.id,
      refs: [urlOf(api.fullName, pull.number), urlOf(api.fullName, pull.number), "nope"],
    }),
  ).toEqual([
    expect.objectContaining({ result: "unlinked", number: pull.number }),
    expect.objectContaining({ result: "notLinked", number: pull.number }),
    expect.objectContaining({ result: "refused", code: "invalid_url" }),
  ]);
});

test("settling: the branch's merging waits for an open link, and the link's merging settles", async () => {
  const { ws, api, canvas, branch, maya } = await setup();
  const repo = t.github.repo(ws.repo.fullName)!;
  t.github.pulls.push(repo, branch);
  const own = t.github.pulls.openAsSomeone(repo, { head: branch, login: "maya" });
  await refreshPullRequest(t.deps, canvas.id);
  const linked = openIn(api.fullName);
  await link(maya.headers, canvas.id, [urlOf(api.fullName, linked.pull.number)]);

  mergeOnGithub(repo, own);
  await refreshPullRequest(t.deps, canvas.id);
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prState: "merged", status: "active" });

  mergeOnGithub(linked.repo, linked.pull);
  await refreshLinkedPullRequest(t.deps, {
    canvasId: canvas.id,
    repoId: api.id,
    number: linked.pull.number,
  });
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({ status: "settled", prLinkedOpen: 0 });
  const merged = (await t.db.select().from(threadItems)).filter(
    (item) =>
      item.canvasId === canvas.id &&
      (item.payload as { repository?: string }).repository === api.fullName &&
      (item.payload as { state?: string }).state === "merged",
  );
  expect(merged).toHaveLength(1);
});

test("settling: everything closed with none merged leaves the canvas open", async () => {
  const { ws, api, canvas, branch, maya } = await setup();
  const repo = t.github.repo(ws.repo.fullName)!;
  t.github.pulls.push(repo, branch);
  const own = t.github.pulls.openAsSomeone(repo, { head: branch, login: "maya" });
  await refreshPullRequest(t.deps, canvas.id);
  const linked = openIn(api.fullName);
  await link(maya.headers, canvas.id, [urlOf(api.fullName, linked.pull.number)]);

  closeOnGithub(own);
  await refreshPullRequest(t.deps, canvas.id);
  closeOnGithub(linked.pull);
  await refreshLinkedPullRequest(t.deps, {
    canvasId: canvas.id,
    repoId: api.id,
    number: linked.pull.number,
  });
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({
    prState: "closed",
    prLinkedOpen: 0,
    status: "active",
  });
});

test("settling: linking a pull request that already merged never settles the canvas by itself", async () => {
  const { api, canvas, maya } = await setup();
  const linked = openIn(api.fullName);
  mergeOnGithub(linked.repo, linked.pull);
  const answer = await link(maya.headers, canvas.id, [urlOf(api.fullName, linked.pull.number)]);
  expect(answer.body.results[0]).toMatchObject({
    result: "linked",
    pullRequest: { state: "merged" },
  });
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({
    status: "active",
    prLinkedCount: 1,
    prLinkedOpen: 0,
  });
  // Read again, nothing moved: still open.
  await refreshLinkedPullRequest(t.deps, {
    canvasId: canvas.id,
    repoId: api.id,
    number: linked.pull.number,
  });
  expect(await getCanvas(t.db, canvas.id)).toMatchObject({ status: "active" });
});
