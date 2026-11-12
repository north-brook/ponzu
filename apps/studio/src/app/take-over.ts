import { ApiError } from "@ponzu/client";

/**
 * What the window says when taking over a canvas whose owner left didn't happen, by why: its
 * owner came back (or a teammate took it first), or the person's own Claude can't run it.
 */
export function takeOverRefusal(error: unknown): string {
  const code = error instanceof ApiError ? error.code : null;
  if (code === "not_ownerless") {
    return "It has an owner in the workspace again, so it runs on their Claude.";
  }
  if (code === "claude_not_connected") return "Connect your Claude first, then take it over.";
  return "It couldn't be taken over. Try again.";
}
