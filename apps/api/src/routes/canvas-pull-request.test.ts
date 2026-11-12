import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { createCanvas, getCanvas, getCanvasAssetKey, jobs, threadItems } from "@ponzu/db";
import { REFRESH_JOB } from "../pull-requests/refresh.ts";
import {
  call,
  canvasIn,
  startRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
import {
  createTestApp,
  type FakeRepoAccess,
  MERGEABLE_AFTER_MS,
  TEST_ASSETS_URL,
  TEST_CRON_SECRET,
  type TestApp,
} from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const BRANCH = "pz/checkout";

/**
 * A workspace whose repo Maya can push to and Ines can read, and a canvas of Maya's on a branch
 * of it: pushed to GitHub with one commit unless `pushed` is false.
 */
async function setup({ pushed = true, isPrivate = true } = {}) {
  const ws = await workspaceWithRepo(t, { maya: "write", ines: "read" }, { private: isPrivate });
  const repo = t.github.repo(ws.repo.fullName)!;
  const canvas = await createCanvas(t.db, {
    workspaceId: ws.id,
    repoId: ws.repo.id,
    ownerId: ws.people.maya!.userId,
    claudeAccountId: null,
    name: "Shorter checkout",
    branch: BRANCH,
    doc: emptyDoc("Shorter checkout"),
  });
  if (pushed) t.github.pulls.push(repo, BRANCH);
  return { ws, repo, canvas };
}

const path = (canvasId: string, rest = "") => `/v1/canvases/${canvasId}/pull-request${rest}`;
const as = (ws: Workspace, login: string) => ws.people[login]!.headers;
const head = (repo: FakeRepoAccess) => t.github.pulls.head(repo, BRANCH)!;

/** Opens the canvas's pull request as Maya, and lets GitHub work out whether it can merge. */
async function opened(ws: Workspace, canvasId: string) {
  const response = await call(t, as(ws, "maya"), "POST", path(canvasId));
  expect(response.status).toBe(201);
  await t.backgroundDone();
  return response.body;
}

const notices = async (canvasId: string) =>
  (await t.db.select().from(threadItems))
    .filter((item) => item.canvasId === canvasId && item.kind === "notice")
    .map((item) => item.payload);

/** A canvas's previews in storage, as the runner leaves them for `seq`. */
async function withPreviews(canvasId: string, seq: number) {
  await t.db.execute(`update canvases set preview_seq = ${seq} where id = '${canvasId}'`);
  const assetKey = await getCanvasAssetKey(t.db, canvasId);
  for (const theme of ["light", "dark"]) {
    t.storage.objects.set(`${assetKey}/previews/${seq}-${theme}.png`, {
      body: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "image/png" },
      sha256: null,
    });
  }
  return assetKey!;
}

/** The storage keys a description's picture points at. */
const picturesIn = (body: string) =>
  [...body.matchAll(new RegExp(`${TEST_ASSETS_URL}/(pull-requests/[^"]+)`, "g"))].map(
    ([, key]) => key!,
  );

