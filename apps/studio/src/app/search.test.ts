import { expect, test } from "bun:test";
import type { SearchAnswer } from "@ponzu/client";
import * as f from "../cloud/gallery/fixtures.ts";
import { listResults } from "../cloud/search.ts";
import { openSearchResult, type ResultPlace, shownResults, studioSearchGroups } from "./search.ts";
import { REVEAL_PAGES, revealStep } from "./thread-store.ts";

const listed = f.teamCanvases;
const pricing = listed.find((c) => c.id === "cnv_pricing")!;
const answer = (query: string): SearchAnswer => ({
  query,
  canvases: [{ canvasId: pricing.id, name: pricing.name, matches: [[0, 7]] }],
  boards: [],
  comments: [],
  messages: [],
  pullRequests: [],
  people: [],
});
/** What is known, by default: nothing yet. */
const known = {
  answer: undefined,
  answered: false,
  current: false,
  failed: false,
  canvases: listed,
};

test("closed or blank, search shows the list", () => {
  for (const query of [null, "", "   "]) {
    expect(
      shownResults({ ...known, query, answer: answer("p"), answered: true, current: true }),
    ).toEqual({ results: null, busy: false, failed: false });
  }
});

test("before the first answer lands, the names the window holds stand in, busy", () => {
  const shown = shownResults({ ...known, query: "pricing" });
  expect(shown.failed).toBe(false);
  expect(shown.busy).toBe(true);
  expect(shown.results?.canvases.map((hit) => hit.canvas.id)).toEqual([pricing.id]);
  expect(shown.results?.boards).toEqual([]);
  // An answer kept from an earlier search isn't this one's first: the names still stand in.
  const kept = shownResults({ ...known, query: "pricing", answer: answer("hero") });
  expect(kept.results?.query).toBe("pricing");
});

test("names that match nothing say nothing yet: the list waits rather than saying no results", () => {
  expect(shownResults({ ...known, query: "zebra" })).toEqual({
    results: null,
    busy: false,
    failed: false,
  });
});

test("once an answer has landed, it shows until the next one does, busy while it comes", () => {
  const shown = shownResults({
    ...known,
    query: "pricing page",
    answer: answer("pricing"),
    answered: true,
  });
  // The last answer, for the words it answered.
  expect(shown.results?.query).toBe("pricing");
  expect(shown.results?.canvases[0]?.canvas).toBe(pricing);
  expect(shown.busy).toBe(true);
  const landed = shownResults({
    ...known,
    query: "pricing",
    answer: answer("pricing"),
    answered: true,
    current: true,
  });
  expect(landed.busy).toBe(false);
});

test("no answer and nothing to show says search isn't answering", () => {
  expect(shownResults({ ...known, query: "zebra", answered: true, failed: true })).toEqual({
    results: null,
    busy: false,
    failed: true,
  });
});

test("each result opens where it is: a canvas, a board on its page, a page, a comment's thread", () => {
  const opened: (string | ResultPlace)[] = [];
  const open = {
    canvas: (id: string) => opened.push(id),
    place: (at: ResultPlace) => opened.push(at),
    person: (id: string) => opened.push(`person ${id}`),
  };
  for (const result of [...listResults(f.heroResults), ...listResults(f.pricingResults)]) {
    openSearchResult(result, open);
  }
  expect(opened).toEqual([
    "cnv_quieter",
    "cnv_settled_1",
    { canvasId: "cnv_quieter", artboard: "ab_hero_b", page: "pg_home" },
    { canvasId: "cnv_brand", artboard: "ab_hero_dark", page: "pg_brand" },
    { canvasId: "cnv_quieter", thread: "th_serif", page: "pg_home", artboard: "ab_hero_b" },
    "cnv_pricing",
    { canvasId: "cnv_quieter", page: "pg_pricing" },
    { canvasId: "cnv_pricing", artboard: "ab_pricing_annual", page: "pg_takes" },
    {
      canvasId: "cnv_pricing",
      thread: "th_rows",
      page: "pg_takes",
      artboard: "ab_pricing_annual",
    },
    // A comment on the page itself: no board to frame.
    { canvasId: "cnv_pricing", thread: "th_seat", page: "pg_takes" },
  ]);
});

test("a message opens in the thread at its item, a pull request on its tab, a person as the filter", () => {
  const opened: (string | ResultPlace)[] = [];
  const open = {
    canvas: (id: string) => opened.push(id),
    place: (at: ResultPlace) => opened.push(at),
    person: (id: string) => opened.push(`person ${id}`),
  };
  const every = listResults(f.everyResults);
  for (const result of every.filter((r) => ["message", "pr", "person"].includes(r.kind))) {
    openSearchResult(result, open);
  }
  expect(opened).toEqual([
    { canvasId: "cnv_park", item: { id: "ti_park_ask", seq: 3 } },
    { canvasId: "cnv_park", item: { id: "ti_park_answer", seq: 9 } },
    { canvasId: "cnv_park", tab: "pull-request" },
    // An earlier pull request opens the same tab: the canvas's current one is what it shows.
    { canvasId: "cnv_park", tab: "pull-request" },
    "person usr_ada",
    `person ${f.leo.id}`,
  ]);
  // Every group, in the list's order.
  expect([...new Set(every.map((r) => r.kind))]).toEqual([
    "canvas",
    "page",
    "board",
    "comment",
    "message",
    "pr",
    "person",
  ]);
});

test("people are asked for only in an organization's workspace", () => {
  expect(studioSearchGroups("org")).toEqual([
    "canvases",
    "boards",
    "comments",
    "messages",
    "pullRequests",
    "people",
  ]);
  expect(studioSearchGroups("personal")).toEqual([
    "canvases",
    "boards",
    "comments",
    "messages",
    "pullRequests",
  ]);
});

test("showing a line of the thread pages back to its seq, at most 20 pages, then shows", () => {
  const item = (seq: number) => ({ id: `ti_${seq}`, seq });
  const line = { id: "ti_5", seq: 5 };
  const holding = (from: number, older: "more" | "loading" | "none") => ({
    items: [item(from), item(from + 1)] as never,
    older,
  });
  // Nothing yet, or nothing asked.
  expect(revealStep({ items: null, older: "none" }, line, 0)).toBe("wait");
  expect(revealStep(holding(1, "none"), null, 0)).toBe("wait");
  // Held: by its id, or by an older seq (a line no longer shown is found by where it was).
  expect(revealStep(holding(5, "more"), line, 0)).toBe("show");
  expect(revealStep(holding(3, "more"), { id: "ti_aside", seq: 4 }, 0)).toBe("show");
  // Older than everything held: the page before, while there is one and a page is not on its way.
  expect(revealStep(holding(60, "more"), line, 0)).toBe("page");
  expect(revealStep(holding(60, "loading"), line, 1)).toBe("wait");
  expect(revealStep(holding(60, "more"), line, REVEAL_PAGES - 1)).toBe("page");
  // Out of pages, or of history: the oldest held is shown.
  expect(revealStep(holding(60, "more"), line, REVEAL_PAGES)).toBe("show");
  expect(revealStep(holding(60, "none"), line, 0)).toBe("show");
  expect(REVEAL_PAGES).toBe(20);
});
