/** Where the workspace in view is kept for a person. */
export const workspaceKey = (userId: string) => `ponzu.workspace.${userId}`;

/** The workspace picked, while the person still belongs to it; else their first; else none. */
export function pickWorkspace(
  stored: string | null,
  workspaces: readonly { id: string }[],
): string | null {
  if (stored && workspaces.some((w) => w.id === stored)) return stored;
  return workspaces[0]?.id ?? null;
}