describe("reading", () => {
  test("before anything is pushed, after, and once it is open", async () => {
    const { ws, repo, canvas } = await setup({ pushed: false });

    const before = await call(t, as(ws, "ines"), "GET", path(canvas.id));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      branch: { name: BRANCH, base: "main", exists: false, aheadBy: 0 },
      pullRequest: null,
      nextAction: "none",
    });

    t.github.pulls.push(repo, BRANCH);
    expect((await call(t, as(ws, "ines"), "GET", path(canvas.id))).body).toMatchObject({
      branch: { exists: true, aheadBy: 1, behindBy: 0 },
      nextAction: "create_pr",
    });

    await opened(ws, canvas.id);
    const pull = t.github.pulls.latest(repo)!;
    t.github.pulls.protect(repo, "main", { requiredChecks: ["ci / test"] });
    t.github.pulls.setChecks(head(repo), [
      { name: "ci / test", state: "success" },
      { name: "deploy", status: true, state: "queued" },
      // Whoever posts a check chooses its link.
      { name: "sneaky", state: "success", url: "javascript:alert(1)" },
    ]);
    t.github.pulls.comment(pull, "theo", "Can the comma match the brand site?", {
      path: "src/hero.tsx",
      line: 15,
    });
    t.clock.advance(60_000);
    t.github.pulls.review(pull, "theo", "APPROVED");
    t.github.pulls.comment(pull, "maya", "Ship it once e2e is green.");

    const { status, body } = await call(t, as(ws, "ines"), "GET", path(canvas.id));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      mergeMethod: "squash",
      autoMergeAllowed: false,
      nextAction: "ready",
      pullRequest: {
        number: pull.number,
        url: `https://github.com/${ws.repo.fullName}/pull/${pull.number}`,
        title: "Shorter checkout",
        state: "draft",
        head: { ref: BRANCH, sha: head(repo) },
        base: { ref: "main" },
        author: { login: "maya", bot: false },
        mergeable: true,
        checks: {
          state: "running",
          complete: true,
          items: [
            { name: "ci / test", app: "GitHub Actions", state: "passed", required: true },
            { name: "deploy", app: null, state: "pending", required: false },
            { name: "sneaky", state: "passed", url: null },
          ],
        },
        reviews: [{ author: { login: "theo" }, state: "approved" }],
        files: { total: 1, additions: 1, deletions: 0, items: [{ path: "README.md" }] },
        commits: { total: 1, items: [{ message: "Change" }] },
      },
    });
    expect(
      body.pullRequest.conversation.map((remark: any) => [remark.author.login, remark.path]),
    ).toEqual([
      ["theo", "src/hero.tsx"],
      ["maya", null],
    ]);
    // People are people: only the App's own bot is marked as Ponzu.
    expect(body.pullRequest.author.ponzu).toBe(false);
    expect(body.pullRequest.reviews[0].author.ponzu).toBe(false);
    // Nothing of GitHub's own that the shape does not list.
    expect(body.pullRequest).not.toHaveProperty("id");
    // The row the sidebar watches has caught up too.
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prChecks: "running" });
  });

  test("what the Ponzu App's own bot wrote is marked as Ponzu's; another bot is itself", async () => {
    const { ws, repo, canvas } = await setup();
    await opened(ws, canvas.id);
    const pull = t.github.pulls.latest(repo)!;
    t.github.pulls.comment(pull, t.github.pulls.botLogin, "Pushed the new hero.");
    t.github.pulls.comment(pull, "maya", "Looks right.");
    t.github.pulls.comment(pull, "ponzu-test-impostor", "Not the App.");
    t.github.pulls.review(pull, t.github.pulls.botLogin, "COMMENTED", "Summary of the change.");

    const { body } = await call(t, as(ws, "ines"), "GET", path(canvas.id));
    const said = body.pullRequest.conversation.map((remark: any) => [
      remark.author.login,
      remark.author.ponzu,
    ]);
    expect(said).toContainEqual([t.github.pulls.botLogin, true]);
    expect(said).toContainEqual(["maya", false]);
    expect(said).toContainEqual(["ponzu-test-impostor", false]);
    expect(said.filter(([, ponzu]: [string, boolean]) => ponzu)).toHaveLength(2);
  });

  test("Scratch has none, and someone outside the workspace finds nothing", async () => {
    const { ws, canvas } = await setup();
    const scratch = await canvasIn(t, ws, "maya", emptyDoc("Lisbon"), "scratch");
    const stranger = await t.signInAs({ login: "pr-stranger" });

    expect(await call(t, as(ws, "maya"), "GET", path(scratch.id))).toMatchObject({
      status: 409,
      body: { error: { code: "no_repository" } },
    });
    expect((await call(t, stranger.headers, "GET", path(canvas.id))).status).toBe(404);
  });

  test("one file's diff, or what stands in for it", async () => {
    const { ws, repo, canvas } = await setup();
    t.github.pulls.push(repo, BRANCH, {
      files: [
        { path: "src/hero.tsx", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
        { path: "public/hero.png", additions: 0, deletions: 0, patch: null },
        { path: "package-lock.json", additions: 9_000, deletions: 20, patch: null },
      ],
    });
    await opened(ws, canvas.id);
    const file = (name: string) =>
      call(t, as(ws, "ines"), "GET", path(canvas.id, `/files?path=${encodeURIComponent(name)}`));

    expect((await file("src/hero.tsx")).body).toEqual({
      path: "src/hero.tsx",
      previousPath: null,
      change: "modified",
      additions: 2,
      deletions: 1,
      diff: { kind: "text", patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
    });
    expect((await file("public/hero.png")).body.diff).toEqual({ kind: "binary" });
    expect((await file("package-lock.json")).body.diff).toEqual({ kind: "too_large" });
    expect((await file("nope.txt")).status).toBe(404);
  });

  test("a pull request from the branch into another base is not the canvas's", async () => {
    const { ws, repo, canvas } = await setup();
    t.github.pulls.push(repo, "release");
    const elsewhere = t.github.pulls.openAsSomeone(repo, {
      head: BRANCH,
      base: "release",
      login: "theo",
    });

    const { body } = await call(t, as(ws, "maya"), "GET", path(canvas.id));
    expect(body).toMatchObject({ pullRequest: null, nextAction: "create_pr" });
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prNumber: null });

    // Opening one into the default branch is the canvas's, and the other stays out of it.
    const ours = await opened(ws, canvas.id);
    expect(ours.pullRequest.number).not.toBe(elsewhere.number);
    expect(ours.pullRequest.base.ref).toBe("main");
  });

  test("a read that shows the pull request behind its branch's head is not recorded", async () => {
    const { ws, repo, canvas } = await setup();
    await opened(ws, canvas.id);
    const pull = t.github.pulls.latest(repo)!;
    pull.draft = false;
    t.github.pulls.setChecks(head(repo), [{ name: "ci", state: "in_progress" }]);
    await call(t, as(ws, "maya"), "GET", path(canvas.id));
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prChecks: "running" });

    // The old commit's checks pass just as a new one is pushed, which GitHub's pull request
    // does not show yet.
    t.github.pulls.setChecks(head(repo), [{ name: "ci", state: "success" }]);
    t.github.pulls.lagHead(repo, pull, 60_000);
    t.github.pulls.push(repo, BRANCH);
    t.clock.advance(MERGEABLE_AFTER_MS);
    const lagging = await call(t, as(ws, "maya"), "GET", path(canvas.id));
    expect(lagging.body.pullRequest.checks.state).toBe("passing");
    // A green tick for a commit nobody has checked would be wrong on the row.
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prChecks: "running" });
    // And it cannot be merged at the commit it shows.
    const merge = await call(t, as(ws, "maya"), "POST", path(canvas.id, "/merge"), {
      headSha: lagging.body.pullRequest.head.sha,
    });
    expect(merge.body.error.code).toBe("head_moved");

    t.clock.advance(60_000);
    await call(t, as(ws, "maya"), "GET", path(canvas.id));
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prChecks: "none" });
  });
});

