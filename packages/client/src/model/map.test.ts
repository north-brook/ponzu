import { expect, test } from "bun:test";
import type { SearchAnswer } from "../api.ts";
import type { CanvasListRow, PresenceRow } from "../live/rows.ts";
import { createFakeBackend } from "../testing/index.ts";
import {
  canvasMembers,
  contributors,
  hereNow,
  isUnseen,
  keepUnchanged,
  membersById,
  NO_BRANCH_YET,
  noResults,
  pageIconKey,
  pageTabs,
  pushableRepos,
  SCRATCH_PLACE,
  searchByName,
  toPerson,
  toSearchResults,
  toSummary,
  toWorkspace,
  usableWorkspaces,
} from "./map.ts";

const row = (over: Partial<CanvasListRow> = {}): CanvasListRow => ({
  id: "cnv_1",
  workspaceId: "ws_1",
  repoId: "repo_1",
  repoFullName: "north-brook/ponzu",
  ownerId: "usr_maya",
  name: "Onboarding",
  icon: null,
  branch: "pz/onboarding",
  status: "active",
  settledAt: null,
  seq: 4,
  previewSeq: null,
  agentState: "idle",
  agentStatus: null,
  agentBlocker: null,
  needsYouCount: 0,
  prNumber: null,
  prState: null,
  prChecks: "none",
  lastActivityAt: "2026-11-10T10:00:00.000Z",
  createdAt: "2026-11-10T09:00:00.000Z",
  assetKeyRotatedAt: null,
  seenSeq: 4,
  seenThreadSeq: null,
  ...over,
});

const member = (userId: string, login: string, name: string | null) => ({
  userId,
  githubLogin: login,
  name,
  avatarUrl: null,
  role: "member" as const,
  githubAccess: "member" as const,
});

const presence = (userId: string, login: string): PresenceRow => ({
  canvasId: "cnv_1",
  userId,
  pageId: null,
  joinedAt: "2026-11-10T10:00:00.000Z",
  seenAt: "2026-11-10T10:00:00.000Z",
  githubLogin: login,
  name: null,
  avatarUrl: null,
});

test("a person is called by their name, or their login when GitHub has none", () => {
  expect(toPerson("usr_1", { githubLogin: "maya", name: "Maya Ortiz", avatarUrl: null })).toEqual({
    id: "usr_1",
    name: "Maya Ortiz",
    login: "maya",
    avatarUrl: null,
  });
  expect(toPerson("usr_2", { githubLogin: "sam", name: "  ", avatarUrl: "a.png" }).name).toBe(
    "sam",
  );
});

test("the switcher calls a personal workspace Personal, and offers only those Ponzu can work in", () => {
  const ws = (over: object) => ({
    id: "ws_1",
    githubLogin: "maya",
    name: "maya",
    kind: "personal" as const,
    avatarUrl: null,
    role: "admin" as const,
    installed: true,
    suspended: false,
    ...over,
  });
  expect(toWorkspace(ws({})).name).toBe("Personal");
  expect(toWorkspace(ws({ kind: "org", name: "Northbrook" })).name).toBe("Northbrook");
  expect(
    usableWorkspaces([
      ws({ id: "ws_a" }),
      ws({ id: "ws_b", installed: false }),
      ws({ id: "ws_c", suspended: true }),
    ]).map((w) => w.id),
  ).toEqual(["ws_a"]);
});

test("a new canvas can be made in the repos the person can push to, pushed to lately first", () => {
  const repo = (id: string, canPush: boolean, pushedAt: string | null) => ({
    id,
    fullName: `north-brook/${id}`,
    name: id,
    defaultBranch: "main",
    private: true,
    pushedAt,
    canPush,
  });
  expect(
    pushableRepos([
      repo("old", true, "2026-01-01T00:00:00.000Z"),
      repo("readonly", false, "2026-11-01T00:00:00.000Z"),
      repo("new", true, "2026-11-09T00:00:00.000Z"),
      repo("never", true, null),
    ]),
  ).toEqual([
    { id: "new", owner: "north-brook", name: "new" },
    { id: "old", owner: "north-brook", name: "old" },
    { id: "never", owner: "north-brook", name: "never" },
  ]);
});

