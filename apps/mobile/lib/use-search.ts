import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useCanvasList } from "./cloud/canvases";
import { useCloud } from "./cloud/query";
import {
  askedOf,
  PHONE_SEARCH_GROUPS,
  type RecentRow,
  recentCanvases,
  SEARCH_DEBOUNCE_MS,
  type SearchAsked,
  type SearchView,
  searchView,
  searchWords,
} from "./search";

/*
 * The Search tab on live data (lib/search.ts has the rules). The words go to the API's search
 * once typing has rested for SEARCH_DEBOUNCE_MS; a newer query gives up on the older one's
 * request, and the older answer shows until the newer lands. The canvases are the canvases
 * list's own (useCanvasList), so a result shows the preview, place and question the list has.
 */

export interface PhoneSearch {
  view: SearchView;
  /** Before anything is typed: the canvases changed most recently. */
  recent: RecentRow[];
  /** Nothing to show yet: the list itself hasn't come. */
  loading: boolean;
}

export function usePhoneSearch(query: string): PhoneSearch {
  const cloud = useCloud();
  const { workspace, list, loading } = useCanvasList();
  const rows = useMemo(() => (list ? [...list.active, ...list.settled] : []), [list]);
  const canvases = useMemo(() => (list ? rows.map((row) => row.canvas) : null), [list, rows]);
  // What is searched: no longer than the API takes, so a long paste isn't refused.
  const words = searchWords(query);
  const sent = useDebounced(words, SEARCH_DEBOUNCE_MS);
  const answer = useQuery({
    ...cloud.queries.search(workspace?.id ?? "", sent, PHONE_SEARCH_GROUPS),
    enabled: workspace !== null && sent !== "",
  });
  let asked: SearchAsked = "asking";
  if (answer.isError && !answer.isFetching) asked = askedOf(answer.error);
  // With no network, TanStack holds the request until there is one: say so rather than wait,
  // and show what the phone holds rather than an answer to other words.
  else if (answer.fetchStatus === "paused" && (!answer.data || answer.isPlaceholderData)) {
    asked = "failed";
  } else if (answer.isSuccess && !answer.isPlaceholderData && sent === words) {
    asked = "answered";
  }
  const data = asked === "failed" || asked === "absent" ? undefined : answer.data;
  const view = useMemo(
    () => searchView({ query: words, answer: data, asked, canvases, listLoading: loading }),
    [words, data, asked, canvases, loading],
  );
  const recent = useMemo(() => recentCanvases(rows), [rows]);
  return { view, recent, loading };
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

/** True once `active` has held for `ms`; false again as soon as it doesn't. */
export function useAfter(active: boolean, ms: number): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    setPassed(false);
    if (!active) return;
    const timer = setTimeout(() => setPassed(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return passed;
}
