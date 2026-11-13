import { ApiError, SEARCH_QUERY_MAX, type SearchAnswer, type SearchGroup } from "@ponzu/client";
import {
  type BoardHit,
  type CanvasHit,
  type CanvasSummary,
  type CommentHit,
  firstName,
  type HitAuthor,
  type MessageHit,
  toSearchResults,
} from "@ponzu/client/model";
import { searchQuery } from "@ponzu/client/query";
import { findMatches, type Match, searchTerms } from "@ponzu/core/search-text";
import { shortAgo } from "./ago";
import { SEARCH } from "./copy";
import { pathOf } from "./links";

/*
 * The Search tab, pure (search design §10, iPhone design §14): what it shows before anything is
 * typed, how an answer from the API's search becomes its three sections, the lines under each
 * result, and where a result opens. The screen (app/(tabs)/(search)/search.tsx) and its rows
 * (components/search-results.tsx) only draw what this says.
 *
 * The words go to `POST /v1/workspaces/:id/search` (never in an address) through
 * `ponzuQueries.search`, asking for canvases, boards, comments and messages. Comments and
 * messages are shown together as Threads, newest first. Until the API answers, and whenever it
 * can't, the canvases the phone already holds are matched by name with search's own rules
 * (@ponzu/core/search-text), so nothing waits on the network to show what can be shown. An API
 * with no search route (404) leaves only those names: Boards and Threads don't show at all.
 */

/** How long typing rests before the words are sent. */
export const SEARCH_DEBOUNCE_MS = 150;
/** How many canvases show before anything is typed. */
export const RECENT_COUNT = 6;
/** The most results Threads shows: messages and comments together. */
export const THREADS_CAP = 8;
/** What the phone asks the search for: no pull requests or people, which it has no place for. */
export const PHONE_SEARCH_GROUPS: readonly SearchGroup[] = [
  "canvases",
  "boards",
  "comments",
  "messages",
];

/**
 * The words as they are searched: trimmed, in NFC, and no longer than the API takes
 * (SEARCH_QUERY_MAX, as the Mac's field caps them), so a long paste is searched by its start
 * rather than refused with a 400 that would read as search not answering. A cut never splits a
 * character in two.
 */
export function searchWords(query: string): string {
  const q = searchQuery(query);
  if (q.length <= SEARCH_QUERY_MAX) return q;
  const cut = q.slice(0, SEARCH_QUERY_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trim();
}

/** What a before-typing row needs: its canvas, and the question it waits on, if known. */
export interface RecentRow {
  canvas: CanvasSummary;
  question: { header: string } | null;
}

/**
 * The `count` canvases changed most recently, newest first, settled ones included: what Search
 * shows before anything is typed. Ties go by id, so the order never flickers.
 */
export function recentCanvases<T extends { canvas: CanvasSummary }>(
  rows: readonly T[],
  count = RECENT_COUNT,
): T[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        Date.parse(b.canvas.lastActivityAt) - Date.parse(a.canvas.lastActivityAt) ||
        (a.canvas.id < b.canvas.id ? -1 : a.canvas.id > b.canvas.id ? 1 : 0),
    )
    .slice(0, count);
}

/** A canvas's branch, or for Scratch its place's name. */
function placeOf(canvas: CanvasSummary): string {
  return canvas.project.kind === "repo" ? canvas.project.branch : canvas.project.city;
}

/**
 * A before-typing row's line, board 3.2's grammar: `[state · ] age [ · branch or Scratch name]`.
 * Waiting on the viewer, it says what it asks about (its first open question's header, or that it
 * waits when the question hasn't been read yet) and drops the branch. While the agent works, the
 * age reads "now". A settled canvas says so. The board's "Claude" for a canvas the agent changed
 * last is not drawn: the list's rows don't say who changed it last.
 */
export function subtitle(row: RecentRow, now: number): string {
  const { canvas, question } = row;
  const age = shortAgo(Date.parse(canvas.lastActivityAt), now);
  if (canvas.status === "settled") return [SEARCH.settled, age, placeOf(canvas)].join(" · ");
  if (canvas.needsYou > 0) {
    return [question ? SEARCH.asking(question.header) : SEARCH.waiting, age].join(" · ");
  }
  if (canvas.agentState === "working" || canvas.agentState === "waking") {
    return [SEARCH.working, "now", placeOf(canvas)].join(" · ");
  }
  return [age, placeOf(canvas)].join(" · ");
}