test("a row: where it lives, whose it is, and what it's waiting on", () => {
  const people = membersById([member("usr_maya", "maya", "Maya")]);
  const summary = toSummary(
    row({
      needsYouCount: 2,
      agentState: "working",
      prNumber: 12,
      prState: "open",
      prChecks: "failing",
    }),
    { people },
  );
  expect(summary.project).toEqual({
    kind: "repo",
    repo: { id: "repo_1", owner: "north-brook", name: "ponzu" },
    branch: "pz/onboarding",
  });
  expect(summary.owner?.name).toBe("Maya");
  expect(summary.needsYou).toBe(2);
  expect(summary.agentState).toBe("working");
  expect(summary.pullRequest).toEqual({
    number: 12,
    state: "open",
    checks: "failing",
    mergeable: null,
    autoMerge: false,
  });
  // Before the agent makes its branch, and for Scratch.
  expect(toSummary(row({ branch: null }), { people }).project).toMatchObject({
    branch: NO_BRANCH_YET,
  });
  expect(toSummary(row({ repoId: null, repoFullName: null }), { people }).project).toEqual({
    kind: "scratch",
    city: SCRATCH_PLACE,
  });
  // An owner who has left the workspace is nobody to filter by.
  expect(toSummary(row({ ownerId: "usr_gone" }), { people }).owner).toBeNull();
});

test("unseen: the canvas moved past what the person last saw, unless it is open now", () => {
  expect(isUnseen({ seq: 4, seenSeq: 4 })).toBe(false);
  expect(isUnseen({ seq: 5, seenSeq: 4 })).toBe(true);
  // Never opened: unseen once it has anything in it.
  expect(isUnseen({ seq: 0, seenSeq: null })).toBe(false);
  expect(isUnseen({ seq: 3, seenSeq: null })).toBe(true);
  const people = new Map();
  expect(toSummary(row({ seq: 9, seenSeq: 4 }), { people }).unseen).toBe(true);
  expect(toSummary(row({ seq: 9, seenSeq: 4 }), { people, open: true }).unseen).toBe(false);
});

test("who is here: the viewer first in the chrome, and never among the others", () => {
  const me = toPerson("usr_maya", { githubLogin: "maya", name: "Maya", avatarUrl: null });
  const rows = [presence("usr_maya", "maya"), presence("usr_sam", "sam")];
  expect(hereNow(rows, me.id).map((p) => p.login)).toEqual(["sam"]);
  expect(contributors(rows, me).map((c) => [c.person.login, c.here])).toEqual([
    ["maya", true],
    ["sam", true],
  ]);
  // Whoever worked on it and has gone is there too, faded, with when the thread last heard them.
  const jordan = toPerson("usr_jordan", { githubLogin: "jordan", name: null, avatarUrl: null });
  const sam = toPerson("usr_sam", { githubLogin: "sam", name: null, avatarUrl: null });
  const worked = [
    { person: sam, at: "2026-11-10T09:00:00.000Z" },
    { person: jordan, at: "2026-11-08T09:00:00.000Z" },
  ];
  expect(contributors(rows, me, worked).map((c) => [c.person.login, c.here, c.lastHereAt])).toEqual(
    [
      ["maya", true, null],
      ["sam", true, null],
      ["jordan", false, "2026-11-08T09:00:00.000Z"],
    ],
  );
});

test("a row's preview is under its files, at the seq its pictures show; none before it has one", () => {
  const people = new Map();
  expect(toSummary(row(), { people, assetsUrl: "https://assets.test/k/" }).preview).toBeNull();
  expect(toSummary(row({ previewSeq: 12 }), { people }).preview).toBeNull();
  expect(
    toSummary(row({ previewSeq: 12 }), { people, assetsUrl: "https://assets.test/k/" }).preview,
  ).toEqual({
    light: "https://assets.test/k/previews/12-light.png",
    dark: "https://assets.test/k/previews/12-dark.png",
  });
});

