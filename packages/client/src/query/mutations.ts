import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  AgentDefaultsBody,
  AnswerBody,
  Api,
  CreateCanvasBody,
  OnboardingStep,
  PullRequestTab,
  SendMessageBody,
  UploadFile,
} from "../api.ts";
import { ApiError } from "../errors.ts";
import { queryKeys } from "./keys.ts";

type Me = Awaited<ReturnType<Api["me"]>>;
type ClaudeAnswer = Awaited<ReturnType<Api["claude"]["get"]>>;
type Notifications = Awaited<ReturnType<Api["notifications"]["get"]>>;
type PingPrefs = Omit<Parameters<Api["notifications"]["set"]>[0], "timeZone">;
type Environments = Awaited<ReturnType<Api["environments"]["list"]>>;
type EnvironmentAnswer = Awaited<ReturnType<Api["environments"]["get"]>>;

/** What the person does to a canvas's pull request through the API, as themselves. */
export type PullRequestAction =
  | { kind: "open" }
  | { kind: "ready" }
  | { kind: "auto_merge"; on: boolean }
  | { kind: "update_branch"; headSha: string }
  | { kind: "merge"; headSha: string; bypass?: boolean }
  | { kind: "close" };

/**
 * The mutation options for what the apps change with a request, bound to one `Api` and the
 * person's QueryClient. Each puts what its answer says into the cache, and asks again for what
 * it may have changed, so a screen shows the change without waiting for a live query:
 *
 *   const mutations = ponzuMutations(api, queryClient);
 *   const connect = useMutation(mutations.connectApiKey());
 */
