import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { createCanvas, getCanvas, settleCanvas } from "./canvases.ts";
import { enqueueJob, recordOnce } from "./jobs.ts";
import {
  addLinkedPullRequest,
  findLinkingCanvases,
  findWorkspaceRepo,
  listLinkedPullRequests,
  listStaleLinkedPullRequests,
  type NewLink,
  recordLinkedRead,
  removeLinkedPullRequests,
  settleWhenDone,
} from "./linked-pull-requests.ts";
import { type PullRequestRead, recordPullRequestRead } from "./pull-requests.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 12, 0, second));

async function canvasWithRepos() {
  const [user, workspace] = await Promise.all([seedUser(db, "maya"), seedWorkspace(db)]);
  const repo = await seedRepo(db, workspace.id, `${workspace.githubLogin}/app`);
  const api = await seedRepo(db, workspace.id, `${workspace.githubLogin}/api`);
  const canvas = await createCanvas(db, {
    workspaceId: workspace.id,
    repoId: repo.id,
    ownerId: user.id,
    claudeAccountId: null,
    name: "Checkout",
    branch: "pz/checkout",
    doc: emptyDoc("Checkout"),
  });
  return { canvas, repo, api, user, workspace };
}

/** Pull request `number` of `repo`, as linked by `userId` at `second`. */
const link = (
  canvasId: string,
  repo: { id: string; githubRepoId: number },
  number: number,
  fields: Partial<NewLink> = {},
): NewLink => ({
  canvasId,
  repoId: repo.id,
  githubRepoId: repo.githubRepoId,
  number,
  title: `Change ${number}`,
  url: `https://github.com/north-brook/api/pull/${number}`,
  state: "open",
  checks: "running",
  mergeable: null,
  autoMerge: false,
  updatedAt: at(0),
  readAt: at(0),
  source: "person",
  linkedByUserId: null,
  linkedVia: null,
  linkedAt: at(0),
  ...fields,
});

const branchRead = (
  canvasId: string,
  second: number,
  fields: Partial<PullRequestRead> = {},
): PullRequestRead => ({
  canvasId,
  number: 7,
  title: "Checkout",
  state: "open",
  checks: "running",
  mergeable: null,
  autoMerge: false,
  updatedAt: at(0),
  readAt: at(second),
  ...fields,
});

const linkRead = (
  canvasId: string,
  repoId: string,
  number: number,
  second: number,
  state: PullRequestRead["state"],
) => ({
  canvasId,
  repoId,
  number,
  title: `Change ${number}`,
  url: `https://github.com/north-brook/api/pull/${number}`,
  state,
  checks: "passing" as const,
  mergeable: true,
  autoMerge: false,
  updatedAt: at(second),
  readAt: at(second),
});

test("linking keeps the canvas's counts, refuses a second time and past the most", async () => {
  const { canvas, api, user } = await canvasWithRepos();

  const first = await addLinkedPullRequest(
    db,
    link(canvas.id, api, 12, { linkedByUserId: user.id }),
  );
  expect(first).toMatchObject({
    kind: "linked",
    link: { number: 12, repository: api.fullName, linkedBy: { id: user.id, name: "maya" } },
  });
  expect(await addLinkedPullRequest(db, link(canvas.id, api, 12))).toEqual({ kind: "exists" });
  // Already merged: recorded finished, counted, but not open.
  await addLinkedPullRequest(db, link(canvas.id, api, 13, { state: "merged", readAt: at(4) }));
  expect(await getCanvas(db, canvas.id)).toMatchObject({ prLinkedCount: 2, prLinkedOpen: 1 });
  const [, merged] = await listLinkedPullRequests(db, canvas.id);
  expect(merged).toMatchObject({ number: 13, finishedAt: at(4) });
  // Linking a merged pull request settles nothing by itself.
  expect(await getCanvas(db, canvas.id)).toMatchObject({ status: "active" });

  expect(await addLinkedPullRequest(db, link(canvas.id, api, 14), { max: 2 })).toEqual({
    kind: "full",
  });

  expect(await removeLinkedPullRequests(db, canvas.id, [{ repoId: api.id, number: 12 }])).toEqual([
    { repoId: api.id, number: 12 },
  ]);
  expect(await removeLinkedPullRequests(db, canvas.id, [{ repoId: api.id, number: 12 }])).toEqual(
    [],
  );
  expect(await getCanvas(db, canvas.id)).toMatchObject({ prLinkedCount: 1, prLinkedOpen: 0 });
});

test("a workspace's repo is found by its name, in any case", async () => {
  const { api, workspace } = await canvasWithRepos();
  const name = api.fullName.toUpperCase();
  expect(await findWorkspaceRepo(db, { workspaceId: workspace.id, fullName: name })).toMatchObject({
    id: api.id,
  });
  expect(await findWorkspaceRepo(db, { workspaceId: workspace.id, fullName: "a/b" })).toBeNull();
});

test("a linked read keeps only the newest, and says when it finished", async () => {
  const { canvas, api } = await canvasWithRepos();
  await addLinkedPullRequest(db, link(canvas.id, api, 12, { readAt: at(1) }));

  // Older than what is recorded.
  expect(await recordLinkedRead(db, linkRead(canvas.id, api.id, 12, 0, "closed"))).toBeNull();
  const closed = await recordLinkedRead(db, linkRead(canvas.id, api.id, 12, 2, "closed"));
  expect(closed).toMatchObject({ finished: true, link: { state: "closed", finishedAt: at(2) } });
  expect(await getCanvas(db, canvas.id)).toMatchObject({ prLinkedOpen: 0 });
  // Reopened: open again, and counted so.
  const reopened = await recordLinkedRead(db, linkRead(canvas.id, api.id, 12, 3, "open"));
  expect(reopened).toMatchObject({ finished: false, link: { finishedAt: null } });
  expect(await getCanvas(db, canvas.id)).toMatchObject({ prLinkedOpen: 1 });
  const merged = await recordLinkedRead(db, linkRead(canvas.id, api.id, 12, 4, "merged"));
  expect(merged).toMatchObject({ finished: true, link: { finishedAt: at(4) } });
  // A merge is the last word.
  expect(await recordLinkedRead(db, linkRead(canvas.id, api.id, 12, 5, "open"))).toBeNull();
});

