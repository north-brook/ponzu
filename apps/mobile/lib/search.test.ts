import { describe, expect, test } from "bun:test";
import { ApiError, type SearchAnswer } from "@ponzu/client";
import type { CanvasSummary, CommentHit, MessageHit } from "@ponzu/client/model";
import {
  askedOf,
  boardLine,
  canvasLine,
  nameHits,
  RECENT_COUNT,
  recentCanvases,
  resultPath,
  searchView,
  subtitle,
  THREADS_CAP,
  threadAge,
  threadLine,
  threadsSection,
} from "./search";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const maya = { id: "usr_maya", name: "Maya Lin", login: "maya", avatarUrl: null };

function canvas(over: Partial<CanvasSummary> = {}): CanvasSummary {
  return {
    id: "cnv_1",
    name: "Pricing page",
    project: {
      kind: "repo",
      repo: { id: "rep_1", owner: "acme", name: "site" },
      branch: "pz/pricing",
    },
    preview: null,
    status: "active",
    agentState: "idle",
    needsYou: 0,
    unseen: false,
    pullRequest: null,
    hereNow: [],
    owner: maya,
    lastActivityAt: ago(4 * MIN),
    settledAt: null,
    ...over,
  };
}

const scratch = { kind: "scratch", city: "lisbon" } as const;

describe("before typing", () => {
  test("the six changed most recently, newest first, settled ones too, ties by id", () => {
    const rows = [
      { canvas: canvas({ id: "cnv_a", lastActivityAt: ago(5 * HOUR) }) },
      { canvas: canvas({ id: "cnv_b", lastActivityAt: ago(1 * MIN) }) },
      { canvas: canvas({ id: "cnv_c", lastActivityAt: ago(2 * DAY), status: "settled" }) },
      { canvas: canvas({ id: "cnv_d", lastActivityAt: ago(3 * HOUR) }) },
      { canvas: canvas({ id: "cnv_f", lastActivityAt: ago(3 * HOUR) }) },
      { canvas: canvas({ id: "cnv_e", lastActivityAt: ago(3 * HOUR) }) },
      { canvas: canvas({ id: "cnv_g", lastActivityAt: ago(9 * DAY) }) },
      { canvas: canvas({ id: "cnv_h", lastActivityAt: ago(12 * MIN) }) },
    ];
    expect(RECENT_COUNT).toBe(6);
    expect(recentCanvases(rows).map((r) => r.canvas.id)).toEqual([
      "cnv_b",
      "cnv_h",
      "cnv_d",
      "cnv_e",
      "cnv_f",
      "cnv_a",
    ]);
    // Fewer than six: what there is. The rows given are left as they were.
    expect(recentCanvases(rows.slice(0, 2)).map((r) => r.canvas.id)).toEqual(["cnv_b", "cnv_a"]);
    expect(rows[0]!.canvas.id).toBe("cnv_a");
    expect(recentCanvases([])).toEqual([]);
  });

  test("the subtitle grammar: [state · ] age [ · branch or Scratch name]", () => {
    const line = (over: Partial<CanvasSummary>, question: { header: string } | null = null) =>
      subtitle({ canvas: canvas(over), question }, NOW);
    // Waiting on the viewer: what it asks about, and no branch.
    expect(line({ needsYou: 1 }, { header: "the headline" })).toBe(
      "Asking about the headline · 4m",
    );
    // Its question not read yet: that it waits.
    expect(line({ needsYou: 2 })).toBe("Waiting for you · 4m");
    // Working, or waking to work: now, with the branch.
    expect(line({ agentState: "working", lastActivityAt: ago(10 * MIN) })).toBe(
      "Claude is working · now · pz/pricing",
    );
    expect(line({ agentState: "waking" })).toBe("Claude is working · now · pz/pricing");
    // Otherwise the age and the branch, or Scratch's place.
    expect(line({ lastActivityAt: ago(2 * HOUR), project: scratch })).toBe("2h · lisbon");
    expect(line({ lastActivityAt: ago(5 * HOUR) })).toBe("5h · pz/pricing");
    expect(
      line({
        lastActivityAt: ago(1 * DAY),
        project: { ...canvas().project, branch: "main" } as CanvasSummary["project"],
      }),
    ).toBe("1d · main");
    expect(line({ lastActivityAt: ago(30 * 1000) })).toBe("now · pz/pricing");
    // Settled says so, whatever it was doing.
    expect(line({ status: "settled", needsYou: 1, lastActivityAt: ago(2 * DAY) })).toBe(
      "Settled · 2d · pz/pricing",
    );
  });
});

