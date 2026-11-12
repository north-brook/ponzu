import type { DeepLink, GithubSetupResult } from "./bridge.ts";

/*
 * `ponzu://` links (bridge.ts has the grammar). Any web page can open one, so a link is only
 * ever a request to show something the person could open anyway: it never signs in, writes or
 * sends anything, and one that doesn't parse is dropped without a word.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The first segments that open a canvas: today's, and the one from before the rename. */
const OPENS_A_CANVAS = new Set(["canvas", "design"]);
const SETUP_RESULTS: readonly GithubSetupResult[] = [
  "installed",
  "requested",
  "pending",
  "sign_in",
  "failed",
];

/** The link `url` stands for under `scheme` (`ponzu`, or Ponzu Dev's `ponzu-dev`). */
export function parseDeepLink(url: string, scheme: string): DeepLink | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== `${scheme}:`) return null;
  const path = [parsed.hostname, ...parsed.pathname.split("/")].filter(Boolean);
  const query = parsed.searchParams;
  const id = (name: string) => {
    const value = query.get(name);
    return value && ID.test(value) ? value : undefined;
  };

  // `<scheme>://design/<id>` is the same link as written before canvases had their name: links
  // already in pull requests, threads and notifications keep it, so it opens for good.
  if (OPENS_A_CANVAS.has(path[0]!) && path.length === 2 && ID.test(path[1]!)) {
    const pageId = id("page");
    const artboardId = id("artboard");
    return {
      kind: "canvas",
      canvasId: path[1]!,
      ...(pageId ? { pageId } : {}),
      ...(artboardId ? { artboardId } : {}),
    };
  }
  if (path[0] === "github" && path[1] === "setup" && path.length === 2) {
    const result = query.get("result") as GithubSetupResult | null;
    if (!result || !SETUP_RESULTS.includes(result)) return null;
    const workspaceId = result === "installed" ? id("workspace") : undefined;
    return { kind: "github_setup", result, ...(workspaceId ? { workspaceId } : {}) };
  }
  return null;
}

/** The links among a launch's arguments: how Windows and Linux hand one over. */
export function linksIn(argv: readonly string[], scheme: string): string[] {
  return argv.slice(1).filter((arg) => arg.toLowerCase().startsWith(`${scheme}:`));
}