test("the branch's read says when it moved into merged or closed, and settles nothing", async () => {
  const { canvas } = await canvasWithRepos();
  expect(await recordPullRequestRead(db, branchRead(canvas.id, 1))).toMatchObject({
    finished: false,
  });
  expect(
    await recordPullRequestRead(db, branchRead(canvas.id, 2, { state: "closed" })),
  ).toMatchObject({ finished: true, status: "active" });
  // Still closed, its checks changed: not a move into closed.
  expect(
    await recordPullRequestRead(
      db,
      branchRead(canvas.id, 3, { state: "closed", checks: "failing" }),
    ),
  ).toMatchObject({ finished: false });
  // A newer pull request merged: a move.
  expect(
    await recordPullRequestRead(db, branchRead(canvas.id, 4, { number: 8, state: "merged" })),
  ).toMatchObject({ finished: true, status: "active" });
});

test("settling waits for every pull request, and for one merged", async () => {
  const { canvas, api } = await canvasWithRepos();
  await recordPullRequestRead(db, branchRead(canvas.id, 1));
  await addLinkedPullRequest(db, link(canvas.id, api, 12));

  // The branch's merges while the link is open: not yet.
  await recordPullRequestRead(db, branchRead(canvas.id, 2, { state: "merged" }));
  expect(await settleWhenDone(db, canvas.id, at(2))).toBeNull();
  // The link merges: done.
  await recordLinkedRead(db, linkRead(canvas.id, api.id, 12, 3, "merged"));
  expect(await settleWhenDone(db, canvas.id, at(3))).toMatchObject({
    status: "settled",
    settledAt: at(3),
  });
  // Once settled, again changes nothing.
  expect(await settleWhenDone(db, canvas.id, at(4))).toBeNull();
});

test("everything closed with none merged never settles", async () => {
  const { canvas, api } = await canvasWithRepos();
  await recordPullRequestRead(db, branchRead(canvas.id, 1, { state: "closed" }));
  await addLinkedPullRequest(db, link(canvas.id, api, 12));
  await recordLinkedRead(db, linkRead(canvas.id, api.id, 12, 2, "closed"));
  expect(await settleWhenDone(db, canvas.id, at(2))).toBeNull();
  expect(await getCanvas(db, canvas.id)).toMatchObject({ status: "active" });
});

test("a canvas with only links settles when they are done, and none merged", async () => {
  const { canvas, api } = await canvasWithRepos();
  await addLinkedPullRequest(db, link(canvas.id, api, 12));
  await addLinkedPullRequest(db, link(canvas.id, api, 13));
  await recordLinkedRead(db, linkRead(canvas.id, api.id, 12, 1, "merged"));
  expect(await settleWhenDone(db, canvas.id, at(1))).toBeNull();
  await recordLinkedRead(db, linkRead(canvas.id, api.id, 13, 2, "closed"));
  expect(await settleWhenDone(db, canvas.id, at(2))).toMatchObject({ status: "settled" });

  // Reopened: it stays open until another pull request moves.
  await settleCanvas(db, canvas.id, { settled: false, now: at(3) });
  expect(await getCanvas(db, canvas.id)).toMatchObject({ status: "active" });
});

test("webhooks find the canvases that link a pull request", async () => {
  const { canvas, api } = await canvasWithRepos();
  await addLinkedPullRequest(db, link(canvas.id, api, 21));
  expect(
    await findLinkingCanvases(db, { githubRepoId: api.githubRepoId, numbers: [21, 22] }),
  ).toEqual([
    expect.objectContaining({
      canvasId: canvas.id,
      repoId: api.id,
      number: 21,
      repo: { githubRepoId: api.githubRepoId, fullName: api.fullName },
      canvasStatus: "active",
    }),
  ]);
  expect(await findLinkingCanvases(db, { githubRepoId: api.githubRepoId, numbers: [] })).toEqual(
    [],
  );
});

test("the sweep lists open links read long ago, but not those waiting or swept", async () => {
  const { canvas, api } = await canvasWithRepos();
  await addLinkedPullRequest(db, link(canvas.id, api, 31, { readAt: at(1) }));
  await addLinkedPullRequest(db, link(canvas.id, api, 32, { readAt: at(2) }));
  await addLinkedPullRequest(db, link(canvas.id, api, 33, { readAt: at(3) }));
  await addLinkedPullRequest(db, link(canvas.id, api, 34, { readAt: at(0), state: "merged" }));
  const opts = {
    readBefore: at(30),
    refreshKind: "test.refresh",
    sweptKind: "test.swept",
    window: "w1",
    limit: 50,
  };
  const mine = async () =>
    (await listStaleLinkedPullRequests(db, opts))
      .filter((stale) => stale.canvasId === canvas.id)
      .map((stale) => stale.number);
  expect(await mine()).toEqual([31, 32, 33]);

  await enqueueJob(db, {
    kind: "test.refresh",
    key: "k",
    payload: { canvasId: canvas.id, number: 32, repoId: api.id },
    runAt: at(0),
  });
  await recordOnce(db, { kind: "test.swept", key: `link:${canvas.id}:${api.id}:33@w1` });
  expect(await mine()).toEqual([31]);
});
