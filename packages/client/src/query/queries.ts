import { queryOptions } from "@tanstack/react-query";
import type { Api } from "../api.ts";
import { queryKeys } from "./keys.ts";

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
    /** "Where do you design?": the person's own account, then each one with the App. */
    githubAccounts: () =>
      queryOptions({ queryKey: queryKeys.githubAccounts(), queryFn: () => api.github.accounts() }),
    /** One workspace: its installation, the repos the person reaches, its members and roles. */
    workspace: (workspaceId: string) =>
      queryOptions({
        queryKey: queryKeys.workspace(workspaceId),
        queryFn: () => api.workspaces.get(workspaceId),
      }),
    claudeAccount: () =>
      queryOptions({
        queryKey: queryKeys.claudeAccount(),
        queryFn: async () => (await api.claude.get()).account,
      }),
    /** The model and effort new designs start on, and what there is to choose from. */
    claudeDefaults: () =>
      queryOptions({ queryKey: queryKeys.claudeDefaults(), queryFn: () => api.claude.defaults() }),

    /** Which events ping the person, and the devices pings go to (an iPhone, once signed in). */
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
     * A page of a design's thread, oldest first: the newest `limit` items before `before`. Older
     * pages never change; the newest is the live query's from then on, so none is asked again.
     */
    threadPage: (designId: string, page: { before?: number; limit: number }) =>
      queryOptions({
        queryKey: queryKeys.threadPage(designId, page.before ?? null, page.limit),
        queryFn: () => api.designs.thread(designId, page),
        staleTime: Number.POSITIVE_INFINITY,
      }),
    /**
     * The design's pull request as GitHub has it, `nextAction` included. Read again whenever
     * the design's head says something about it moved: what reads it says when.
     */
    pullRequest: (designId: string) =>
      queryOptions({
        queryKey: queryKeys.pullRequest(designId),
        queryFn: () => api.designs.pullRequest.get(designId),
        staleTime: 0,
        refetchOnWindowFocus: false,
      }),
    /** One changed file and its diff, at the commit the tab shows: the same commit, the same diff. */
    pullRequestFile: (designId: string, path: string, headSha: string | null) =>
      queryOptions({
        queryKey: queryKeys.pullRequestFile(designId, path, headSha),
        queryFn: () => api.designs.pullRequest.file(designId, path),
        staleTime: headSha ? Number.POSITIVE_INFINITY : 0,
      }),
  };
}

export type PonzuQueries = ReturnType<typeof ponzuQueries>;