describe("result lines", () => {
  test("a canvas: its repo and branch, Scratch and its place, or whose it was once settled", () => {
    expect(canvasLine(canvas(), NOW)).toBe("site · pz/pricing");
    expect(canvasLine(canvas({ project: scratch }), NOW)).toBe("Scratch · lisbon");
    expect(canvasLine(canvas({ status: "settled", settledAt: ago(3 * DAY) }), NOW)).toBe(
      "site · Maya · 3d",
    );
    expect(canvasLine(canvas({ status: "settled", owner: null, settledAt: null }), NOW)).toBe(
      "site",
    );
  });

  test("a page and a board, as the Mac says them", () => {
    const on = { id: "cnv_1", name: "Pricing page" };
    const board = {
      id: "ab_plans",
      place: "board" as const,
      pageId: "pg_1",
      name: "Plans",
      icon: null,
      matches: [],
      canvas: on,
    };
    expect(boardLine(board)).toBe("in Pricing page");
    expect(boardLine({ ...board, place: "page", id: "pg_1" })).toBe("Page in Pricing page");
  });

  test("who said it: a first name, Claude, or Deleted user; a resolved comment says so", () => {
    const said = message({ author: maya });
    expect(threadLine({ kind: "message", hit: said })).toBe("Maya · Pricing page");
    expect(threadLine({ kind: "message", hit: message({ author: "agent" }) })).toBe(
      "Claude · Pricing page",
    );
    expect(threadLine({ kind: "comment", hit: comment({ author: "deleted" }) })).toBe(
      "Deleted user · Pricing page",
    );
    expect(threadLine({ kind: "comment", hit: comment({ resolved: true }) })).toBe(
      "Maya · Pricing page · Resolved",
    );
    expect(threadAge({ kind: "message", hit: message({ at: ago(2 * HOUR) }) }, NOW)).toBe("2h");
    expect(threadAge({ kind: "message", hit: message({ at: null }) }, NOW)).toBeNull();
  });
});

function message(over: Partial<MessageHit> = {}): MessageHit {
  return {
    id: "itm_1",
    seq: 4,
    snippet: "Make the plans easier to compare",
    matches: [[9, 14]],
    author: maya,
    canvas: { id: "cnv_1", name: "Pricing page" },
    at: ago(HOUR),
    ...over,
  };
}

function comment(over: Partial<CommentHit> = {}): CommentHit {
  return {
    id: "m_1",
    threadId: "th_1",
    pageId: "pg_1",
    artboardId: "ab_plans",
    resolved: false,
    snippet: "The plans need more contrast",
    matches: [[4, 9]],
    author: maya,
    canvas: { id: "cnv_1", name: "Pricing page" },
    at: ago(HOUR),
    ...over,
  };
}

describe("Threads", () => {
  test("messages and comments merged newest first; no time last; ties keep the server's order", () => {
    const merged = threadsSection({
      messages: [
        message({ id: "itm_old", at: ago(3 * HOUR) }),
        message({ id: "itm_tie", at: ago(HOUR) }),
        message({ id: "itm_none", at: null }),
      ],
      comments: [
        comment({ id: "m_new", at: ago(MIN) }),
        comment({ id: "m_tie", at: ago(HOUR) }),
        comment({ id: "m_none", at: null }),
      ],
    });
    expect(merged.map((r) => `${r.kind}:${r.hit.id}`)).toEqual([
      "comment:m_new",
      "message:itm_tie",
      "comment:m_tie",
      "message:itm_old",
      "message:itm_none",
      "comment:m_none",
    ]);
  });

  test("at most eight", () => {
    const many = Array.from({ length: 8 }, (_, i) => message({ id: `itm_${i}`, at: ago(i * MIN) }));
    const more = Array.from({ length: 8 }, (_, i) =>
      comment({ id: `m_${i}`, at: ago(i * MIN + 1) }),
    );
    const merged = threadsSection({ messages: many, comments: more });
    expect(THREADS_CAP).toBe(8);
    expect(merged).toHaveLength(8);
    expect(merged.map((r) => r.hit.id)).toEqual([
      "itm_0",
      "m_0",
      "itm_1",
      "m_1",
      "itm_2",
      "m_2",
      "itm_3",
      "m_3",
    ]);
  });
});

