import type { Api } from "@ponzu/client";
import {
  createQueryClient,
  type PonzuMutations,
  type PonzuQueries,
  ponzuMutations,
  ponzuQueries,
} from "@ponzu/client/query";
import { MutationObserver, type MutationOptions, type QueryClient } from "@tanstack/react-query";

/*
 * What an open design's stores ask the API through: the window's one QueryClient and the
 * client's query and mutation options, so their requests share its cache (a pull request read
 * by the tab and by an action's answer is one entry) and its rules (what is retried, what is
 * kept). The stores stay plain classes because what they hold is a live query merged with
 * what the person has on its way (a message, an answer, an upload, a question about a merge),
 * which react-query alone doesn't model.
 */
export interface StorePonzu {
  queryClient: QueryClient;
  queries: PonzuQueries;
  mutations: PonzuMutations;
}

/** For a store, or a test: the options bound to `api`, with a QueryClient of its own unless given. */
export function storePonzu(api: Api, queryClient: QueryClient = createQueryClient()): StorePonzu {
  return {
    queryClient,
    queries: ponzuQueries(api),
    mutations: ponzuMutations(api, queryClient),
  };
}

/** Runs a mutation outside React, as `useMutation` would: through the client's mutation cache. */
export function mutate<R, V, C>(
  ponzu: StorePonzu,
  options: MutationOptions<R, Error, V, C>,
  vars: V,
): Promise<R> {
  return new MutationObserver(ponzu.queryClient, options).mutate(vars);
}
