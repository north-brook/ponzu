import type { Api } from "@ponzu/client";
import {
  createQueryClient,
  invalidateFromLive,
  type PonzuMutations,
  type PonzuQueries,
  ponzuMutations,
  ponzuQueries,
} from "@ponzu/client/query";
import { focusManager, type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { Host } from "./host.ts";

/*
 * The signed-in person's cache of what the window asked the API (TanStack Query, through
 * @ponzu/client/query): made at sign-in, so nothing of one person's answers reaches the next,
 * and told by the live `me` row when what it holds about them has changed elsewhere.
 */

interface Ponzu {
  /** For a call nothing waits on the answer of, such as letting go of a sign-in as a card goes. */
  api: Api;
  queries: PonzuQueries;
  mutations: PonzuMutations;
  /** The window's one QueryClient, for an open design's stores (store-ponzu.ts). */
  queryClient: QueryClient;
}

const PonzuContext = createContext<Ponzu | null>(null);

/**
 * The window coming to the front is the cache's focus: a Mac app can sit behind another app
 * with its page still visible, which is all a browser's own focus goes by.
 */
function windowFocus(setFocused: (focused: boolean) => void) {
  const focused = () => setFocused(true);
  const blurred = () => setFocused(false);
  window.addEventListener("focus", focused);
  window.addEventListener("blur", blurred);
  return () => {
    window.removeEventListener("focus", focused);
    window.removeEventListener("blur", blurred);
  };
}

export function PonzuQueryProvider({ host, children }: { host: Host; children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  useEffect(() => invalidateFromLive(queryClient, host.live), [queryClient, host]);
  useEffect(() => () => queryClient.clear(), [queryClient]);
  useEffect(() => focusManager.setEventListener(windowFocus), []);
  const ponzu = useMemo(
    () => ({
      api: host.api,
      queries: ponzuQueries(host.api),
      mutations: ponzuMutations(host.api, queryClient),
      queryClient,
    }),
    [host, queryClient],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <PonzuContext.Provider value={ponzu}>{children}</PonzuContext.Provider>
    </QueryClientProvider>
  );
}

/** The query and mutation options for the signed-in person, bound to the window's API. */
export function usePonzu(): Ponzu {
  const ponzu = useContext(PonzuContext);
  if (!ponzu) throw new Error("usePonzu needs a <PonzuQueryProvider> above it.");
  return ponzu;
}