describe("names the phone holds", () => {
  const held = [
    canvas({ id: "cnv_1", name: "Pricing page" }),
    canvas({ id: "cnv_2", name: "Café menu" }),
    canvas({ id: "cnv_3", name: "Onboarding flow" }),
  ];
  test("every word must match, folded, with where each matched", () => {
    expect(nameHits("pricing", held)).toEqual([{ canvas: held[0]!, matches: [[0, 7]] }]);
    expect(nameHits("cafe", held)).toEqual([{ canvas: held[1]!, matches: [[0, 4]] }]);
    expect(nameHits("flow onboard", held).map((h) => h.canvas.id)).toEqual(["cnv_3"]);
    expect(nameHits("flow pricing", held)).toEqual([]);
    // A short word only at a word's start, as the server matches it.
    expect(nameHits("ag", held)).toEqual([]);
    expect(nameHits("pa", held).map((h) => h.canvas.id)).toEqual(["cnv_1"]);
    expect(nameHits("  ", held)).toEqual([]);
  });
});

describe("what the tab shows", () => {
  const held = [
    canvas({ id: "cnv_1", name: "Pricing page" }),
    canvas({ id: "cnv_2", name: "Onboarding" }),
  ];
  const answer = (over: Partial<SearchAnswer> = {}): SearchAnswer => ({
    query: "plans",
    canvases: [],
    boards: [],
    comments: [],
    messages: [],
    pullRequests: [],
    people: [],
    ...over,
  });
  const author = {
    kind: "user" as const,
    id: "usr_maya",
    name: "Maya Lin",
    login: "maya",
    avatarUrl: null,
  };
  const found = answer({
    boards: [
      {
        canvasId: "cnv_1",
        canvasName: "Pricing page",
        kind: "board",
        id: "ab_plans",
        pageId: "pg_1",
        name: "Plans",
        matches: [[0, 5]],
      },
      // A hit on a canvas the phone doesn't hold is dropped.
      {
        canvasId: "cnv_gone",
        canvasName: "Gone",
        kind: "board",
        id: "ab_x",
        pageId: "pg_1",
        name: "Plans",
        matches: [[0, 5]],
      },
    ],
    messages: [
      {
        canvasId: "cnv_1",
        canvasName: "Pricing page",
        itemId: "itm_1",
        itemSeq: 4,
        snippet: "Make the plans easier",
        matches: [[9, 14]],
        author,
        at: ago(HOUR),
      },
    ],
    comments: [
      {
        canvasId: "cnv_1",
        canvasName: "Pricing page",
        threadId: "th_1",
        messageId: "m_1",
        pageId: "pg_1",
        artboardId: "ab_plans",
        resolved: false,
        snippet: "The plans need contrast",
        matches: [[4, 9]],
        author: { kind: "agent" },
        at: ago(MIN),
      },
    ],
  });

  test("nothing typed: the recent canvases", () => {
    expect(searchView({ query: "  ", answer: found, asked: "answered", canvases: held })).toEqual({
      kind: "recent",
    });
  });

  test("an answer: Canvases, Boards and Threads, hits on canvases not held dropped", () => {
    const view = searchView({ query: "plans", answer: found, asked: "answered", canvases: held });
    if (view.kind !== "results") throw new Error(view.kind);
    expect(view.busy).toBe(false);
    expect(view.canvases).toEqual([]);
    expect(view.boards.map((b) => `${b.canvas.id}/${b.id}`)).toEqual(["cnv_1/ab_plans"]);
    expect(view.threads.map((t) => `${t.kind}:${t.hit.id}`)).toEqual([
      "comment:m_1",
      "message:itm_1",
    ]);
  });

  test("an empty answer to these words says there are none", () => {
    expect(
      searchView({ query: "zebra", answer: answer(), asked: "answered", canvases: held }),
    ).toEqual({
      kind: "none",
      query: "zebra",
    });
  });

  test("while asking: an older answer stays, else the names held, else it waits", () => {
    const older = searchView({ query: "plans x", answer: found, asked: "asking", canvases: held });
    expect(older.kind === "results" && older.busy).toBe(true);
    const names = searchView({
      query: "pricing",
      answer: undefined,
      asked: "asking",
      canvases: held,
    });
    expect(names).toMatchObject({ kind: "results", busy: true, boards: [], threads: [] });
    expect(names.kind === "results" && names.canvases.map((c) => c.canvas.id)).toEqual(["cnv_1"]);
    // An older answer with nothing in it can't say there's nothing for these words.
    expect(
      searchView({ query: "zebra", answer: answer(), asked: "asking", canvases: held }),
    ).toEqual({
      kind: "waiting",
    });
    expect(
      searchView({ query: "zebra", answer: undefined, asked: "asking", canvases: held }),
    ).toEqual({
      kind: "waiting",
    });
  });

  test("no search route (404): names alone, and no Boards or Threads ever", () => {
    expect(askedOf(new ApiError(404, "not_found", "Not found."))).toBe("absent");
    const names = searchView({ query: "pricing", answer: found, asked: "absent", canvases: held });
    expect(names).toMatchObject({ kind: "results", busy: false, boards: [], threads: [] });
    expect(searchView({ query: "plans", answer: found, asked: "absent", canvases: held })).toEqual({
      kind: "none",
      query: "plans",
    });
  });

  test("no answer (an error, or offline): names if any, else that search isn't answering", () => {
    expect(askedOf(new ApiError(500, "internal", "Boom."))).toBe("failed");
    expect(askedOf(new ApiError(0, "network", "No answer."))).toBe("failed");
    expect(askedOf(new Error("anything"))).toBe("failed");
    const names = searchView({
      query: "onboard",
      answer: undefined,
      asked: "failed",
      canvases: held,
    });
    expect(names).toMatchObject({ kind: "results", busy: false, boards: [], threads: [] });
    expect(
      searchView({ query: "plans", answer: undefined, asked: "failed", canvases: held }),
    ).toEqual({
      kind: "failed",
    });
  });
});

