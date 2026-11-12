import { expect, test } from "bun:test";
import type { PullRequestTab } from "../api.ts";
import { ApiError } from "../errors.ts";
import {
  bodyForTab,
  chromeAction,
  offeredTab,
  prActionError,
  prSummary,
  rowPullRequest,
  rulesWant,
  toPullRequestDetail,
} from "./pull-request-map.ts";

/*
 * A canvas's pull request: the API's answer mapped onto the tab. Each state and action against
 * Ponzu Cloud in memory is tested with the studio's store, in apps/studio/src/app/pull-request.test.ts.
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
  author: { login: "maya", avatarUrl: null, bot: false, ponzu: false },
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
    complete: false,
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
      author: {
        login: "theo",
        avatarUrl: "https://avatars.example/theo",
        bot: false,
        ponzu: false,
      },
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
    {
      id: "c2",
      author: { login: "ponzu-dev", avatarUrl: null, bot: true, ponzu: true },
      body: "Done.",
      at: "2026-11-10T10:25:00.000Z",
      url: "https://github.com/w",
      path: null,
      line: null,
    },
    {
      id: "c3",
      author: { login: "vercel", avatarUrl: null, bot: true, ponzu: false },
      body: "Preview ready.",
      at: "2026-11-10T10:26:00.000Z",
      url: "https://github.com/v",
      path: null,
      line: null,
    },
  ],
  files: {
    total: 340,
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
    headSha: "a".repeat(40),
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
    // GitHub has more than the hundred it listed.
    checksComplete: false,
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
      // The Ponzu App's bot is the agent; another bot is itself.
      {
        id: "c2",
        author: { login: "ponzu-dev", name: null, avatarUrl: null, agent: true },
        body: "Done.",
        at: "2026-11-10T10:25:00.000Z",
        path: null,
        line: null,
        url: "https://github.com/w",
      },
      {
        id: "c3",
        author: { login: "vercel", name: null, avatarUrl: null, agent: false },
        body: "Preview ready.",
        at: "2026-11-10T10:26:00.000Z",
        path: null,
        line: null,
        url: "https://github.com/v",
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
    filesTotal: 340,
  });
  const merged = { ...API_PULL, state: "merged" as const, mergedAt: "2026-11-10T12:00:00.000Z" };
  expect(toPullRequestDetail(merged).endedAt).toBe("2026-11-10T12:00:00.000Z");
});

test("the chrome's mark comes from the canvas's head, and its button from the API's next action", () => {
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
    branch: {
      name: "pz/hero",
      base: "main",
      exists: true,
      aheadBy: 1,
      behindBy: 0,
      unpushed: 0,
      pushError: null,
    },
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

test("an answer kept from before is offered only while the row and the head still say the same", () => {
  const kept = {
    branch: {
      name: "pz/hero",
      base: "main",
      exists: true,
      aheadBy: 1,
      behindBy: 0,
      unpushed: 0,
      pushError: null,
    },
    pullRequest: API_PULL,
    mergeMethod: "squash" as const,
    autoMergeAllowed: true,
    nextAction: "merge" as const,
  };
  const now = {
    number: 412,
    state: "open" as const,
    checks: API_PULL.checks.state,
    mergeable: null,
    autoMerge: false,
  };
  // The same pull request, as it was: Merge, from the first frame.
  expect(offeredTab({ tab: kept, confirmed: false }, now)).toBe(kept);
  // Merged, closed or its checks moved while the canvas was away: not until the read says.
  expect(offeredTab({ tab: kept, confirmed: false }, { ...now, state: "merged" })).toBeNull();
  expect(offeredTab({ tab: kept, confirmed: false }, { ...now, state: "closed" })).toBeNull();
  expect(offeredTab({ tab: kept, confirmed: false }, { ...now, checks: "failing" })).toBeNull();
  expect(offeredTab({ tab: kept, confirmed: false }, { ...now, number: 413 })).toBeNull();
  expect(offeredTab({ tab: kept, confirmed: false }, null)).toBeNull();
  // Read since it opened: GitHub's word stands, even ahead of the head hearing of it.
  expect(offeredTab({ tab: kept, confirmed: true }, { ...now, state: "merged" })).toBe(kept);
  // The row's mark takes whether it can merge only from a read of the same pull request.
  const canvas = { pullRequest: now } as unknown as Parameters<typeof rowPullRequest>[0];
  expect(rowPullRequest(canvas, kept)?.mergeable).toBe(API_PULL.mergeable);
  const merged = { pullRequest: { ...now, state: "merged" } } as unknown as typeof canvas;
  expect(rowPullRequest(merged, kept)?.mergeable).toBeNull();
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

test("the tab shows a description without what Ponzu wrote for GitHub's own page", () => {
  const body = [
    "<!-- ponzu:summary -->\nAdds the **Pro** pricing card.\n<!-- /ponzu:summary -->",
    '<!-- ponzu:picture --><a href="https://ponzu.design/canvases/cnv_1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://assets/d.png"><img src="https://assets/l.png" alt="Pricing card" width="720"></picture></a><!-- /ponzu:picture -->',
    "Made in Ponzu: [Pricing card](https://ponzu.design/canvases/cnv_1)",
    "Reviewer note: <b>kept</b>.",
  ].join("\n\n");
  expect(bodyForTab(body)).toBe("Adds the **Pro** pricing card.\n\nReviewer note: <b>kept</b>.");
  // An empty summary leaves nothing, and neither does the footer of a pull request opened before
  // canvases had their name.
  expect(
    bodyForTab(
      "<!-- ponzu:summary -->\n\n<!-- /ponzu:summary -->\n\nDesigned in Ponzu: [A](https://ponzu.design/designs/des_1)",
    ),
  ).toBe("");
});
