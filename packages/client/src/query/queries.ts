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
  };
}

export type PonzuQueries = ReturnType<typeof ponzuQueries>;