describe("where a result opens", () => {
  const on = { id: "cnv_1", name: "Pricing page" };

  test("a canvas, a page, a board on its page, a comment at its pin, a message in the chat", () => {
    expect(resultPath({ kind: "canvas", hit: { canvas: canvas(), matches: [] } })).toBe(
      "/canvas/cnv_1",
    );
    const board = {
      id: "ab_plans",
      place: "board" as const,
      pageId: "pg_1",
      name: "Plans",
      icon: null,
      matches: [],
      canvas: on,
    };
    expect(resultPath({ kind: "board", hit: { ...board, place: "page", id: "pg_1" } })).toBe(
      "/canvas/cnv_1?page=pg_1",
    );
    expect(resultPath({ kind: "board", hit: board })).toBe(
      "/canvas/cnv_1?page=pg_1&artboard=ab_plans",
    );
    expect(resultPath({ kind: "board", hit: { ...board, pageId: null } })).toBe(
      "/canvas/cnv_1?artboard=ab_plans",
    );
    expect(resultPath({ kind: "comment", hit: comment() })).toBe(
      "/canvas/cnv_1?page=pg_1&artboard=ab_plans&thread=th_1",
    );
    expect(resultPath({ kind: "comment", hit: comment({ artboardId: null }) })).toBe(
      "/canvas/cnv_1?page=pg_1&thread=th_1",
    );
    expect(resultPath({ kind: "message", hit: message() })).toBe(
      "/canvas/cnv_1?sheet=chat&message=4",
    );
  });
});
