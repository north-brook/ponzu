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

  /** Everything cached about one design: its thread's pages, its pull request and diffs. */
  design: (designId: string) => ["ponzu", "design", designId] as const,
  /** A page of a design's thread, before a seq (or the newest). */
  threadPage: (designId: string, before: number | null, limit: number) =>
    ["ponzu", "design", designId, "thread", before, limit] as const,
  /** One of the agent's questions as it stands. */
  question: (designId: string, questionId: string) =>
    ["ponzu", "design", designId, "question", questionId] as const,
  pullRequest: (designId: string) => ["ponzu", "design", designId, "pull-request"] as const,
  /** One changed file's diff at a commit: a push makes another, so the commit is the key. */
  pullRequestFile: (designId: string, path: string, headSha: string | null) =>
    ["ponzu", "design", designId, "pull-request", "file", path, headSha] as const,
};