test("a live update keeps what it didn't change: other rows, and an unchanged preview", () => {
  const people = membersById([member("usr_maya", "maya", "Maya")]);
  const at = { people, assetsUrl: "https://assets.test/k/" };
  const before = [
    toSummary(row({ previewSeq: 12 }), at),
    toSummary(row({ id: "cnv_2", previewSeq: 3, prNumber: 7, prState: "open" }), at),
  ];
  // The first row's status moved on; the second came back as a new object, the same.
  const after = keepUnchanged(before, [
    toSummary(row({ previewSeq: 12, agentState: "working", seq: 5 }), at),
    toSummary(row({ id: "cnv_2", previewSeq: 3, prNumber: 7, prState: "open" }), at),
  ]);
  expect(after).not.toBe(before);
  expect(after[0]).not.toBe(before[0]);
  expect(after[0]!.agentState).toBe("working");
  expect(after[0]!.preview).toBe(before[0]!.preview);
  expect(after[0]!.project).toBe(before[0]!.project);
  expect(after[1]).toBe(before[1]);
  // Rows that swap places are still matched by id.
  const swapped = keepUnchanged(after, [after[1]!, { ...after[0]! }]);
  expect(swapped[1]).toBe(after[0]);
  // A new preview is new; nothing changed at all is the very same list.
  const moved = keepUnchanged(after, [toSummary(row({ previewSeq: 13 }), at), after[1]!]);
  expect(moved[0]!.preview).not.toBe(after[0]!.preview);
  expect(moved[0]!.preview?.light).toBe("https://assets.test/k/previews/13-light.png");
  expect(keepUnchanged(after, [...after])).toBe(after);
});

test("Share lists the owner first, then everyone who can edit", () => {
  const members = [member("usr_sam", "sam", "Sam"), member("usr_maya", "maya", "Maya")];
  expect(canvasMembers(members, "usr_maya").map((m) => [m.person.login, m.access])).toEqual([
    ["maya", "owner"],
    ["sam", "edit"],
  ]);
});

test("Share lists everyone GitHub gives access to the repo, who hasn't opened Ponzu too", async () => {
  const backend = createFakeBackend();
  const bryce = backend.addPerson({ login: "brycedbjork", name: "Bryce Bjork" });
  const maya = backend.addPerson({ login: "maya", name: "Maya Ortiz" });
  const ws = backend.addWorkspace({
    login: "north-brook",
    members: { [bryce.id]: "admin", [maya.id]: "member" },
    repos: [{ name: "fernwood", access: { [maya.id]: "read" } }, { name: "other" }],
    githubOnly: [
      { login: "tingqgao", name: "Ting Gao", repos: { fernwood: "write" } },
      // Only in another repo: not someone who can open this canvas.
      { login: "elsewhere", repos: { other: "write" } },
    ],
  });
  const { api } = backend.connect(bryce);
  const canvas = await api.canvases.create({ workspaceId: ws.id, repoId: ws.repos[0]!.id });

  const { people } = await api.canvases.people(canvas.id);
  const members = canvasMembers([], bryce.id, people);
  expect(members.map((m) => [m.person.login, m.access, m.joined])).toEqual([
    ["brycedbjork", "owner", true],
    ["maya", "view", true],
    ["tingqgao", "edit", false],
  ]);
  expect(members[2]!.person.id).toStartWith("github:");
});

test("a page is working while the agent is on one of its boards", () => {
  const pages = [
    { id: "pg_1", name: "Home", icon: "home", artboards: [{ id: "ab_1" }] },
    { id: "pg_2", name: "Pricing", artboards: [{ id: "ab_2" }] },
  ];
  expect(pageTabs(pages, ["ab_2"])).toEqual([
    { id: "pg_1", name: "Home", icon: "home", working: false },
    { id: "pg_2", name: "Pricing", icon: null, working: true },
  ]);
});

