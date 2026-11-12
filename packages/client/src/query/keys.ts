/*
 * Every request/response answer the apps cache, by key. One QueryClient holds one person's
 * answers (`createQueryClient`, made again at each sign-in), so no key names who is asking.
 */
export const queryKeys = {
  /** Everything under Ponzu. */
  all: ["ponzu"] as const,
  me: () => ["ponzu", "me"] as const,
  githubAccounts: () => ["ponzu", "github", "accounts"] as const,
  /** Every workspace's answer, to ask for them all again. */
  workspaces: () => ["ponzu", "workspace"] as const,
  workspace: (workspaceId: string) => ["ponzu", "workspace", workspaceId] as const,
  claudeAccount: () => ["ponzu", "claude", "account"] as const,
  claudeDefaults: () => ["ponzu", "claude", "defaults"] as const,

  /** The person's ping toggles and their devices. */
  notifications: () => ["ponzu", "notifications"] as const,
  /** A workspace's repos that have an environment. */
  environments: (workspaceId: string) => ["ponzu", "environments", workspaceId] as const,
  /** A workspace's usage this billing period, as the person may see it. */
  usage: (workspaceId: string) => ["ponzu", "usage", workspaceId] as const,

  /** Everything cached about one canvas: its thread's pages, its pull request and diffs. */
  canvas: (canvasId: string) => ["ponzu", "canvas", canvasId] as const,
  /** A page of a canvas's thread, before a seq (or the newest). */
  threadPage: (canvasId: string, before: number | null, limit: number) =>
    ["ponzu", "canvas", canvasId, "thread", before, limit] as const,
  /** One of the agent's questions as it stands. */
  question: (canvasId: string, questionId: string) =>
    ["ponzu", "canvas", canvasId, "question", questionId] as const,
  pullRequest: (canvasId: string) => ["ponzu", "canvas", canvasId, "pull-request"] as const,
  /** Who can open a canvas, for Share. */
  canvasPeople: (canvasId: string) => ["ponzu", "canvas", canvasId, "people"] as const,
  /** One changed file's diff at a commit: a push makes another, so the commit is the key. */
  pullRequestFile: (canvasId: string, path: string, headSha: string | null) =>
    ["ponzu", "canvas", canvasId, "pull-request", "file", path, headSha] as const,
};
