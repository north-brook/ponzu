import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { AgentDefaultsBody, Api, CreateDesignBody, OnboardingStep } from "../api.ts";
import { queryKeys } from "./keys.ts";

type Me = Awaited<ReturnType<Api["me"]>>;
type ClaudeAnswer = Awaited<ReturnType<Api["claude"]["get"]>>;

/**
 * The mutation options for what the apps change with a request, bound to one `Api` and the
 * person's QueryClient. Each puts what its answer says into the cache, and asks again for what
 * it may have changed, so a screen shows the change without waiting for a live query:
 *
 *   const mutations = ponzuMutations(api, queryClient);
 *   const connect = useMutation(mutations.connectApiKey());
 */
export function ponzuMutations(api: Api, queryClient: QueryClient) {
  /** The person's Claude changed: the account, and `me`, which carries it. */
  const claudeChanged = (answer: ClaudeAnswer | null) => {
    const account = answer?.account ?? null;
    queryClient.setQueryData(queryKeys.claudeAccount(), account);
    queryClient.setQueryData<Me>(queryKeys.me(), (me) =>
      me ? { ...me, claudeAccount: account } : me,
    );
    return queryClient.invalidateQueries({ queryKey: queryKeys.me() });
  };

  return {
    /**
     * Ask GitHub again: the accounts it answers, the workspaces `me` lists, and each
     * workspace's installation (installed, suspended, gone), repos and members.
     */
    syncGithub: () =>
      mutationOptions({
        mutationKey: ["ponzu", "github", "sync"],
        mutationFn: () => api.github.sync(),
        onSuccess: (answer) => {
          queryClient.setQueryData(queryKeys.githubAccounts(), answer);
          return Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
            queryClient.invalidateQueries({ queryKey: queryKeys.workspaces() }),
          ]);
        },
      }),
    /** GitHub's install page for an account, with a state good for one return. */
    installLink: () =>
      mutationOptions({
        mutationFn: (body: Parameters<Api["github"]["installLink"]>[0]) =>
          api.github.installLink(body),
      }),
    recordOnboarding: () =>
      mutationOptions({
        mutationFn: (step: OnboardingStep) => api.onboarding(step),
        onSuccess: (onboarding) =>
          queryClient.setQueryData<Me>(queryKeys.me(), (me) => (me ? { ...me, onboarding } : me)),
      }),
    /** The key is its variables: the cache lets go of it as soon as nothing watches it. */
    connectApiKey: () =>
      mutationOptions({
        mutationFn: (key: string) => api.claude.connectApiKey(key),
        onSuccess: claudeChanged,
        gcTime: 0,
      }),
    startClaudeSignIn: () => mutationOptions({ mutationFn: () => api.claude.startSignIn() }),
    /** As for a key: the code claude.ai showed is not kept once it is sent. */
    sendClaudeCode: () =>
      mutationOptions({
        mutationFn: ({ signInId, code }: { signInId: string; code: string }) =>
          api.claude.sendCode(signInId, code),
        onSuccess: claudeChanged,
        gcTime: 0,
      }),
    abandonClaudeSignIn: () =>
      mutationOptions({ mutationFn: (signInId: string) => api.claude.abandonSignIn(signInId) }),
    disconnectClaude: () =>
      mutationOptions({
        mutationFn: () => api.claude.disconnect(),
        onSuccess: () => claudeChanged(null),
      }),
    setClaudeDefaults: () =>
      mutationOptions({
        mutationFn: (body: AgentDefaultsBody) => api.claude.setDefaults(body),
        onSuccess: (defaults) => queryClient.setQueryData(queryKeys.claudeDefaults(), defaults),
      }),
    /** Admins only; 409 `owner_is_admin` or `last_admin` when it can't be done. */
    setRole: () =>
      mutationOptions({
        mutationFn: (vars: { workspaceId: string; userId: string; role: "admin" | "member" }) =>
          api.workspaces.setRole(vars.workspaceId, vars.userId, vars.role),
        onSettled: (_answer, _error, vars) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.workspace(vars.workspaceId) }),
      }),
    /** Makes a design; the same `createKey` sent again answers the one it made. */
    createDesign: () =>
      mutationOptions({ mutationFn: (body: CreateDesignBody) => api.designs.create(body) }),
  };
}

export type PonzuMutations = ReturnType<typeof ponzuMutations>;
