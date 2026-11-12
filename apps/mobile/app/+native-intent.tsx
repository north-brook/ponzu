import { backend } from "../lib/cloud/backend";
import { config } from "../lib/cloud/config";
import { incomingPath } from "../lib/links";

/**
 * Every link the system hands the app (a deep link, a universal link) passes through here
 * before Expo Router reads it. lib/links.ts decides: a link in this build's scheme opens its
 * screen; anything else (the other variant's scheme, an unknown path) opens the launch screen.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return incomingPath(path, config().scheme, { dev: backend.kind === "fake" });
  } catch {
    return "/";
  }
}
