import { parseAppLink } from "@ponzu/core/links";
import type { DeepLink } from "./bridge.ts";

/*
 * `ponzu://` links, in the grammar every client shares (@ponzu/core/links; bridge.ts lists what
 * the Mac takes). Any web page can open one, so a link is only ever a request to show something
 * the person could open anyway: it never signs in, writes or sends anything, and one that doesn't
 * parse is dropped without a word.
 *
 * A sign-in's way back (`auth/callback`) is the iPhone's: the Mac signs in through a loopback
 * listener (sign-in.ts), so here that link is dropped like any other stranger.
 */

/** The link `url` stands for under `scheme` (`ponzu`, or Ponzu Dev's `ponzu-dev`). */
export function parseDeepLink(url: string, scheme: string): DeepLink | null {
  const link = parseAppLink(url, scheme);
  return link && link.kind !== "auth_callback" ? link : null;
}

/** The links among a launch's arguments: how Windows and Linux hand one over. */
export function linksIn(argv: readonly string[], scheme: string): string[] {
  return argv.slice(1).filter((arg) => arg.toLowerCase().startsWith(`${scheme}:`));
}
