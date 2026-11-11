import { expect, test } from "bun:test";
import { ApiError, type PullRequestTab } from "@ponzu/client";
import { createFakeBackend, settle } from "@ponzu/client/testing";
import {
  chromeAction,
  prActionError,
  prSummary,
  rulesWant,
  toPullRequestDetail,
} from "./pull-request-map.ts";
import { PullRequestStore } from "./pull-request-store.ts";

/*
 * A design's pull request: the API's answer mapped onto the tab, and each state and action on
 * Ponzu Cloud in memory, which keeps the API's next action and refusals.
 */

type Pull = NonNullable<PullRequestTab["pullRequest"]>;

const API_PULL: Pull = {
  number: 412,
  url: "https://github.com/north-brook/fernwood/pull/412",
  title: "Quieter hero",
  body: "Drops the paragraph. <img src=x onerror=alert(1)>",
  state: "open",
  head: { ref: "pz/hero", sha: "a".repeat(40) },
  base: { ref: "main" },
  author: { login: "maya", avatarUrl: null, bot: false },
  mergedBy: null,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T11:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  mergeable: true,
  mergeState: "blocked",
  reviewDecision: "review_required",
  autoMerge: null,
  checks: {
    state: "running",
    complete: true,
    items: [
      {
        name: "ci / test",
        app: "GitHub Actions",
        required: true,
        state: "running",
        url: "https://ci.example/test",
        startedAt: "2026-11-10T10:01:00.000Z",
        completedAt: null,
      },
      {
        name: "deploy",
        app: null,
        required: false,
        state: "cancelled",
        url: null,
        startedAt: null,
        completedAt: null,
      },
      {
        name: "lint",
        app: "GitHub Actions",
        required: false,
        state: "neutral",
        url: null,
        startedAt: null,
        completedAt: null,
      },
    ],
  },
  reviews: [
    {
      id: "r1",
      author: { login: "theo", avatarUrl: "https://avatars.example/theo", bot: false },
      state: "approved",
      at: "2026-11-10T10:30:00.000Z",
      url: "https://github.com/x",
    },
    { id: "r2", author: null, state: "dismissed", at: null, url: "https://github.com/y" },
  ],
  conversation: [
    {
      id: "c1",
      author: null,
      body: "Can the comma match?",
      at: "2026-11-10T10:20:00.000Z",
      url: "https://github.com/z",
      path: "src/hero.tsx",
      line: 15,
    },
  ],
  files: {
    total: 2,
    additions: 30,
    deletions: 4,
    items: [
      { path: "src/hero.tsx", change: "modified", additions: 20, deletions: 4 },
      { path: "src/old.tsx", change: "deleted", additions: 0, deletions: 0 },
    ],
  },
  commits: { total: 1, items: [] },
};

test("the API's pull request, field by field, as the tab draws it", () => {
  expect(toPullRequestDetail(API_PULL)).toEqual({
    number: 412,
    url: "https://github.com/north-brook/fernwood/pull/412",
    title: "Quieter hero",
    // Untrusted, and passed on as text: the tab draws it through Prose.
    body: "Drops the paragraph. <img src=x onerror=alert(1)>",
    head: "pz/hero",
    base: "main",
    state: "open",
    endedAt: null,
    additions: 30,
    deletions: 4,
    checks: [
      {
        id: "GitHub Actions:ci / test:0",
        name: "ci / test",
        state: "running",
        startedAt: "2026-11-10T10:01:00.000Z",
        completedAt: null,
        description: null,
        url: "https://ci.example/test",
      },
      {
        id: "status:deploy:1",
        name: "deploy",
        state: "failing",
        startedAt: null,
        completedAt: null,
        description: null,
        url: null,
      },
      {
        id: "GitHub Actions:lint:2",
        name: "lint",
        state: "skipped",
        startedAt: null,
        completedAt: null,
        description: null,
        url: null,
      },
    ],
    comments: [
      {
        id: "c1",
        author: { login: "ghost", name: null, avatarUrl: null, agent: false },
        body: "Can the comma match?",
        at: "2026-11-10T10:20:00.000Z",
        path: "src/hero.tsx",
        line: 15,
        url: "https://github.com/z",
      },
    ],
    // A dismissed review no longer stands.
    reviews: [
      {
        id: "r1",
        author: {
          login: "theo",
          name: null,
          avatarUrl: "https://avatars.example/theo",
          agent: false,
        },
        state: "approved",
        at: "2026-11-10T10:30:00.000Z",
      },
    ],
    files: [
      {
        path: "src/hero.tsx",
        previousPath: null,
        status: "modified",
        additions: 20,
        deletions: 4,
        diff: null,
      },
      {
        path: "src/old.tsx",
        previousPath: null,
        status: "removed",
        additions: 0,
        deletions: 0,
        diff: null,
      },
    ],
  });
  const merged = { ...API_PULL, state: "merged" as const, mergedAt: "2026-11-10T12:00:00.000Z" };
  expect(toPullRequestDetail(merged).endedAt).toBe("2026-11-10T12:00:00.000Z");
});

