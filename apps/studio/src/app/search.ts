import { SEARCH_GROUPS, type SearchAnswer, type SearchGroup } from "@ponzu/client";
import { searchQuery } from "@ponzu/client/query";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { CanvasSummary, SearchResults, WorkspaceKind } from "../cloud/model.ts";
import type { Result } from "../cloud/search.ts";
import { searchByName, toSearchResults } from "./map.ts";
import { usePonzu } from "./ponzu-query.tsx";

/**
 * A place on a canvas a result opens at: a page, a board, a comment's thread, a line of the
 * thread in the rail, or the pull request tab.
 */
export interface ResultPlace {
  canvasId: string;
  page?: string;
  artboard?: string;
  thread?: string;
  /** A thread item: the rail opens, finds it (paging back to its seq) and shows it. */
  item?: { id: string; seq: number };
  tab?: "pull-request";
}

/** What opening a result does, by what it is. */
export interface ResultOpeners {
  /** Open the canvas as it opens from the list. */
  canvas: (canvasId: string) => void;
  /** Open the canvas at a place on it: the canvas follows it as it follows a link. */
  place: (at: ResultPlace) => void;
  /** Show only their canvases in the sidebar. */
  person: (userId: string) => void;
}

/**
 * Opens a result: a canvas as the list does; a board on its page, framed; a page; a comment
 * with its pin in the middle and its thread open, resolved or not (where it was, once deleted);
 * a message in the thread rail; a pull request on its tab, as ⌘P shows it; a person, as the
 * sidebar's filter to them.
 */
export function openSearchResult(result: Result, open: ResultOpeners): void {
  switch (result.kind) {
    case "canvas":
      open.canvas(result.hit.canvas.id);
      return;
    case "board":
      open.place({
        canvasId: result.hit.canvas.id,
        artboard: result.hit.id,
        ...(result.hit.pageId ? { page: result.hit.pageId } : {}),
      });
      return;
    case "page":
      open.place({ canvasId: result.hit.canvas.id, page: result.hit.id });
      return;
    case "comment":
      open.place({
        canvasId: result.hit.canvas.id,
        thread: result.hit.threadId,
        ...(result.hit.pageId ? { page: result.hit.pageId } : {}),
        ...(result.hit.artboardId ? { artboard: result.hit.artboardId } : {}),
      });
      return;
    case "message":
      open.place({
        canvasId: result.hit.canvas.id,
        item: { id: result.hit.id, seq: result.hit.seq },
      });
      return;
    case "pr":
      open.place({ canvasId: result.hit.canvas.id, tab: "pull-request" });
      return;
    case "person":
      open.person(result.hit.id);
      return;
  }
}

/*
 * ⌘K's answers, on live data: what the sidebar's search shows for what is typed. The words go to
 * the API's search (POST /v1/workspaces/:id/search, through @ponzu/client's query) once typing
 * has rested for SEARCH_DEBOUNCE_MS; a newer query gives up on the older one's request. Until the
 * first answer of a search lands, the canvases' names the window already holds stand in (instant,
 * names only); after that, the last answer stays while the next is on its way (G-M11).
 */

/** How long typing rests before the words are sent. */
export const SEARCH_DEBOUNCE_MS = 100;

/**
 * The groups the window asks for in a workspace of `kind`: every one, but people only in an
 * organization's, as the filter menu offers teammates only there. A personal workspace has no
 * one else to find.
 */
export function studioSearchGroups(kind: WorkspaceKind): readonly SearchGroup[] {
  return kind === "org" ? SEARCH_GROUPS : SEARCH_GROUPS.filter((group) => group !== "people");
}

export interface CanvasSearch {
  /** What the list shows; null while there is nothing to show yet. */
  results: SearchResults | null;
  /**
   * The results shown aren't the API's answer to what is typed now: the last answer, or the
   * names the window holds, while it is on its way.
   */
  busy: boolean;
  /** The API didn't answer, and there is nothing else to show. */
  failed: boolean;
}

const NOTHING: CanvasSearch = { results: null, busy: false, failed: false };

/**
 * What the sidebar shows for `query`, from what is known: the API's answer (current, or the last
 * one while the next is asked), else the names the window holds until the first answer of this
 * search lands. `answered` is whether one has landed since search opened; `current`, whether
 * `answer` is the API's own to what is typed now.
 */
export function shownResults({
  query,
  answer,
  answered,
  current,
  failed,
  canvases,
  pageIcons,
}: {
  query: string | null;
  answer: SearchAnswer | undefined;
  answered: boolean;
  current: boolean;
  failed: boolean;
  canvases: readonly CanvasSummary[];
  pageIcons?: ReadonlyMap<string, string> | undefined;
}): CanvasSearch {
  if (!query?.trim()) return NOTHING;
  if (answer && answered) {
    return {
      results: toSearchResults(answer, canvases, pageIcons),
      busy: !current,
      failed: false,
    };
  }
  if (failed) return { ...NOTHING, failed: true };
  // Names alone can't say there is nothing: with none of them matching, the list waits for the
  // answer ("Searching…" if it is slow) rather than saying "No results" before it is asked.
  const names = searchByName(query, [...canvases]);
  return names.canvases.length ? { results: names, busy: true, failed: false } : NOTHING;
}

/**
 * The sidebar's search, for the `workspace`'s `canvases` (every one the window lists, active and
 * settled). `query` is null while search is closed. `pageIcons` reads the page icons the window
 * knows, by page id, when an answer is shown.
 */
export function useCanvasSearch(
  workspace: { id: string; kind: WorkspaceKind },
  query: string | null,
  canvases: readonly CanvasSummary[],
  pageIcons: () => ReadonlyMap<string, string> = () => new Map(),
): CanvasSearch {
  const { queries } = usePonzu();
  const typed = query ?? "";
  const sent = useDebounced(typed, SEARCH_DEBOUNCE_MS);
  const answer = useQuery(queries.search(workspace.id, sent, studioSearchGroups(workspace.kind)));
  // Whether an answer of the API's own (not one kept from before) has landed since search
  // opened: until then the names the window holds stand in. Closing search starts it over, so
  // an answer kept in the cache from a search before never shows for a new one's first words.
  const [answered, setAnswered] = useState(false);
  const open = query !== null;
  const landed = answer.isSuccess && !answer.isPlaceholderData && sent.trim() !== "";
  useEffect(() => {
    if (!open) setAnswered(false);
    else if (landed) setAnswered(true);
  }, [open, landed]);
  const current = landed && searchQuery(sent) === searchQuery(typed);
  const data = answer.data;
  const failed = answer.isError && !answer.isFetching;
  return useMemo(
    () =>
      shownResults({
        query,
        answer: data,
        answered: answered || landed,
        current,
        failed,
        canvases,
        pageIcons: data ? pageIcons() : undefined,
      }),
    // pageIcons is read as an answer is shown, not watched.
    [query, data, answered, landed, current, failed, canvases],
  );
}

/** `value`, once it has stayed the same for `ms`; an empty value at once. */
function useDebounced(value: string, ms: number): string {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    if (!value.trim()) {
      setRested(value);
      return;
    }
    const timer = setTimeout(() => setRested(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value.trim() ? rested : value;
}