describe("opening", () => {
  test("a draft, as the person, with the canvas's name, its link, picture and the agent's summary", async () => {
    const { ws, repo, canvas } = await setup();
    const runner = await startRunner(t, canvas.id);
    const summary = await call(t, runner.headers, "POST", "/v1/runner/pull-request-summary", {
      summary: "Drops the paragraph from the hero.",
    });
    // No pull request yet: kept for the one that opens next, and the agent is told so.
    expect(summary).toEqual({
      status: 200,
      body: { pullRequest: null, open: null, kept: "none_open" },
    });
    const assetKey = await withPreviews(canvas.id, 4);

    const body = await opened(ws, canvas.id);

    const pull = t.github.pulls.latest(repo)!;
    expect(body.pullRequest).toMatchObject({ number: pull.number, state: "draft" });
    // Maya is its author, so where the rules want a review, someone else gives it.
    expect(pull).toMatchObject({
      draft: true,
      head: BRANCH,
      base: "main",
      author: { login: "maya", bot: false },
    });
    expect(t.github.pulls.actions.at(-1)).toEqual({
      kind: "open",
      number: pull.number,
      by: "maya",
    });
    expect(pull.body).toContain("Drops the paragraph from the hero.");
    expect(pull.body).toContain(`](https://ponzu.design/canvases/${canvas.id})`);
    // The picture is a copy under a key of its own, never the canvas's asset key.
    expect(pull.body).not.toContain(assetKey);
    const pictures = picturesIn(pull.body);
    expect(pictures).toHaveLength(2);
    expect(pictures[0]).toMatch(/^pull-requests\/[A-Za-z0-9]{32}\/dark\.png$/);
    for (const key of pictures) expect(t.storage.objects.has(key)).toBe(true);

    // The row the sidebar watches, with what GitHub worked out after it opened.
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({
      prNumber: pull.number,
      prState: "draft",
      prMergeable: true,
      status: "active",
    });
    expect(await notices(canvas.id)).toEqual([
      {
        type: "pull_request",
        number: pull.number,
        url: `https://github.com/${ws.repo.fullName}/pull/${pull.number}`,
        title: "Shorter checkout",
        state: "draft",
      },
    ]);
  });

  test("again, it is the one already open; after it is closed, a new one", async () => {
    const { ws, repo, canvas } = await setup();
    const first = await opened(ws, canvas.id);

    const again = await call(t, as(ws, "maya"), "POST", path(canvas.id));
    expect(again.status).toBe(200);
    expect(again.body.pullRequest.number).toBe(first.pullRequest.number);
    expect(await notices(canvas.id)).toHaveLength(1);

    t.github.pulls.pull(repo, first.pullRequest.number).state = "closed";
    const reopened = await opened(ws, canvas.id);
    expect(reopened.pullRequest.number).toBe(first.pullRequest.number + 1);
  });

  test("one someone opened on GitHub from the branch is the canvas's", async () => {
    const { ws, repo, canvas } = await setup();
    const theirs = t.github.pulls.openAsSomeone(repo, { head: BRANCH, login: "theo" });

    const { status, body } = await call(t, as(ws, "maya"), "POST", path(canvas.id));
    expect(status).toBe(200);
    expect(body.pullRequest).toMatchObject({ number: theirs.number, author: { login: "theo" } });
  });

  test("refused for Scratch, an unpushed branch, a branch with nothing new, and a reader", async () => {
    const { ws, repo, canvas } = await setup({ pushed: false });
    const scratch = await canvasIn(t, ws, "maya", emptyDoc("Lisbon"), "scratch");
    const open = (canvasId: string, who = "maya") => call(t, as(ws, who), "POST", path(canvasId));
    const code = async (canvasId: string, who?: string) =>
      (await open(canvasId, who)).body.error?.code;

    const unbranched = await canvasIn(t, ws, "maya", emptyDoc("Fresh"));

    expect(await code(scratch.id)).toBe("no_repository");
    expect(await code(unbranched.id)).toBe("branch_not_pushed");
    expect(await code(canvas.id)).toBe("branch_not_pushed");
    // On GitHub, but with nothing main lacks.
    t.github.pulls.createBranch(repo, BRANCH);
    expect(await code(canvas.id)).toBe("no_changes");
    t.github.pulls.push(repo, BRANCH);
    expect(await code(canvas.id, "ines")).toBe("forbidden");
    expect(t.github.pulls.actions).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ kind: "open", by: "ines" })]),
    );
  });

  test("commits only the sandbox holds: Create PR is offered, pushes first, and opens once GitHub has them", async () => {
    const { ws, repo, canvas } = await setup({ pushed: false });
    const runner = await startRunner(t, canvas.id);
    const report = (branch: { unpushed: number; error: string | null }) =>
      call(t, runner.headers, "PUT", "/v1/runner/state", {
        state: "idle",
        status: null,
        artboards: [],
        claudeSessionId: null,
        branch,
      });
    // The agent's push failed: the runner says so with its state.
    const failed = "Ponzu couldn't push pz/checkout to the repo (fatal: repository not found).";
    expect((await report({ unpushed: 1, error: failed })).status).toBe(200);

    const read = await call(t, as(ws, "ines"), "GET", path(canvas.id));
    expect(read.body).toMatchObject({
      branch: { exists: false, aheadBy: 0, unpushed: 1, pushError: failed },
      pullRequest: null,
      nextAction: "create_pr",
    });

    // Create PR: nothing to open from on GitHub yet, so the sandbox is asked to push first.
    const actions = t.github.pulls.actions.length;
    const asked = await call(t, as(ws, "maya"), "POST", path(canvas.id));
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({
      branch: { exists: false, unpushed: 1, pushError: null },
      pullRequest: null,
    });
    const claimed = await call(t, runner.headers, "POST", "/v1/runner/events/claim", {
      claimId: "clm_aaaaaaaaaaaaaaaa",
    });
    expect(claimed.body.events).toMatchObject([
      { kind: "push", priority: "now", from: { login: "maya" }, payload: {} },
    ]);
    expect(t.github.pulls.actions.length).toBe(actions);

    // The runner pushed: GitHub has the branch, and Create PR opens from it.
    t.github.pulls.push(repo, BRANCH);
    await report({ unpushed: 0, error: null });
    const body = await opened(ws, canvas.id);
    expect(body.pullRequest).toMatchObject({ state: "draft" });
    expect(body.branch).toMatchObject({ unpushed: 0, pushError: null });
  });

  test("a private repo on a plan with no drafts gets a ready one", async () => {
    const { ws, repo, canvas } = await setup();
    t.github.pulls.settings(repo, { draftsUnsupported: true });

    const body = await opened(ws, canvas.id);
    expect(body.pullRequest.state).toBe("open");
  });

  test("a public repo's description carries no picture, nor one with no previews in storage", async () => {
    const shown = await setup({ isPrivate: false });
    await withPreviews(shown.canvas.id, 4);
    await opened(shown.ws, shown.canvas.id);
    const pull = t.github.pulls.latest(shown.repo)!;
    expect(pull.body).not.toContain(TEST_ASSETS_URL);
    expect(pull.body).toContain(`https://ponzu.design/canvases/${shown.canvas.id}`);

    const missing = await setup();
    await t.db.execute(`update canvases set preview_seq = 9 where id = '${missing.canvas.id}'`);
    await opened(missing.ws, missing.canvas.id);
    expect(t.github.pulls.latest(missing.repo)!.body).not.toContain(TEST_ASSETS_URL);
  });

  test("a repo made public loses its pull requests' pictures, from the description and storage", async () => {
    const { ws, repo, canvas } = await setup();
    await withPreviews(canvas.id, 4);
    await opened(ws, canvas.id);
    const pull = t.github.pulls.latest(repo)!;
    pull.body = `${pull.body}\n\nNotes from Theo.`;
    const pictures = picturesIn(pull.body);
    expect(pictures).toHaveLength(2);

    await t.app.request(
      "/v1/github/webhook",
      t.github.delivery("repository", {
        action: "publicized",
        repository: { id: ws.repo.githubRepoId },
        installation: { id: repo.installationId },
      }),
    );
    await t.backgroundDone();

    expect(pull.body).not.toContain(TEST_ASSETS_URL);
    expect(pull.body).toContain("Notes from Theo.");
    expect(pull.body).toContain("<!-- ponzu:summary -->");
    for (const key of pictures) expect(t.storage.objects.has(key)).toBe(false);
  });
});

