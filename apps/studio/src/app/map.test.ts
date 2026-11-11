import { expect, test } from "bun:test";
import type { DesignListRow, PresenceRow } from "@ponzu/client";
import {
  contributors,
  designMembers,
  hereNow,
  isUnseen,
  membersById,
  NO_BRANCH_YET,
  pageTabs,
  pushableRepos,
  SCRATCH_PLACE,
  searchByName,
  toPerson,
  toSummary,
  toWorkspace,
  usableWorkspaces,
} from "./map.ts";

const row = (over: Partial<DesignListRow> = {}): DesignListRow => ({
  id: "dsn_1",
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
  designId: "dsn_1",
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

test("a new design can be made in the repos the person can push to, pushed to lately first", () => {
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

test("unseen: the design moved past what the person last saw, unless it is open now", () => {
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

test("Share lists the owner first, then everyone who can edit", () => {
  const members = [member("usr_sam", "sam", "Sam"), member("usr_maya", "maya", "Maya")];
  expect(designMembers(members, "usr_maya").map((m) => [m.person.login, m.access])).toEqual([
    ["maya", "owner"],
    ["sam", "edit"],
  ]);
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

test("search finds every place the query is in a design's name, whatever its case", () => {
  const people = new Map();
  const designs = [
    toSummary(row({ id: "dsn_1", name: "Hero, hero again" }), { people }),
    toSummary(row({ id: "dsn_2", name: "Pricing" }), { people }),
  ];
  const results = searchByName("HERO", designs);
  expect(results.designs.map((hit) => [hit.design.id, hit.matches])).toEqual([
    [
      "dsn_1",
      [
        [0, 4],
        [6, 10],
      ],
    ],
  ]);
  expect(results.boards).toEqual([]);
  expect(searchByName("  ", designs).designs).toEqual([]);
});