export function ponzuMutations(api: Api, queryClient: QueryClient) {
  /**
   * The person's Claude changed: the account, `me`, which carries it, and the defaults, since
   * what an account is offered is what Claude Code reported for its credential (docs/cloud.md,
   * "Models") and a new credential starts again from the hand-kept list.
   */
  const claudeChanged = (answer: ClaudeAnswer | null) => {
    const account = answer?.account ?? null;
    queryClient.setQueryData(queryKeys.claudeAccount(), account);
    queryClient.setQueryData<Me>(queryKeys.me(), (me) =>
      me ? { ...me, claudeAccount: account } : me,
    );
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.claudeDefaults() }),
    ]);
  };
  /**
   * A model or effort the account no longer offers was sent: what it offers changed since the
   * defaults were read (a runner reported), so read them again and the picker shows what it does.
   */
  const unlessOffered = (error: unknown) =>
    error instanceof ApiError && error.code === "model_not_offered"
      ? queryClient.invalidateQueries({ queryKey: queryKeys.claudeDefaults() })
      : undefined;

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
        onError: unlessOffered,
      }),
    /** Admins only; 409 `owner_is_admin` or `last_admin` when it can't be done. */
    setRole: () =>
      mutationOptions({
        mutationFn: (vars: { workspaceId: string; userId: string; role: "admin" | "member" }) =>
          api.workspaces.setRole(vars.workspaceId, vars.userId, vars.role),
        onSettled: (_answer, _error, vars) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.workspace(vars.workspaceId) }),
      }),
    /**
     * Makes a canvas; the same `createKey` sent again answers the one it made. 400
     * `model_not_offered` reads the defaults again, for the picker to show what is offered now.
     */
    createCanvas: () =>
      mutationOptions({
        mutationFn: (body: CreateCanvasBody) => api.canvases.create(body),
        onError: unlessOffered,
      }),

    /*
     * An open canvas. Its thread and what its agent waits on are live queries; these are what a
     * person sends it, each answered by the API, with the live rows following.
     */

    /**
     * Answers one of the agent's questions. The first answer wins: a later one is 409
     * `question_closed`, naming who answered (`details.answeredBy`).
     */
    answerQuestion: () =>
      mutationOptions({
        mutationFn: (vars: { canvasId: string; questionId: string; body: AnswerBody }) =>
          api.canvases.answer(vars.canvasId, vars.questionId, vars.body),
      }),
    /** Says something to the agent; answers the message's thread item. */
    sendMessage: () =>
      mutationOptions({
        mutationFn: ({ canvasId, body }: { canvasId: string; body: SendMessageBody }) =>
          api.canvases.sendMessage(canvasId, body),
      }),
    /** Stops the agent's turn; the runner's `stopped` notice follows in the thread. */
    stopAgent: () =>
      mutationOptions({ mutationFn: (canvasId: string) => api.canvases.stop(canvasId) }),
    /** A person's image, straight to storage, as a file of the canvas. The bytes are not kept. */
    upload: () =>
      mutationOptions({
        mutationFn: ({ canvasId, file }: { canvasId: string; file: UploadFile }) =>
          api.canvases.upload(canvasId, file),
        gcTime: 0,
      }),
    /**
     * Does something to the canvas's pull request as the person. The answer is the whole tab as
     * GitHub has it afterwards, which goes into the cache; a refusal asks for it again, since
     * whatever turned it away (a push, a teammate's merge) has moved it.
     */
    pullRequestAction: () =>
      mutationOptions({
        mutationFn: ({ canvasId, action }: { canvasId: string; action: PullRequestAction }) => {
          const pr = api.canvases.pullRequest;
          switch (action.kind) {
            case "open":
              return pr.open(canvasId);
            case "ready":
              return pr.ready(canvasId);
            case "auto_merge":
              return pr.autoMerge(canvasId, action.on);
            case "update_branch":
              return pr.updateBranch(canvasId, { headSha: action.headSha });
            case "merge":
              return pr.merge(canvasId, {
                headSha: action.headSha,
                ...(action.bypass ? { bypass: true } : {}),
              });
            case "close":
              return pr.close(canvasId);
          }
        },
        onSuccess: (tab: PullRequestTab, { canvasId }) =>
          queryClient.setQueryData(queryKeys.pullRequest(canvasId), tab),
        onError: (_error, { canvasId }) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.pullRequest(canvasId) }),
      }),

    /* Settings. */

    /** Flips ping toggles: shown at once, put back if the API turns it down. */
    setPings: () =>
      mutationOptions({
        mutationFn: (prefs: PingPrefs) => api.notifications.set(prefs),
        onMutate: async (prefs) => {
          await queryClient.cancelQueries({ queryKey: queryKeys.notifications() });
          const was = queryClient.getQueryData<Notifications>(queryKeys.notifications());
          if (was) {
            queryClient.setQueryData<Notifications>(queryKeys.notifications(), {
              ...was,
              prefs: { ...was.prefs, ...prefs },
            });
          }
          return { was };
        },
        onError: (_error, _prefs, context) => {
          if (context?.was) queryClient.setQueryData(queryKeys.notifications(), context.was);
        },
        onSuccess: (answer) => queryClient.setQueryData(queryKeys.notifications(), answer),
      }),
    /** Pings to one device on or off. */
    setDevicePings: () =>
      mutationOptions({
        mutationFn: ({ deviceId, pings }: { deviceId: string; pings: boolean }) =>
          api.devices.update(deviceId, { pings }),
        onSuccess: ({ device }) =>
          queryClient.setQueryData<Notifications>(queryKeys.notifications(), (now) =>
            now
              ? { ...now, devices: now.devices.map((d) => (d.id === device.id ? device : d)) }
              : now,
          ),
        onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications() }),
      }),
    /** The app's time zone, when it differs from the one kept: the daily email's 9:00 is in it. */
    setTimeZone: () =>
      mutationOptions({
        mutationFn: (timeZone: string) => api.notifications.set({ timeZone }),
        onSuccess: (answer) => queryClient.setQueryData(queryKeys.notifications(), answer),
      }),
    /**
     * A notification read on the app that showed it. The inbox (`me.notifications`) drops it by
     * itself; the badge in Settings is asked for again.
     */
    readNotification: () =>
      mutationOptions({
        mutationFn: ({ id, via }: { id: string; via: "mac" | "ios" }) =>
          api.notifications.read(id, via),
        onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications() }),
      }),
    /** Anyone who can push: the repo's base is built again at the next start. */
    rebuildEnvironment: () =>
      mutationOptions({
        mutationFn: ({ repoId }: { workspaceId: string; repoId: string }) =>
          api.environments.rebuild(repoId),
        onSuccess: (answer, { workspaceId }) => environmentChanged(workspaceId, answer),
      }),
    /**
     * Admins: a new secret, or a new value for one by its name. The value goes to the API and
     * nowhere else: the mutation is let go of as soon as nothing watches it.
     */
    saveSecret: () =>
      mutationOptions({
        mutationFn: (vars: {
          workspaceId: string;
          repoId: string;
          name: string;
          value: string;
          replacing: boolean;
        }) =>
          vars.replacing
            ? api.environments.replaceSecret(vars.repoId, vars.name, vars.value)
            : api.environments.addSecret(vars.repoId, { name: vars.name, value: vars.value }),
        onSuccess: (answer, { workspaceId }) => environmentChanged(workspaceId, answer),
        onError: (_error, { workspaceId }) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.environments(workspaceId) }),
        gcTime: 0,
      }),
    /** Admins. */
    removeSecret: () =>
      mutationOptions({
        mutationFn: ({ repoId, name }: { workspaceId: string; repoId: string; name: string }) =>
          api.environments.removeSecret(repoId, name),
        onSuccess: (answer, { workspaceId }) => environmentChanged(workspaceId, answer),
        onError: (_error, { workspaceId }) =>
          queryClient.invalidateQueries({ queryKey: queryKeys.environments(workspaceId) }),
      }),
    /** Admins. Whole dollars; 400 `cap_too_low` below what the period has billed. */
    setCap: () =>
      mutationOptions({
        mutationFn: ({ workspaceId, capUsd }: { workspaceId: string; capUsd: number }) =>
          api.usage.setCap(workspaceId, capUsd),
        onSuccess: (usage, { workspaceId }) =>
          queryClient.setQueryData(queryKeys.usage(workspaceId), usage),
      }),
    /**
     * Deletes the account, confirmed with the person's GitHub login. 409 `sole_admin` while
     * they are the only admin of a team others are in. The app signs out once it resolves.
     */
    deleteAccount: () =>
      mutationOptions({ mutationFn: (confirm: string) => api.account.delete(confirm) }),
  };

  /** One repo's environment changed: it, in the workspace's list. */
  function environmentChanged(workspaceId: string, answer: EnvironmentAnswer) {
    queryClient.setQueryData<Environments>(queryKeys.environments(workspaceId), (now) =>
      now
        ? {
            ...now,
            repos: now.repos.map((env) =>
              env.repo.id === answer.environment.repo.id ? answer.environment : env,
            ),
          }
        : now,
    );
  }
}

export type PonzuMutations = ReturnType<typeof ponzuMutations>;