test("search finds every place the query is in a canvas's name, whatever its case", () => {
  const people = new Map();
  const canvases = [
    toSummary(row({ id: "cnv_1", name: "Hero, hero again" }), { people }),
    toSummary(row({ id: "cnv_2", name: "Pricing" }), { people }),
  ];
  const results = searchByName("HERO", canvases);
  expect(results.canvases.map((hit) => [hit.canvas.id, hit.matches])).toEqual([
    [
      "cnv_1",
      [
        [0, 4],
        [6, 10],
      ],
    ],
  ]);
  expect(results).toEqual({ ...noResults("HERO"), canvases: results.canvases });
  expect(searchByName("  ", canvases).canvases).toEqual([]);
});

function commentOf(messageId: string): SearchAnswer["comments"][number] {
  return {
    canvasId: "cnv_1",
    canvasName: "Hero",
    threadId: "th_2",
    messageId,
    pageId: null,
    artboardId: null,
    resolved: false,
    snippet: "hero",
    matches: [[0, 4]],
    author: { kind: "agent" },
    at: "2026-11-10T09:00:00.000Z",
  };
}

test("search's answer is put with the canvases the window lists, and hits on any other dropped", () => {
  const people = new Map();
  const listed = [
    toSummary(row({ id: "cnv_1", name: "Hero" }), { people }),
    toSummary(row({ id: "cnv_2", name: "Pricing", status: "settled" }), { people }),
  ];
  const maya = {
    kind: "user" as const,
    id: "usr_maya",
    name: " ",
    login: "maya",
    avatarUrl: "a.png",
  };
  const gone = "cnv_gone";
  const answer: SearchAnswer = {
    query: "hero",
    canvases: [
      { canvasId: "cnv_1", name: "Hero", matches: [[0, 4]] },
      // Gone from the list since the answer was made (deleted, or its repo taken away).
      { canvasId: gone, name: "Hero gone", matches: [[0, 4]] },
    ],
    boards: [
      {
        canvasId: "cnv_2",
        canvasName: "Pricing",
        kind: "page",
        id: "pg_1",
        pageId: null,
        name: "Hero page",
        matches: [[0, 4]],
      },
      // The same page id on another canvas (a duplicate keeps its pages' ids): not its icon.
      {
        canvasId: "cnv_1",
        canvasName: "Hero",
        kind: "page",
        id: "pg_1",
        pageId: null,
        name: "Hero copy",
        matches: [[0, 4]],
      },
      {
        canvasId: "cnv_1",
        canvasName: "Hero",
        kind: "board",
        id: "ab_1",
        pageId: "pg_9",
        name: "Hero B",
        matches: [[0, 4]],
      },
      {
        canvasId: gone,
        canvasName: "x",
        kind: "board",
        id: "ab_2",
        pageId: null,
        name: "Hero",
        matches: [[0, 4]],
      },
    ],
    comments: [
      {
        ...commentOf("msg_1"),
        threadId: "th_1",
        pageId: "pg_9",
        artboardId: "ab_1",
        resolved: true,
        snippet: "…the hero again",
        matches: [[5, 9]],
        author: maya,
        at: "2026-11-10T09:30:00.000Z",
      },
      { ...commentOf("msg_2"), author: { kind: "agent" } },
      { ...commentOf("msg_3"), author: { kind: "deleted" }, at: null },
      { ...commentOf("msg_4"), canvasId: gone },
    ],
    messages: [
      {
        canvasId: "cnv_2",
        canvasName: "Pricing",
        itemId: "itm_1",
        itemSeq: 7,
        snippet: "hero",
        matches: [[0, 4]],
        author: { kind: "agent" },
        at: null,
      },
      {
        canvasId: gone,
        canvasName: "x",
        itemId: "itm_2",
        itemSeq: 1,
        snippet: "hero",
        matches: [[0, 4]],
        author: { kind: "agent" },
        at: null,
      },
    ],
    pullRequests: [
      {
        canvasId: "cnv_1",
        canvasName: "Hero",
        number: 412,
        title: "Hero",
        matches: [[0, 4]],
        state: "open",
      },
      { canvasId: gone, canvasName: "x", number: 9, title: "Hero", matches: [[0, 4]], state: null },
    ],
    people: [
      {
        userId: "usr_maya",
        login: "maya",
        name: "Maya",
        avatarUrl: null,
        nameMatches: [],
        loginMatches: [[0, 4]],
      },
    ],
  };
  const results = toSearchResults(
    answer,
    listed,
    new Map([[pageIconKey("cnv_2", "pg_1"), "card"]]),
  );
  expect(results.query).toBe("hero");
  expect(results.canvases).toEqual([{ canvas: listed[0]!, matches: [[0, 4]] }]);
  // The list's own summary, preview and all: the answer carries none of that.
  expect(results.canvases[0]!.canvas).toBe(listed[0]!);
  expect(results.boards).toEqual([
    {
      id: "pg_1",
      place: "page",
      pageId: "pg_1",
      name: "Hero page",
      icon: "card",
      matches: [[0, 4]],
      canvas: { id: "cnv_2", name: "Pricing" },
    },
    {
      id: "pg_1",
      place: "page",
      pageId: "pg_1",
      name: "Hero copy",
      icon: null,
      matches: [[0, 4]],
      canvas: { id: "cnv_1", name: "Hero" },
    },
    {
      id: "ab_1",
      place: "board",
      pageId: "pg_9",
      name: "Hero B",
      icon: null,
      matches: [[0, 4]],
      canvas: { id: "cnv_1", name: "Hero" },
    },
  ]);
  expect(results.comments).toEqual([
    {
      id: "msg_1",
      threadId: "th_1",
      pageId: "pg_9",
      artboardId: "ab_1",
      resolved: true,
      snippet: "…the hero again",
      matches: [[5, 9]],
      // A blank name: the login, as everywhere a person is named.
      author: { id: "usr_maya", name: "maya", login: "maya", avatarUrl: "a.png" },
      canvas: { id: "cnv_1", name: "Hero" },
      at: "2026-11-10T09:30:00.000Z",
    },
    expect.objectContaining({ id: "msg_2", author: "agent" }),
    expect.objectContaining({ id: "msg_3", author: "deleted", at: null }),
  ]);
  expect(results.messages).toEqual([
    {
      id: "itm_1",
      seq: 7,
      snippet: "hero",
      matches: [[0, 4]],
      author: "agent",
      canvas: { id: "cnv_2", name: "Pricing" },
      at: null,
    },
  ]);
  expect(results.pullRequests).toEqual([
    {
      number: 412,
      title: "Hero",
      matches: [[0, 4]],
      state: "open",
      canvas: { id: "cnv_1", name: "Hero" },
    },
  ]);
  expect(results.people).toEqual([
    {
      id: "usr_maya",
      login: "maya",
      name: "Maya",
      avatarUrl: null,
      nameMatches: [],
      loginMatches: [[0, 4]],
    },
  ]);
});

test("a canvas renamed since the answer shows the answer's name, which its matches are into", () => {
  const listed = [toSummary(row({ id: "cnv_1", name: "Pricing" }), { people: new Map() })];
  const answer: SearchAnswer = {
    query: "hero",
    canvases: [{ canvasId: "cnv_1", name: "Hero", matches: [[0, 4]] }],
    boards: [],
    comments: [],
    messages: [],
    pullRequests: [],
    people: [],
  };
  const [hit] = toSearchResults(answer, listed).canvases;
  expect(hit!.canvas).toEqual({ ...listed[0]!, name: "Hero" });
});