test("the chrome's mark comes from the design's head, and its button from the API's next action", () => {
  expect(prSummary(undefined)).toBeNull();
  const head = {
    prNumber: 412,
    prState: "open" as const,
    prChecks: "passing" as const,
    prMergeable: true,
    prAutoMerge: false,
  };
  expect(prSummary(head)).toEqual({
    number: 412,
    state: "open",
    checks: "passing",
    mergeable: true,
    autoMerge: false,
  });
  expect(prSummary({ ...head, prNumber: null, prState: null })).toBeNull();

  const tab = (nextAction: PullRequestTab["nextAction"], pull: Pull | null = API_PULL) => ({
    branch: { name: "pz/hero", base: "main", exists: true, aheadBy: 1, behindBy: 0 },
    pullRequest: pull,
    mergeMethod: "squash" as const,
    autoMergeAllowed: true,
    nextAction,
  });
  expect(chromeAction(tab("none"))).toBeNull();
  expect(chromeAction(tab("merge"))).toBe("merge");
  expect(chromeAction(tab("blocked"))).toBe("blocked");
  expect(chromeAction(tab("update_branch"))).toBe("update_branch");
  expect(chromeAction(tab("auto_merge"))).toBe("auto_merge");
  const waiting = { ...API_PULL, autoMerge: { method: "squash" as const, enabledBy: null } };
  expect(chromeAction(tab("auto_merge", waiting))).toBe("auto_merge_on");

  expect(rulesWant(API_PULL)).toBe("The repo's rules want an approving review.");
  expect(rulesWant({ ...API_PULL, reviewDecision: null })).toBe(
    "Checks the repo's rules require haven't finished.",
  );
});

test("each refusal says why in a sentence: the API's own where it writes one", () => {
  const conflict = new ApiError(409, "merge_conflicts", "pz/hero conflicts with main.");
  expect(prActionError(conflict)).toBe("pz/hero conflicts with main.");
  expect(prActionError(new ApiError(0, "network", "x"))).toBe(
    "Ponzu can't be reached. Check your connection and try again.",
  );
  expect(prActionError(new ApiError(401, "github_reauth_required", "x"))).toBe(
    "GitHub needs you to sign in to Ponzu again before it acts for you.",
  );
  expect(prActionError(new ApiError(500, "internal", "Stack trace"))).toBe(
    "That didn't work. Try again.",
  );
  expect(prActionError(new Error("boom"))).toBe("That didn't work. Try again.");
});

async function world() {
  const backend = createFakeBackend();
  const maya = backend.addPerson({ login: "maya", name: "Maya" });
  const ws = backend.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin" },
    repos: [{ name: "site" }],
  });
  const client = backend.connect(maya);
  const design = await client.api.designs.create({
    workspaceId: ws.id,
    repoId: ws.repos[0]!.id,
    name: "Pricing",
  });
  const said: string[] = [];
  const told: string[] = [];
  const store = new PullRequestStore({
    api: client.api,
    designId: design.id,
    say: (m) => said.push(m),
    tellAgent: (t) => told.push(t),
  });
  const github = backend.design(design.id).github!;
  const read = async () => {
    store.refresh();
    await settle();
    return store.getSnapshot();
  };
  const run = async (action: Parameters<PullRequestStore["run"]>[0]) => {
    store.run(action);
    await settle();
    return store.getSnapshot();
  };
  return { backend, client, design, store, github, said, told, read, run };
}

test("from changes on the branch to a merge: create, ready, merge, and the design settles", async () => {
  const w = await world();
  expect((await w.read()).tab?.nextAction).toBe("none");

  w.backend.agent(w.design.id).push([{ path: "src/pricing.tsx", additions: 40 }]);
  const pushed = await w.read();
  expect(chromeAction(pushed.tab!)).toBe("create_pr");

  w.store.run("create_pr");
  expect(w.store.getSnapshot().busy).toBe("create_pr");
  await settle();
  const opened = w.store.getSnapshot();
  expect(opened.busy).toBeNull();
  expect(opened.tab?.pullRequest).toMatchObject({ state: "draft", title: "Pricing" });
  expect(chromeAction(opened.tab!)).toBe("ready");
  // GitHub's word is said in the thread once, and the head follows.
  const head = await w.client.api.designs.get(w.design.id);
  expect([head.prNumber, head.prState]).toEqual([opened.tab!.pullRequest!.number, "draft"]);

  expect(chromeAction((await w.run("ready")).tab!)).toBe("merge");
  const merged = await w.run("merge");
  expect(merged.tab?.pullRequest?.state).toBe("merged");
  expect(chromeAction(merged.tab!)).toBeNull();
  expect((await w.client.api.designs.get(w.design.id)).status).toBe("settled");
  const notices = w.backend
    .design(w.design.id)
    .thread.map((e) => e.item)
    .filter((i) => i.kind === "notice");
  expect(
    notices.map((n) => n.kind === "notice" && n.payload.type === "pull_request" && n.payload.state),
  ).toEqual(["draft", "merged"]);
  expect(w.said).toEqual([]);
});