describe("the agent's summary", () => {
  test("is written into the open pull request in place, leaving what people wrote around it", async () => {
    const { ws, repo, canvas } = await setup();
    const runner = await startRunner(t, canvas.id);
    const say = (summary: string) =>
      call(t, runner.headers, "POST", "/v1/runner/pull-request-summary", { summary });
    await opened(ws, canvas.id);
    const pull = t.github.pulls.latest(repo)!;
    pull.body = `Context from Theo.\n\n${pull.body}`;

    const written = {
      status: 200,
      body: { pullRequest: pull.number, open: { number: pull.number, state: "draft" }, kept: null },
    };
    expect(await say("First take.")).toEqual(written);
    expect(await say("Second take.")).toEqual(written);
    expect(pull.body).toStartWith("Context from Theo.");
    expect(pull.body).toContain("Second take.");
    expect(pull.body).not.toContain("First take.");

    // Someone rewrote the description on GitHub: it is theirs now.
    pull.body = "Rewritten by hand.";
    // The agent hears that one is open, and why its words did not go in.
    expect(await say("Third take.")).toEqual({
      status: 200,
      body: { pullRequest: null, open: { number: pull.number, state: "draft" }, kept: "rewritten" },
    });
    expect(pull.body).toBe("Rewritten by hand.");
  });

  test("the tab carries the kept words while no pull request is open, and not while one is", async () => {
    const { ws, repo, canvas } = await setup();
    const runner = await startRunner(t, canvas.id);
    const read = async () => (await call(t, as(ws, "ines"), "GET", path(canvas.id))).body;
    // Nothing kept yet.
    expect(await read()).toMatchObject({ pullRequest: null, summary: null });

    await call(t, runner.headers, "POST", "/v1/runner/pull-request-summary", {
      summary: "Shortens checkout to **one** page.",
    });
    expect(await read()).toMatchObject({
      pullRequest: null,
      summary: "Shortens checkout to **one** page.",
      nextAction: "create_pr",
    });

    // Open, its description on GitHub says them: the tab doesn't say them twice.
    await opened(ws, canvas.id);
    expect((await read()).summary).toBeNull();
    t.github.pulls.latest(repo)!.draft = false;
    expect((await read()).summary).toBeNull();

    // Closed, they are what Create PR opens the next one with.
    await call(t, as(ws, "maya"), "POST", path(canvas.id, "/close"));
    expect(await read()).toMatchObject({
      pullRequest: { state: "closed" },
      summary: "Shortens checkout to **one** page.",
      nextAction: "create_pr",
    });

    // Only blank words are as good as none.
    await call(t, runner.headers, "POST", "/v1/runner/pull-request-summary", { summary: "  \n" });
    expect((await read()).summary).toBeNull();
  });
});

