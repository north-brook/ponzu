/*
 * Every request/response answer the apps cache, by key. One QueryClient holds one person's
 * answers (`createQueryClient`, made again at each sign-in), so no key names who is asking.
 */
export const queryKeys = {
  /** Everything under Ponzu. */
  all: ["ponzu"] as const,
  me: () => ["ponzu", "me"] as const,
  githubAccounts: () => ["ponzu", "github", "accounts"] as const,
  workspace: (workspaceId: string) => ["ponzu", "workspace", workspaceId] as const,
  claudeAccount: () => ["ponzu", "claude", "account"] as const,
  claudeDefaults: () => ["ponzu", "claude", "defaults"] as const,
};