/**
 * A canvas result's line, as the Mac's ⌘K says it: an open canvas's repo and branch (or Scratch
 * and its place); a settled one's repo, whose it was, and when it settled.
 */
export function canvasLine(canvas: CanvasSummary, now: number): string {
  const { project } = canvas;
  const where = project.kind === "repo" ? project.repo.name : project.city;
  if (canvas.status === "settled") {
    const parts = [where];
    if (canvas.owner) parts.push(firstName(canvas.owner));
    if (canvas.settledAt) parts.push(shortAgo(Date.parse(canvas.settledAt), now));
    return parts.join(" · ");
  }
  return project.kind === "repo" ? `${where} · ${project.branch}` : `Scratch · ${where}`;
}

/** A page result's line, "Page in Pricing page"; a board's, "in Pricing page". As the Mac's. */
export function boardLine(hit: BoardHit): string {
  return hit.place === "page" ? SEARCH.pageIn(hit.canvas.name) : SEARCH.boardIn(hit.canvas.name);
}

/** How a result names who said it: their first name, Claude, or "Deleted user". */
export function authorName(author: HitAuthor): string {
  if (author === "agent") return SEARCH.agent;
  if (author === "deleted") return SEARCH.deleted;
  return firstName(author);
}

/** A message or comment found, for Threads. */
export type ThreadResult =
  | { kind: "message"; hit: MessageHit }
  | { kind: "comment"; hit: CommentHit };

/**
 * Who said it and on which canvas, "Maya · Pricing page", with " · Resolved" for a resolved
 * comment's. The age is drawn apart, at the row's end.
 */
export function threadLine(result: ThreadResult): string {
  const line = `${authorName(result.hit.author)} · ${result.hit.canvas.name}`;
  return result.kind === "comment" && result.hit.resolved ? `${line} · ${SEARCH.resolved}` : line;
}

/** A thread result's age, "2h", or nothing when the server doesn't know when it was said. */
export function threadAge(result: ThreadResult, now: number): string | null {
  return result.hit.at ? shortAgo(Date.parse(result.hit.at), now) : null;
}

/**
 * Threads: the messages and comments found, merged newest first, at most `cap`. One the server
 * doesn't know the time of goes after those it does; equal times keep the server's order,
 * messages ahead of comments.
 */
export function threadsSection(
  results: { messages: readonly MessageHit[]; comments: readonly CommentHit[] },
  cap = THREADS_CAP,
): ThreadResult[] {
  const all: ThreadResult[] = [
    ...results.messages.map((hit) => ({ kind: "message" as const, hit })),
    ...results.comments.map((hit) => ({ kind: "comment" as const, hit })),
  ];
  const time = (r: ThreadResult) => (r.hit.at ? Date.parse(r.hit.at) : Number.NEGATIVE_INFINITY);
  return all
    .map((result, index) => ({ result, index }))
    .sort((a, b) => time(b.result) - time(a.result) || a.index - b.index)
    .slice(0, cap)
    .map(({ result }) => result);
}

/**
 * The canvases the phone holds whose name has every word of `query`, by search's own rules
 * (folded, a quoted phrase kept together, a short word only at a word's start), with where each
 * matched, in the order given.
 */
export function nameHits(query: string, canvases: readonly CanvasSummary[]): CanvasHit[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  return canvases.flatMap((canvas) => {
    if (!terms.every((term) => findMatches(canvas.name, [term]).length > 0)) return [];
    return [{ canvas, matches: findMatches(canvas.name, terms) as Match[] }];
  });
}

/** What the API's search did with the words typed now. */
export type SearchAsked =
  /** On its way, or not asked yet. */
  | "asking"
  /** Answered: `answer` is its answer to the words typed now. */
  | "answered"
  /** No search route there (an API from before it), or no such workspace: names alone. */
  | "absent"
  /** It didn't answer: an error, or no network to ask over. */
  | "failed";

/** How a search's error reads: no route is `absent`, anything else `failed`. */
export function askedOf(error: unknown): "absent" | "failed" {
  return error instanceof ApiError && error.status === 404 ? "absent" : "failed";
}

