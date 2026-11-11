import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { createDesign, getDesign, getDesignAssetKey, threadItems } from "@ponzu/db";
import {
  call,
  designIn,
  startRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/designs.ts";
import {
  createTestApp,
  MERGEABLE_AFTER_MS,
  TEST_ASSETS_URL,
  type TestApp,
} from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const BRANCH = "pz/checkout";

/**
 * A workspace whose repo Maya can push to and Ines can read, and a design of Maya's on a branch
 * of it: pushed to GitHub with one commit unless `pushed` is false.
 */
async function setup({ pushed = true, isPrivate = true } = {}) {
  const ws = await workspaceWithRepo(t, { maya: "write", ines: "read" }, { private: isPrivate });
  const repo = t.github.repo(ws.repo.fullName)!;
  const design = await createDesign(t.db, {
    workspaceId: ws.id,
    repoId: ws.repo.id,
    ownerId: ws.people.maya!.userId,
    claudeAccountId: null,
    name: "Shorter checkout",
    branch: BRANCH,
    doc: emptyDoc("Shorter checkout"),
  });
  if (pushed) t.github.pulls.push(repo, BRANCH);
  return { ws, repo, design };
}

const path = (designId: string, rest = "") => `/v1/designs/${designId}/pull-request${rest}`;
const as = (ws: Workspace, login: string) => ws.people[login]!.headers;

/** Opens the design's pull request as Maya, and lets GitHub work out whether it can merge. */
async function opened(ws: Workspace, designId: string) {
  const response = await call(t, as(ws, "maya"), "POST", path(designId));
  expect(response.status).toBe(201);
  await t.backgroundDone();
  return response.body;
}

const notices = async (designId: string) =>
  (await t.db.select().from(threadItems))
    .filter((item) => item.designId === designId && item.kind === "notice")
    .map((item) => item.payload);

describe("reading", () => {
  test("before anything is pushed, after, and once it is open", async () => {
    const { ws, repo, design } = await setup({ pushed: false });

    const before = await call(t, as(ws, "ines"), "GET", path(design.id));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      branch: { name: BRANCH, base: "main", exists: false, aheadBy: 0 },
      pullRequest: null,
      nextAction: "none",
    });

    t.github.pulls.push(repo, BRANCH);
    expect((await call(t, as(ws, "ines"), "GET", path(design.id))).body).toMatchObject({
      branch: { exists: true, aheadBy: 1, behindBy: 0 },
      nextAction: "create_pr",
    });

    await opened(ws, design.id);
    const pull = t.github.pulls.latest(repo)!;
    t.github.pulls.setChecks(t.github.pulls.head(repo, BRANCH)!, [
      { name: "ci / test", state: "success" },
      { name: "deploy", status: true, state: "queued" },
    ]);
    t.github.pulls.comment(pull, "theo", "Can the comma match the brand site?", {
      path: "src/hero.tsx",
      line: 15,
    });
    t.clock.advance(60_000);
    t.github.pulls.review(pull, "theo", "APPROVED");
    t.github.pulls.comment(pull, "maya", "Ship it once e2e is green.");

    const { status, body } = await call(t, as(ws, "ines"), "GET", path(design.id));
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
        head: { ref: BRANCH, sha: t.github.pulls.head(repo, BRANCH) },
        base: { ref: "main" },
        author: { login: "ponzu-test", bot: true },
        mergeable: true,
        checks: {
          state: "running",
          complete: true,
          items: [
            { name: "ci / test", app: "GitHub Actions", state: "passed" },
            { name: "deploy", app: null, state: "pending" },
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
    // Nothing of GitHub's own that the shape does not list.
    expect(body.pullRequest).not.toHaveProperty("id");
    // The row the sidebar watches has caught up too.
    expect(await getDesign(t.db, design.id)).toMatchObject({ prChecks: "running" });
  });

  test("Scratch has none, and someone outside the workspace finds nothing", async () => {
    const { ws, design } = await setup();
    const scratch = await designIn(t, ws, "maya", emptyDoc("Lisbon"), "scratch");
    const stranger = await t.signInAs({ login: "pr-stranger" });

    expect(await call(t, as(ws, "maya"), "GET", path(scratch.id))).toMatchObject({
      status: 409,
      body: { error: { code: "no_repository" } },
    });
    expect((await call(t, stranger.headers, "GET", path(design.id))).status).toBe(404);
  });

  test("one file's diff, or what stands in for it", async () => {
    const { ws, repo, design } = await setup();
    t.github.pulls.push(repo, BRANCH, {
      files: [
        { path: "src/hero.tsx", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
        { path: "public/hero.png", additions: 0, deletions: 0, patch: null },
        { path: "package-lock.json", additions: 9_000, deletions: 20, patch: null },
      ],
    });
    await opened(ws, design.id);
    const file = (name: string) =>
      call(t, as(ws, "ines"), "GET", path(design.id, `/files?path=${encodeURIComponent(name)}`));

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
});

describe("opening", () => {
  test("a draft, as the App, with the design's name, its link and the agent's summary", async () => {
    const { ws, repo, design } = await setup();
    const runner = await startRunner(t, design.id);
    const summary = await call(t, runner.headers, "POST", "/v1/runner/pull-request-summary", {
      summary: "Drops the paragraph from the hero.",
    });
    expect(summary).toEqual({ status: 200, body: { pullRequest: null } });
    await t.db.execute(`update designs set preview_seq = 4 where id = '${design.id}'`);

    const body = await opened(ws, design.id);

    const pull = t.github.pulls.latest(repo)!;
    expect(body.pullRequest).toMatchObject({ number: pull.number, state: "draft" });
    expect(pull).toMatchObject({ draft: true, head: BRANCH, base: "main", author: { bot: true } });
    expect(t.github.pulls.actions.at(-1)).toEqual({ kind: "open", number: pull.number, by: "app" });
    const assetKey = await getDesignAssetKey(t.db, design.id);
    expect(pull.body).toContain("Drops the paragraph from the hero.");
    expect(pull.body).toContain(`](https://ponzu.design/designs/${design.id})`);
    expect(pull.body).toContain(`${TEST_ASSETS_URL}/${assetKey}/previews/4-light.png`);
    expect(pull.body).toContain(`${TEST_ASSETS_URL}/${assetKey}/previews/4-dark.png`);
    // A token for opening it and nothing more.
    const minted = t.github.installationTokenRequests.map((request) => request.body as any);
    expect(minted).toContainEqual({
      repository_ids: [ws.repo.githubRepoId],
      permissions: { contents: "read", pull_requests: "write", metadata: "read" },
    });

    // The row the sidebar watches, with what GitHub worked out after it opened.
    expect(await getDesign(t.db, design.id)).toMatchObject({
      prNumber: pull.number,
      prState: "draft",
      prMergeable: true,
      status: "active",
    });
    expect(await notices(design.id)).toEqual([
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
    const { ws, repo, design } = await setup();
    const first = await opened(ws, design.id);

    const again = await call(t, as(ws, "maya"), "POST", path(design.id));
    expect(again.status).toBe(200);
    expect(again.body.pullRequest.number).toBe(first.pullRequest.number);
    expect(await notices(design.id)).toHaveLength(1);

    t.github.pulls.pull(repo, first.pullRequest.number).state = "closed";
    const reopened = await opened(ws, design.id);
    expect(reopened.pullRequest.number).toBe(first.pullRequest.number + 1);
  });

  test("one someone opened on GitHub from the branch is the design's", async () => {
    const { ws, repo, design } = await setup();
    const theirs = t.github.pulls.openAsSomeone(repo, { head: BRANCH, login: "maya" });

    const { status, body } = await call(t, as(ws, "maya"), "POST", path(design.id));
    expect(status).toBe(200);
    expect(body.pullRequest).toMatchObject({ number: theirs.number, author: { login: "maya" } });
  });

  test("refused for Scratch, an unpushed branch, a branch with nothing new, and a reader", async () => {
    const { ws, repo, design } = await setup({ pushed: false });
    const scratch = await designIn(t, ws, "maya", emptyDoc("Lisbon"), "scratch");
    const open = (designId: string, who = "maya") => call(t, as(ws, who), "POST", path(designId));
    const code = async (designId: string, who?: string) =>
      (await open(designId, who)).body.error?.code;

    const unbranched = await designIn(t, ws, "maya", emptyDoc("Fresh"));

    expect(await code(scratch.id)).toBe("no_repository");
    expect(await code(unbranched.id)).toBe("branch_not_pushed");
    expect(await code(design.id)).toBe("branch_not_pushed");
    // On GitHub, but with nothing main lacks.
    t.github.pulls.createBranch(repo, BRANCH);
    expect(await code(design.id)).toBe("no_changes");
    t.github.pulls.push(repo, BRANCH);
    expect(await code(design.id, "ines")).toBe("forbidden");
    expect(t.github.pulls.actions).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ kind: "open", by: "ines" })]),
    );
  });

  test("a private repo on a plan with no drafts gets a ready one", async () => {
    const { ws, repo, design } = await setup();
    t.github.pulls.settings(repo, { draftsUnsupported: true });

    const body = await opened(ws, design.id);
    expect(body.pullRequest.state).toBe("open");
  });

  test("a public repo's description carries no preview: its address opens the design's files", async () => {
    const { ws, repo, design } = await setup({ isPrivate: false });
    await t.db.execute(`update designs set preview_seq = 4 where id = '${design.id}'`);

    await opened(ws, design.id);
    const pull = t.github.pulls.latest(repo)!;
    expect(pull.body).not.toContain(TEST_ASSETS_URL);
    expect(pull.body).toContain(`https://ponzu.design/designs/${design.id}`);
  });
});

describe("the agent's summary", () => {
  test("is written into the open pull request in place, leaving what people wrote around it", async () => {
    const { ws, repo, design } = await setup();
    const runner = await startRunner(t, design.id);
    const say = (summary: string) =>
      call(t, runner.headers, "POST", "/v1/runner/pull-request-summary", { summary });
    await opened(ws, design.id);
    const pull = t.github.pulls.latest(repo)!;
    pull.body = `Context from Theo.\n\n${pull.body}`;

    expect(await say("First take.")).toEqual({ status: 200, body: { pullRequest: pull.number } });
    expect(await say("Second take.")).toEqual({ status: 200, body: { pullRequest: pull.number } });
    expect(pull.body).toStartWith("Context from Theo.");
    expect(pull.body).toContain("Second take.");
    expect(pull.body).not.toContain("First take.");

    // Someone rewrote the description on GitHub: it is theirs now.
    pull.body = "Rewritten by hand.";
    expect(await say("Third take.")).toEqual({ status: 200, body: { pullRequest: null } });
    expect(pull.body).toBe("Rewritten by hand.");
  });
});

describe("acting", () => {
  /** A design with its pull request open, ready for review, and known to be mergeable. */
  async function ready() {
    const context = await setup();
    await opened(context.ws, context.design.id);
    const pull = t.github.pulls.latest(context.repo)!;
    pull.draft = false;
    return { ...context, pull };
  }

  const act = (ws: Workspace, designId: string, action: string, body?: unknown, method = "POST") =>
    call(t, as(ws, "maya"), method, path(designId, `/${action}`), body);
  const codeOf = async (response: Promise<{ body: any }>) => (await response).body.error?.code;

  test("ready, as the person", async () => {
    const { ws, repo, design } = await setup();
    await opened(ws, design.id);

    const { status, body } = await act(ws, design.id, "ready");
    expect(status).toBe(200);
    expect(body).toMatchObject({ pullRequest: { state: "open" }, nextAction: "merge" });
    expect(t.github.pulls.actions.at(-1)).toMatchObject({ kind: "ready", by: "maya" });
    expect(t.github.pulls.latest(repo)!.draft).toBe(false);
    expect(await getDesign(t.db, design.id)).toMatchObject({ prState: "open" });
  });

  test("merge, as the person, the first way the repo allows: the design settles once", async () => {
    const { ws, repo, design, pull } = await ready();
    t.github.pulls.settings(repo, { squash: false });

    const { status, body } = await act(ws, design.id, "merge", {
      headSha: t.github.pulls.head(repo, BRANCH),
    });
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
    expect(await getDesign(t.db, design.id)).toMatchObject({
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
    expect((await notices(design.id)).map((notice: any) => notice.state)).toEqual([
      "draft",
      "merged",
    ]);
    // Merging again is the same answer.
    expect((await act(ws, design.id, "merge", {})).body.pullRequest.state).toBe("merged");
  });

  test("a design reopened after its merge stays open", async () => {
    const { ws, design } = await ready();
    await act(ws, design.id, "merge", {});
    await call(t, as(ws, "maya"), "PATCH", `/v1/designs/${design.id}`, { settled: false });

    await call(t, as(ws, "ines"), "GET", path(design.id));
    expect(await getDesign(t.db, design.id)).toMatchObject({ status: "active", prState: "merged" });
  });

  test("merge is refused with a reason a person can act on", async () => {
    const { ws, repo, design, pull } = await ready();
    const merge = (body: unknown = {}) => codeOf(act(ws, design.id, "merge", body));
    const head = () => t.github.pulls.head(repo, BRANCH)!;

    expect(await merge({ headSha: "f".repeat(40) })).toBe("head_moved");

    pull.conflicting = true;
    expect(await merge()).toBe("merge_conflicts");
    pull.conflicting = false;

    t.github.pulls.protect(repo, "main", { requiredApprovals: 1, requiredChecks: ["ci"] });
    expect(await merge()).toBe("review_required");
    t.github.pulls.review(pull, "theo", "CHANGES_REQUESTED");
    expect(await merge()).toBe("changes_requested");
    pull.reviews = [];
    t.github.pulls.review(pull, "theo", "APPROVED");
    t.github.pulls.setChecks(head(), [{ name: "ci", state: "failure" }]);
    expect(await merge()).toBe("checks_failing");
    t.github.pulls.setChecks(head(), [{ name: "ci", state: "in_progress" }]);
    expect(await merge()).toBe("checks_pending");

    t.github.pulls.setChecks(head(), [{ name: "ci", state: "success" }]);
    t.github.pulls.protect(repo, "main", { strict: true });
    t.github.pulls.push(repo, "main");
    t.clock.advance(MERGEABLE_AFTER_MS);
    expect(await merge()).toBe("branch_behind");

    pull.draft = true;
    expect(await merge()).toBe("pull_request_draft");
    expect(pull.merged).toBe(false);
    expect(await getDesign(t.db, design.id)).toMatchObject({ status: "active" });
  });

  test("merge waits a moment while GitHub works out whether it can, then says so", async () => {
    const { ws, repo, design } = await setup();
    await call(t, as(ws, "maya"), "POST", path(design.id));
    t.github.pulls.latest(repo)!.draft = false;

    // Straight after opening, before the background read is done.
    t.github.pulls.latest(repo)!.mergeableAt = Number.POSITIVE_INFINITY;
    expect(await codeOf(act(ws, design.id, "merge", {}))).toBe("mergeability_unknown");
    await t.backgroundDone();
    t.github.pulls.latest(repo)!.mergeableAt = t.clock.now() + 2_500;
    expect((await act(ws, design.id, "merge", {})).body.pullRequest.state).toBe("merged");
  });

  test("a reader may look but not act; there is nothing to act on before it opens", async () => {
    const { ws, design } = await setup();
    expect(await codeOf(act(ws, design.id, "merge", {}))).toBe("no_pull_request");
    await opened(ws, design.id);
    const asInes = await call(t, as(ws, "ines"), "POST", path(design.id, "/merge"), {});
    expect(asInes).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  });

  test("auto-merge, where the repo allows it and there is something to wait for", async () => {
    const { ws, repo, design } = await ready();
    expect(await codeOf(act(ws, design.id, "auto-merge"))).toBe("auto_merge_not_allowed");

    t.github.pulls.settings(repo, { autoMerge: true });
    expect(await codeOf(act(ws, design.id, "auto-merge"))).toBe("already_mergeable");

    t.github.pulls.protect(repo, "main", { requiredChecks: ["ci"] });
    t.github.pulls.setChecks(t.github.pulls.head(repo, BRANCH)!, [
      { name: "ci", state: "in_progress" },
    ]);
    const on = await act(ws, design.id, "auto-merge");
    expect(on.body).toMatchObject({
      pullRequest: { autoMerge: { method: "squash", enabledBy: { login: "maya" } } },
      nextAction: "auto_merge",
    });
    expect(await getDesign(t.db, design.id)).toMatchObject({
      prAutoMerge: true,
      prChecks: "running",
    });

    const off = await act(ws, design.id, "auto-merge", undefined, "DELETE");
    expect(off.body.pullRequest.autoMerge).toBeNull();
    expect(await getDesign(t.db, design.id)).toMatchObject({ prAutoMerge: false });
  });

  test("update the branch when it is behind, and only then", async () => {
    const { ws, repo, design } = await ready();
    expect(await codeOf(act(ws, design.id, "update-branch", {}))).toBe("branch_up_to_date");

    t.github.pulls.push(repo, "main");
    const before = t.github.pulls.head(repo, BRANCH)!;
    expect(await codeOf(act(ws, design.id, "update-branch", { headSha: "a".repeat(40) }))).toBe(
      "head_moved",
    );
    const { status, body } = await act(ws, design.id, "update-branch", { headSha: before });
    expect(status).toBe(200);
    expect(body.branch.behindBy).toBe(0);
    expect(t.github.pulls.head(repo, BRANCH)).not.toBe(before);
    expect(t.github.pulls.actions.at(-1)).toMatchObject({ kind: "update_branch", by: "maya" });
    await t.backgroundDone();
    expect(await getDesign(t.db, design.id)).toMatchObject({ prMergeable: true });
  });

  test("close: the thread says so, and the button offers a new one", async () => {
    const { ws, design } = await ready();

    const { body } = await act(ws, design.id, "close");
    expect(body).toMatchObject({ pullRequest: { state: "closed" }, nextAction: "create_pr" });
    expect(await getDesign(t.db, design.id)).toMatchObject({ prState: "closed", status: "active" });
    expect((await notices(design.id)).map((notice: any) => notice.state)).toEqual([
      "draft",
      "closed",
    ]);
    expect(await codeOf(act(ws, design.id, "ready"))).toBe("pull_request_closed");
  });

  test("a person whose GitHub token GitHub no longer takes is asked to sign in again", async () => {
    const { ws, design } = await ready();
    t.github.revokeTokens(ws.people.maya!.github.id);

    expect(await codeOf(act(ws, design.id, "merge", {}))).toBe("github_reauth_required");
  });
});