test("checks running offer auto-merge; failing ones and conflicts are asked of the agent", async () => {
  const w = await world();
  w.backend.agent(w.design.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");

  w.github.setChecks([{ name: "ci / test", state: "running", required: true }]);
  expect(chromeAction((await w.read()).tab!)).toBe("auto_merge");
  expect(chromeAction((await w.run("auto_merge")).tab!)).toBe("auto_merge_on");
  // Waiting on GitHub: pressing it does nothing.
  await w.run("auto_merge_on");

  w.github.setChecks([{ name: "ci / e2e", state: "failed" }]);
  expect(chromeAction((await w.read()).tab!)).toBe("fix_checks");
  await w.run("fix_checks");
  expect(w.told).toEqual(["Fix the failing checks on the pull request (ci / e2e) and push."]);

  w.github.baseChanged({ conflicts: true });
  expect(chromeAction((await w.read()).tab!)).toBe("resolve");
  await w.run("resolve");
  expect(w.told[1]).toBe(
    "The branch conflicts with main. Merge main in, resolve the conflicts and push.",
  );
});

test("behind its base, Update branch; held by the rules without auto-merge, Merge asks first", async () => {
  const w = await world();
  w.backend.agent(w.design.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");

  w.github.protect({ upToDate: true });
  w.github.baseChanged();
  expect(chromeAction((await w.read()).tab!)).toBe("update_branch");
  expect(chromeAction((await w.run("update_branch")).tab!)).toBe("merge");

  w.github.autoMergeAllowed = false;
  w.github.protect({ review: true });
  const held = await w.read();
  expect(chromeAction(held.tab!)).toBe("blocked");
  // Nothing merges until the person says so.
  expect((await w.run("blocked")).bypass).toEqual({
    reason: "The repo's rules want an approving review.",
  });
  w.store.cancelBypass();
  expect(w.store.getSnapshot().bypass).toBeNull();
  expect(w.store.getSnapshot().tab?.pullRequest?.state).toBe("open");

  await w.run("blocked");
  w.store.confirmBypass();
  await settle();
  expect(w.store.getSnapshot().tab?.pullRequest?.state).toBe("merged");
});

test("a merge GitHub's rules refuse says why, and the button follows what is true now", async () => {
  const w = await world();
  w.backend.agent(w.design.id).push();
  await w.read();
  await w.run("create_pr");
  await w.run("ready");
  w.github.protect({ review: true });
  // The person looked before the rules changed: the button still says Merge.
  const stale = w.store.getSnapshot();
  expect(chromeAction(stale.tab!)).toBe("merge");
  await w.run("merge");
  expect(w.said).toEqual(["The repo's rules want an approving review first."]);
  expect(chromeAction(w.store.getSnapshot().tab!)).toBe("auto_merge");

  // A push since the person looked.
  w.github.protect({ review: false });
  await w.read();
  w.backend.agent(w.design.id).push();
  await w.run("merge");
  expect(w.said[1]).toBe("The branch has new commits since you looked. Look again first.");
});

test("a closed pull request offers to open another once the branch has changes", async () => {
  const w = await world();
  w.backend.agent(w.design.id).push();
  await w.read();
  await w.run("create_pr");
  await w.client.api.designs.pullRequest.close(w.design.id);
  const closed = await w.read();
  expect(closed.tab?.pullRequest?.state).toBe("closed");
  expect(chromeAction(closed.tab!)).toBe("create_pr");
});

test("a file's diff is asked for when its card opens", async () => {
  const w = await world();
  w.backend.agent(w.design.id).push([
    { path: "src/a.tsx", patch: "@@ -1 +1 @@\n-a\n+b" },
    { path: "logo.png", patch: null },
  ]);
  await w.read();
  await w.run("create_pr");
  expect(await w.store.loadDiff("src/a.tsx")).toEqual({
    kind: "text",
    patch: "@@ -1 +1 @@\n-a\n+b",
  });
  expect(await w.store.loadDiff("logo.png")).toEqual({ kind: "binary" });
  await expect(w.store.loadDiff("nope.ts")).rejects.toMatchObject({ code: "not_found" });
});

test("a Scratch design has no pull request to read", async () => {
  const w = await world();
  const scratch = await w.client.api.designs.create({
    workspaceId: (await w.client.api.designs.get(w.design.id)).workspaceId,
  });
  const refused = await w.client.api.designs.pullRequest.get(scratch.id).catch((e) => e);
  expect(refused.code).toBe("no_repository");
});