/** What the tab shows. */
export type SearchView =
  /** Nothing typed: the recent canvases. */
  | { kind: "recent" }
  /** Asked, with nothing to show yet ("Searching…" once it takes a moment). */
  | { kind: "waiting" }
  | {
      kind: "results";
      canvases: CanvasHit[];
      boards: BoardHit[];
      threads: ThreadResult[];
      /** What shows isn't the answer to the words typed now: an older answer, or names alone. */
      busy: boolean;
    }
  /** "No results for “q”". */
  | { kind: "none"; query: string }
  /** "Search isn't answering. Try again in a moment." */
  | { kind: "failed" };

/**
 * What the tab shows for `query`, from what is known: `answer` (the API's, to the words typed now
 * when `asked` is "answered", else an older one kept while the next is asked), and the
 * `canvases` the phone holds, every one, settled too. A hit on a canvas the phone doesn't hold
 * is dropped: the list is what may be shown. With no list yet (`canvases` null), every hit
 * would be dropped, so an answer can't say there is nothing: it waits while the list is coming
 * (`listLoading`), and once it isn't coming, search can't answer.
 */
export function searchView({
  query,
  answer,
  asked,
  canvases,
  listLoading = false,
}: {
  query: string;
  answer: SearchAnswer | undefined;
  asked: SearchAsked;
  canvases: readonly CanvasSummary[] | null;
  listLoading?: boolean;
}): SearchView {
  const q = query.trim();
  if (!q) return { kind: "recent" };
  if (!canvases) return listLoading ? { kind: "waiting" } : { kind: "failed" };
  const names = () => nameHits(q, canvases);
  const namesOnly = (busy: boolean): SearchView => {
    const hits = names();
    return hits.length
      ? { kind: "results", canvases: hits, boards: [], threads: [], busy }
      : { kind: "none", query: q };
  };
  // No search route: what the phone holds is all there is to search, so "no results" is true.
  if (asked === "absent") return namesOnly(false);
  if (asked === "failed") {
    const hits = names();
    return hits.length
      ? { kind: "results", canvases: hits, boards: [], threads: [], busy: false }
      : { kind: "failed" };
  }
  if (answer) {
    const shown = toSearchResults(answer, canvases);
    const threads = threadsSection(shown);
    const current = asked === "answered";
    if (shown.canvases.length || shown.boards.length || threads.length) {
      return {
        kind: "results",
        canvases: shown.canvases,
        boards: shown.boards,
        threads,
        busy: !current,
      };
    }
    if (current) return { kind: "none", query: q };
  }
  // Names alone can't say there is nothing, so with none matching, it waits for the answer.
  const hits = names();
  return hits.length
    ? { kind: "results", canvases: hits, boards: [], threads: [], busy: true }
    : { kind: "waiting" };
}

/** A result, as a press opens it. */
export type SearchResult =
  | { kind: "canvas"; hit: CanvasHit }
  | { kind: "board"; hit: BoardHit }
  | ThreadResult;

/**
 * Where a result opens, as an in-app path: a canvas as the list opens it; a page; a board on its
 * page, in focus; a comment at its pin with its thread open (as a ping about it does); a message
 * with the chat sheet up at it.
 */
export function resultPath(result: SearchResult): string {
  switch (result.kind) {
    case "canvas":
      return pathOf({ screen: "canvas", id: result.hit.canvas.id, params: {} });
    case "board": {
      const { hit } = result;
      const params =
        hit.place === "page"
          ? { page: hit.id }
          : { ...(hit.pageId ? { page: hit.pageId } : {}), artboard: hit.id };
      return pathOf({ screen: "canvas", id: hit.canvas.id, params });
    }
    case "comment": {
      const { hit } = result;
      return pathOf({
        screen: "canvas",
        id: hit.canvas.id,
        params: {
          ...(hit.pageId ? { page: hit.pageId } : {}),
          ...(hit.artboardId ? { artboard: hit.artboardId } : {}),
          thread: hit.threadId,
        },
      });
    }
    case "message":
      return pathOf({
        screen: "canvas",
        id: result.hit.canvas.id,
        params: { sheet: "chat", message: String(result.hit.seq) },
      });
  }
}
