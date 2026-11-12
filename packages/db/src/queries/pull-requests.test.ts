import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { createCanvas, getCanvas, settleCanvas } from "./canvases.ts";
import {
  findCanvasByBranch,
  getPullRequestContext,
  listPullRequestCanvases,
  type PullRequestRead,
  recordPullRequestRead,
  setPullRequestSummary,
} from "./pull-requests.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

async function canvasOnBranch(branch = "pz/checkout") {
  const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
  const repo = await seedRepo(db, workspace.id, `${workspace.githubLogin}/app`);
  const canvas = await createCanvas(db, {
    workspaceId: workspace.id,
    repoId: repo.id,
    ownerId: user.id,
    claudeAccountId: null,
    name: "Checkout",
    branch,
    doc: emptyDoc("Checkout"),
  });
  return { canvas, repo, user, key: { githubRepoId: repo.githubRepoId, branch } };
}

const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 12, 0, second));

/** A read of pull request 7, begun at `second`. */
const read = (
  canvasId: string,
  second: number,
  fields: Partial<PullRequestRead> = {},
): PullRequestRead => ({
  canvasId,
  number: 7,
  state: "open",
  checks: "running",
  mergeable: null,
  autoMerge: false,
  updatedAt: at(0),
  readAt: at(second),
  ...fields,
});

test("findCanvasByBranch finds the canvas that owns a branch, and only that", async () => {
  const { canvas, key } = await canvasOnBranch();

  expect(await findCanvasByBranch(db, key)).toMatchObject({
    id: canvas.id,
    status: "active",
    repo: { githubRepoId: key.githubRepoId },
  });
  expect(await findCanvasByBranch(db, { ...key, branch: "main" })).toBeNull();
  expect(await findCanvasByBranch(db, { ...key, githubRepoId: 404_404 })).toBeNull();
});

test("the read that began last wins, whatever order the reads finish in", async () => {
  const { canvas } = await canvasOnBranch();

  expect(await recordPullRequestRead(db, read(canvas.id, 1))).toMatchObject({
    prChecks: "running",
  });
  expect(
    await recordPullRequestRead(db, read(canvas.id, 5, { checks: "passing", mergeable: true })),
  ).toMatchObject({ prChecks: "passing", prMergeable: true });
  // Begun at second 3, finished after the one begun at 5. GitHub's updatedAt is the same for
  // both: a check finishing does not move it.
  expect(await recordPullRequestRead(db, read(canvas.id, 3))).toBeNull();
  expect(await getCanvas(db, canvas.id)).toMatchObject({
    prNumber: 7,
    prState: "open",
    prChecks: "passing",
    prMergeable: true,
    prReadAt: at(5),
    status: "active",
  });
});

test("a read that finds what is recorded writes nothing", async () => {
  const { canvas } = await canvasOnBranch();
  await recordPullRequestRead(db, read(canvas.id, 1, { checks: "passing" }));

  expect(await recordPullRequestRead(db, read(canvas.id, 4, { checks: "passing" }))).toBeNull();
  expect(await getCanvas(db, canvas.id)).toMatchObject({ prChecks: "passing", prReadAt: at(1) });
  // GitHub's updatedAt is part of what is recorded: a comment moves it.
  expect(
    await recordPullRequestRead(db, read(canvas.id, 5, { checks: "passing", updatedAt: at(5) })),
  ).toMatchObject({ prUpdatedAt: at(5), prReadAt: at(5) });
});

test("a later pull request from the same branch replaces an earlier one", async () => {
  const { canvas } = await canvasOnBranch();
  await recordPullRequestRead(db, read(canvas.id, 9, { state: "closed" }));

  expect(await recordPullRequestRead(db, read(canvas.id, 2, { number: 8 }))).toMatchObject({
    prNumber: 8,
  });
  // And the earlier one cannot take it back.
  expect(await recordPullRequestRead(db, read(canvas.id, 30, { state: "open" }))).toBeNull();
  expect(await getCanvas(db, canvas.id)).toMatchObject({ prNumber: 8, prState: "open" });
});

test("a merge settles the canvas and is the last word on its pull request", async () => {
  const { canvas } = await canvasOnBranch();

  const merged = await recordPullRequestRead(
    db,
    read(canvas.id, 1, { state: "merged", checks: "passing" }),
  );
  expect(merged).toMatchObject({ status: "settled", prState: "merged" });
  expect(merged!.settledAt).toEqual(at(1));

  // Someone reopens the canvas; a later read of the merged pull request leaves it open.
  await settleCanvas(db, canvas.id, { settled: false, now: at(2) });
  expect(await recordPullRequestRead(db, read(canvas.id, 3, { state: "merged" }))).toBeNull();
  expect(await getCanvas(db, canvas.id)).toMatchObject({ status: "active", prState: "merged" });
});

test("a repo's canvases with a pull request, and those whose pull request is open", async () => {
  const { canvas, repo, user } = await canvasOnBranch("pz/a");
  const other = await createCanvas(db, {
    workspaceId: repo.workspaceId,
    repoId: repo.id,
    ownerId: user.id,
    claudeAccountId: null,
    name: "Other",
    branch: "pz/b",
    doc: emptyDoc("Other"),
  });
  const closed = await createCanvas(db, {
    workspaceId: repo.workspaceId,
    repoId: repo.id,
    ownerId: user.id,
    claudeAccountId: null,
    name: "Closed",
    branch: "pz/c",
    doc: emptyDoc("Closed"),
  });
  await recordPullRequestRead(db, read(canvas.id, 1, { state: "draft", updatedAt: at(1) }));
  await recordPullRequestRead(db, read(other.id, 1, { number: 8, updatedAt: at(2) }));
  await recordPullRequestRead(db, read(closed.id, 1, { number: 9, state: "closed" }));
  const list = (open: boolean) =>
    listPullRequestCanvases(db, { githubRepoId: repo.githubRepoId, open });

  // The most recently updated on GitHub first.
  expect(await list(true)).toEqual([other.id, canvas.id]);
  expect(await list(false)).toEqual([other.id, canvas.id, closed.id]);
});

test("the context has the repo it opens in, and the summary waits in the row", async () => {
  const { canvas, repo } = await canvasOnBranch();

  expect(await setPullRequestSummary(db, { canvasId: canvas.id, summary: "Shorter." })).toEqual({
    prNumber: null,
    prState: null,
  });
  const context = await getPullRequestContext(db, canvas.id);
  expect(context).toMatchObject({
    canvas: { id: canvas.id, prSummary: "Shorter." },
    repo: { githubRepoId: repo.githubRepoId, fullName: repo.fullName, defaultBranch: "main" },
  });
  expect(context!.assetKey).toBeString();
  expect(await getPullRequestContext(db, "cnv_none")).toBeNull();
});