describe("acting", () => {
  /** A canvas with its pull request open, ready for review, and known to be mergeable. */
  async function ready() {
    const context = await setup();
    await opened(context.ws, context.canvas.id);
    const pull = t.github.pulls.latest(context.repo)!;
    pull.draft = false;
    return { ...context, pull };
  }

  const act = (ws: Workspace, canvasId: string, action: string, body?: unknown, method = "POST") =>
    call(t, as(ws, "maya"), method, path(canvasId, `/${action}`), body);
  const codeOf = async (response: Promise<{ body: any }>) => (await response).body.error?.code;
  /** Merge, as Maya, at the commit the branch is at unless told otherwise. */
  const merge = (ws: Workspace, canvasId: string, repo: FakeRepoAccess, body = {}) =>
    act(ws, canvasId, "merge", { headSha: head(repo), ...body });

  test("ready, as the person", async () => {
    const { ws, repo, canvas } = await setup();
    await opened(ws, canvas.id);

    const { status, body } = await act(ws, canvas.id, "ready");
    expect(status).toBe(200);
    expect(body).toMatchObject({ pullRequest: { state: "open" }, nextAction: "merge" });
    expect(t.github.pulls.actions.at(-1)).toMatchObject({ kind: "ready", by: "maya" });
    expect(t.github.pulls.latest(repo)!.draft).toBe(false);
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prState: "open" });
  });

  test("merge, as the person, the first way the repo allows: the canvas settles once", async () => {
    const { ws, repo, canvas, pull } = await ready();
    t.github.pulls.settings(repo, { squash: false });

    const { status, body } = await merge(ws, canvas.id, repo);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      pullRequest: { state: "merged", mergedBy: { login: "maya" } },
      nextAction: "none",
    });
    expect(t.github.pulls.actions.at(-1)).toEqual({
      kind: "merge",
      number: pull.number,
      by: "maya",
    });
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({
      prState: "merged",
      status: "settled",
    });

    // GitHub's webhook for it arrives after, and changes nothing more.
    await t.app.request(
      "/v1/github/webhook",
      t.github.delivery("pull_request", {
        action: "closed",
        repository: { id: ws.repo.githubRepoId },
        pull_request: {
          number: pull.number,
          head: { ref: BRANCH, repo: { id: ws.repo.githubRepoId } },
        },
      }),
    );
    await t.backgroundDone();
    expect((await notices(canvas.id)).map((notice: any) => notice.state)).toEqual([
      "draft",
      "merged",
    ]);
    // The branch is deleted once merged, as the person.
    expect(t.github.pulls.head(repo, BRANCH)).toBeUndefined();
    // Merging again is the same answer.
    const again = await merge(ws, canvas.id, repo, { headSha: pull.mergedHead });
    expect(again.body.pullRequest.state).toBe("merged");
  });

  test("a canvas reopened after its merge stays open, and its new work gets a new pull request", async () => {
    const { ws, repo, canvas, pull } = await ready();
    await merge(ws, canvas.id, repo);
    await t.backgroundDone();
    await call(t, as(ws, "maya"), "PATCH", `/v1/canvases/${canvas.id}`, { settled: false });

    const after = await call(t, as(ws, "ines"), "GET", path(canvas.id));
    expect(after.body.nextAction).toBe("none");
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ status: "active", prState: "merged" });
    // Asking again before anything new is pushed is the merged one.
    expect((await call(t, as(ws, "maya"), "POST", path(canvas.id))).status).toBe(200);

    t.github.pulls.push(repo, BRANCH);
    const worked = await call(t, as(ws, "ines"), "GET", path(canvas.id));
    expect(worked.body).toMatchObject({
      branch: { aheadBy: 1 },
      pullRequest: { number: pull.number, state: "merged" },
      nextAction: "create_pr",
    });
    const next = await opened(ws, canvas.id);
    expect(next.pullRequest).toMatchObject({ number: pull.number + 1, state: "draft" });
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({
      prNumber: pull.number + 1,
      prState: "draft",
      status: "active",
    });
  });

  test("merge waits for what the repo's rules want, and says what that is", async () => {
    const { ws, repo, canvas, pull } = await ready();
    const code = (body = {}) => codeOf(merge(ws, canvas.id, repo, body));

    expect(await code({ headSha: "f".repeat(40) })).toBe("head_moved");
    expect((await act(ws, canvas.id, "merge", {})).status).toBe(400);

    pull.conflicting = true;
    expect(await code()).toBe("merge_conflicts");
    pull.conflicting = false;

    t.github.pulls.protect(repo, "main", { requiredApprovals: 1, requiredChecks: ["ci"] });
    expect((await call(t, as(ws, "maya"), "GET", path(canvas.id))).body.nextAction).toBe("blocked");
    expect(await code()).toBe("review_required");
    t.github.pulls.review(pull, "theo", "CHANGES_REQUESTED");
    expect(await code()).toBe("changes_requested");
    pull.reviews = [];
    t.github.pulls.review(pull, "theo", "APPROVED");
    t.github.pulls.setChecks(head(repo), [
      { name: "ci", state: "failure" },
      { name: "lint", state: "in_progress" },
    ]);
    expect(await code()).toBe("checks_failing");
    t.github.pulls.setChecks(head(repo), [
      { name: "ci", state: "in_progress" },
      { name: "lint", state: "failure" },
    ]);
    // A check the rules do not require may fail; one they require has not finished.
    expect(await code()).toBe("checks_pending");

    t.github.pulls.setChecks(head(repo), [{ name: "ci", state: "success" }]);
    t.github.pulls.protect(repo, "main", { strict: true });
    t.github.pulls.push(repo, "main");
    t.clock.advance(MERGEABLE_AFTER_MS);
    expect(await code()).toBe("branch_behind");

    pull.draft = true;
    expect(await code()).toBe("pull_request_draft");
    // None of it reached GitHub as a merge.
    expect(pull.merged).toBe(false);
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ status: "active" });
  });

  test("merging past the rules is the person's choice, and GitHub's to allow", async () => {
    const { ws, repo, canvas, pull } = await ready();
    t.github.pulls.protect(repo, "main", { requiredApprovals: 1 });

    // Maya asks to bypass, and is not someone the rules let: GitHub's words say why.
    expect(await codeOf(merge(ws, canvas.id, repo, { bypass: true }))).toBe("review_required");
    expect(pull.merged).toBe(false);

    t.github.pulls.protect(repo, "main", { requiredApprovals: 1, bypass: ["maya"] });
    // Without asking to, she is held to the rules all the same.
    expect(await codeOf(merge(ws, canvas.id, repo))).toBe("review_required");
    const { body } = await merge(ws, canvas.id, repo, { bypass: true });
    expect(body.pullRequest).toMatchObject({ state: "merged", mergedBy: { login: "maya" } });
  });

  test("a check that is not required may fail, and the merge goes ahead", async () => {
    const { ws, repo, canvas } = await ready();
    t.github.pulls.protect(repo, "main", { requiredChecks: ["ci"] });
    t.github.pulls.setChecks(head(repo), [
      { name: "ci", state: "success" },
      { name: "lint", state: "failure" },
    ]);

    expect((await merge(ws, canvas.id, repo)).body.pullRequest.state).toBe("merged");
  });

  test("merge waits a moment while GitHub works out whether it can, then says so", async () => {
    const { ws, repo, canvas } = await setup();
    await call(t, as(ws, "maya"), "POST", path(canvas.id));
    t.github.pulls.latest(repo)!.draft = false;

    // Straight after opening, before the background read is done.
    t.github.pulls.latest(repo)!.mergeableAt = Number.POSITIVE_INFINITY;
    expect(await codeOf(merge(ws, canvas.id, repo))).toBe("mergeability_unknown");
    await t.backgroundDone();
    t.github.pulls.latest(repo)!.mergeableAt = t.clock.now() + 2_500;
    expect((await merge(ws, canvas.id, repo)).body.pullRequest.state).toBe("merged");
  });

  test("a merge GitHub's reads do not show yet is read again later, webhook or not", async () => {
    const { ws, repo, canvas } = await ready();
    t.github.pulls.hideMerges(30_000);

    const answered = await merge(ws, canvas.id, repo);
    expect(answered.body.pullRequest.state).toBe("open");
    const [later] = (await t.db.select().from(jobs)).filter(
      (job) => job.kind === REFRESH_JOB && job.key?.startsWith(`${canvas.id}@`) && !job.lockedBy,
    );
    expect(later).toBeDefined();
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ status: "active" });

    // No webhook comes; the cron reads it a minute on, and the canvas settles.
    t.clock.advance(60_000);
    const cron = await t.app.request("/v1/cron/minute", {
      headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
    });
    expect(cron.status).toBe(200);
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({
      prState: "merged",
      status: "settled",
    });
    t.github.pulls.hideMerges(0);
  });

  test("a reader may look but not act; there is nothing to act on before it opens", async () => {
    const { ws, repo, canvas } = await setup();
    expect(await codeOf(merge(ws, canvas.id, repo))).toBe("no_pull_request");
    await opened(ws, canvas.id);
    const asInes = await call(t, as(ws, "ines"), "POST", path(canvas.id, "/merge"), {
      headSha: head(repo),
    });
    expect(asInes).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  });

  test("Merge is offered only once GitHub says it can merge and nothing is still running", async () => {
    const { ws, repo, canvas } = await ready();
    const next = async () =>
      (await call(t, as(ws, "maya"), "GET", path(canvas.id))).body.nextAction;
    expect(await next()).toBe("merge");

    // Just pushed: GitHub is working out whether it can merge. Nothing to press yet.
    t.github.pulls.push(repo, BRANCH);
    expect(await next()).toBe("none");
    t.clock.advance(MERGEABLE_AFTER_MS);
    expect(await next()).toBe("merge");

    // Checks running in a repo without auto-merge: wait for them, never Merge past them.
    t.github.pulls.setChecks(head(repo), [{ name: "ci", state: "in_progress" }]);
    expect(await next()).toBe("none");
    t.github.pulls.settings(repo, { autoMerge: true });
    expect(await next()).toBe("auto_merge");
    t.github.pulls.setChecks(head(repo), [{ name: "ci", state: "success" }]);
    expect(await next()).toBe("merge");
  });

  test("auto-merge, where the repo allows it and there is something to wait for", async () => {
    const { ws, repo, canvas } = await ready();
    expect(await codeOf(act(ws, canvas.id, "auto-merge"))).toBe("auto_merge_not_allowed");

    t.github.pulls.settings(repo, { autoMerge: true });
    expect(await codeOf(act(ws, canvas.id, "auto-merge"))).toBe("already_mergeable");

    t.github.pulls.protect(repo, "main", { requiredChecks: ["ci"] });
    t.github.pulls.setChecks(head(repo), [{ name: "ci", state: "in_progress" }]);
    const on = await act(ws, canvas.id, "auto-merge");
    expect(on.body).toMatchObject({
      pullRequest: { autoMerge: { method: "squash", enabledBy: { login: "maya" } } },
      nextAction: "auto_merge",
    });
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({
      prAutoMerge: true,
      prChecks: "running",
    });

    const off = await act(ws, canvas.id, "auto-merge", undefined, "DELETE");
    expect(off.body.pullRequest.autoMerge).toBeNull();
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prAutoMerge: false });

    // Waiting on a review is waiting too, where the repo has auto-merge.
    t.github.pulls.setChecks(head(repo), [{ name: "ci", state: "success" }]);
    t.github.pulls.protect(repo, "main", { requiredApprovals: 1 });
    expect((await call(t, as(ws, "maya"), "GET", path(canvas.id))).body.nextAction).toBe(
      "auto_merge",
    );
  });

  test("update the branch when it is behind, and only then", async () => {
    const { ws, repo, canvas } = await ready();
    expect(await codeOf(act(ws, canvas.id, "update-branch", { headSha: head(repo) }))).toBe(
      "branch_up_to_date",
    );

    t.github.pulls.push(repo, "main");
    const before = head(repo);
    expect((await act(ws, canvas.id, "update-branch", {})).status).toBe(400);
    expect(await codeOf(act(ws, canvas.id, "update-branch", { headSha: "a".repeat(40) }))).toBe(
      "head_moved",
    );
    const { status, body } = await act(ws, canvas.id, "update-branch", { headSha: before });
    expect(status).toBe(200);
    expect(body.branch.behindBy).toBe(0);
    expect(head(repo)).not.toBe(before);
    expect(t.github.pulls.actions.at(-1)).toMatchObject({ kind: "update_branch", by: "maya" });
    await t.backgroundDone();
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prMergeable: true });
  });

  test("close: the thread says so, and the button offers a new one", async () => {
    const { ws, canvas } = await ready();

    const { body } = await act(ws, canvas.id, "close");
    expect(body).toMatchObject({ pullRequest: { state: "closed" }, nextAction: "create_pr" });
    expect(await getCanvas(t.db, canvas.id)).toMatchObject({ prState: "closed", status: "active" });
    expect((await notices(canvas.id)).map((notice: any) => notice.state)).toEqual([
      "draft",
      "closed",
    ]);
    expect(await codeOf(act(ws, canvas.id, "ready"))).toBe("pull_request_closed");
  });

  test("close while auto-merge is on closes it; one auto-merge merged first is refused, not reopened", async () => {
    const { ws, repo, canvas } = await ready();
    t.github.pulls.settings(repo, { autoMerge: true });
    t.github.pulls.protect(repo, "main", { requiredChecks: ["ci"] });
    t.github.pulls.setChecks(head(repo), [{ name: "ci", state: "in_progress" }]);
    expect((await act(ws, canvas.id, "auto-merge")).body.pullRequest.autoMerge).not.toBeNull();

    const closed = await act(ws, canvas.id, "close");
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      pullRequest: { state: "closed" },
      nextAction: "create_pr",
    });
    expect(t.github.pulls.actions.at(-1)).toMatchObject({ kind: "close", by: "maya" });

    // Another canvas's pull request, whose auto-merge landed before the person's Close did.
    const other = await setup();
    await opened(other.ws, other.canvas.id);
    const pull = t.github.pulls.latest(other.repo)!;
    pull.draft = false;
    await call(t, as(other.ws, "maya"), "GET", path(other.canvas.id));
    Object.assign(pull, { state: "closed", merged: true, mergedBy: "maya" });
    const acted = t.github.pulls.actions.length;
    const refused = await act(other.ws, other.canvas.id, "close");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: "pull_request_closed",
      message: `#${pull.number} is merged.`,
    });
    // GitHub never heard a Close for it.
    expect(t.github.pulls.actions.length).toBe(acted);
  });

  test("a person whose GitHub token GitHub no longer takes is asked to sign in again", async () => {
    const { ws, repo, canvas } = await ready();
    t.github.revokeTokens(ws.people.maya!.github.id);

    expect(await codeOf(merge(ws, canvas.id, repo))).toBe("github_reauth_required");
  });
});
