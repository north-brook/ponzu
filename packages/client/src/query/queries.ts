import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { type Api, SEARCH_GROUPS, type SearchGroup } from "../api.ts";
import { ApiError } from "../errors.ts";
import { queryKeys, searchQuery } from "./keys.ts";

/**
 * The query options for what the apps read with a request, bound to one `Api`:
 *
 *   const queries = ponzuQueries(api);
 *   const me = useQuery(queries.me());
 *
 * What changes under the person is kept current by live queries where one covers it
 * (`invalidateFromLive`), and by asking again when the app comes back to the front.
 */
export function ponzuQueries(api: Api) {
  return {
    /**
     * The person, where setup stands, their Claude and their workspaces: every gate reads it.
     * Not asked again just for the window coming to the front: the live `me` row says when it
     * changed, and the app's sync with GitHub on coming back answers for the workspaces.
     */
    me: () =>
      queryOptions({
        queryKey: queryKeys.me(),
        queryFn: () => api.me(),
        refetchOnWindowFocus: false,
      }),
    /** "Where do you build?": the person's own account, then each one with the App. */
    githubAccounts: () =>
      queryOptions({ queryKey: queryKeys.githubAccounts(), queryFn: () => api.github.accounts() }),
    /** One workspace: its installation, the repos the person reaches, its members and roles. */
    workspace: (workspaceId: string) =>
      queryOptions({
        queryKey: queryKeys.workspace(workspaceId),
        queryFn: () => api.workspaces.get(workspaceId),
      }),
    /**
     * Who can open a canvas, as Share lists them: everyone GitHub gives access to its repo,
     * whether or not they have opened Ponzu.
     */
    canvasPeople: (canvasId: string) =>
      queryOptions({
        queryKey: queryKeys.canvasPeople(canvasId),
        queryFn: () => api.canvases.people(canvasId),
      }),
    claudeAccount: () =>
      queryOptions({
        queryKey: queryKeys.claudeAccount(),
        queryFn: async () => (await api.claude.get()).account,
      }),
    /** The model and effort new canvases start on, and what there is to choose from. */
    claudeDefaults: () =>
      queryOptions({ queryKey: queryKeys.claudeDefaults(), queryFn: () => api.claude.defaults() }),

    /**
     * Which events ping the person, the devices pings go to, the badge, and whether the daily
     * email can be sent.
     */
    notifications: () =>
      queryOptions({
        queryKey: queryKeys.notifications(),
        queryFn: () => api.notifications.get(),
      }),
    /** The workspace's repos with an environment: each base, and its secrets by name. */
    environments: (workspaceId: string) =>
      queryOptions({
        queryKey: queryKeys.environments(workspaceId),
        queryFn: () => api.environments.list(workspaceId),
      }),
    /** This billing period so far: credits used, the pooled free ones, the cap, who used what. */
    usage: (workspaceId: string) =>
      queryOptions({
        queryKey: queryKeys.usage(workspaceId),
        queryFn: () => api.usage.get(workspaceId),
      }),

    /**
     * A page of a canvas's thread, oldest first: the newest `limit` items before `before`. A
     * page before a seq never changes, so it is kept; the newest is asked for each time, and the
     * live query keeps it current from there.
     */
    threadPage: (canvasId: string, page: { before?: number; limit: number }) =>
      queryOptions({
        queryKey: queryKeys.threadPage(canvasId, page.before ?? null, page.limit),
        queryFn: () => api.canvases.thread(canvasId, page),
        staleTime: page.before === undefined ? 0 : Number.POSITIVE_INFINITY,
      }),
    /**
     * One of the agent's questions as it stands: once answered, the answer that won and who
     * gave it. Read when a question leaves `canvas.questions`, to say how it closed.
     */
    question: (canvasId: string, questionId: string) =>
      queryOptions({
        queryKey: queryKeys.question(canvasId, questionId),
        queryFn: () => api.canvases.question(canvasId, questionId),
        staleTime: 0,
      }),
    /**
     * The canvas's pull request as GitHub has it, `nextAction` included. Read again whenever
     * the canvas's head says something about it moved: what reads it says when. Kept for half
     * an hour once nothing reads it, so a canvas opened again shows its last answer at once
     * while the read on opening confirms it.
     */
    pullRequest: (canvasId: string) =>
      queryOptions({
        queryKey: queryKeys.pullRequest(canvasId),
        queryFn: () => api.canvases.pullRequest.get(canvasId),
        staleTime: 0,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: false,
      }),
    /** One changed file and its diff, at the commit the tab shows: the same commit, the same diff. */
    pullRequestFile: (canvasId: string, path: string, headSha: string | null) =>
      queryOptions({
        queryKey: queryKeys.pullRequestFile(canvasId, path, headSha),
        queryFn: () => api.canvases.pullRequest.file(canvasId, path),
        staleTime: headSha ? Number.POSITIVE_INFINITY : 0,
      }),

    /*
     * Search.
     */

    /**
     * A search of the workspace, in `groups` (all six when left out). Asked only once the query
     * has more than spaces in it. A newer query gives up on the older one's request, through
     * TanStack's signal, and the older answer is shown until the newer lands. Answers are kept
     * for half a minute fresh and two minutes in all; a new QueryClient per sign-in forgets them
     * at sign-out. Asked again once after no answer or a 5xx, never after a 4xx.
     */
    search: (
      workspaceId: string,
      query: string,
      groups: readonly SearchGroup[] = SEARCH_GROUPS,
    ) => {
      const q = searchQuery(query);
      return queryOptions({
        queryKey: queryKeys.search(workspaceId, query, groups),
        queryFn: ({ signal }) =>
          api.workspaces.search(workspaceId, { q, groups: [...groups] }, { signal }),
        enabled: q !== "",
        staleTime: 30_000,
        gcTime: 2 * 60_000,
        placeholderData: keepPreviousData,
        // Not `transient`, which counts a 408 and a 429: a search is never asked again after a
        // 4xx, since the next keystroke asks anew.
        retry: (failures, error) =>
          failures < 1 && error instanceof ApiError && (error.status === 0 || error.status >= 500),
      });
    },
  };
}

export type PonzuQueries = ReturnType<typeof ponzuQueries>;
