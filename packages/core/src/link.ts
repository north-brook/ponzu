/*
 * A link to a design on this Mac, for an agent to hand the person: clicking it opens the design
 * in Ponzu, optionally on one artboard, where a path would open their editor.
 *
 *   https://ponzu.design/open#file=/Users/sam/app/design/app.design&artboard=ab_hero   the Mac app
 *   http://localhost:7777/?file=/Users/sam/app/design/app.design            a `ponzu serve` canvas
 *
 * Chats drop links in schemes they don't know, so agents hand out ponzu.design/open, which passes
 * the design on to the app as `ponzu://open?file=…` (appLink) or offers the download. The path
 * rides after the #, which browsers never send, so it stays on the person's Mac.
 *
 * The Mac app also takes `ponzu://open?repo=…` for a design on GitHub (@ponzu/server/clone).
 */

/** Artboard ids are newId's: a prefix, an underscore and base-36. Leave room for older ones. */
const ARTBOARD = /^[A-Za-z0-9_-]{1,64}$/;

/** The page on ponzu.design that opens a design in the Mac app (apps/web/app/open). */
export const OPEN_PAGE = "https://ponzu.design/open";

export interface DesignLink {
  /** The .design folder, absolute. */
  path: string;
  artboard?: string;
}

/**
 * The link that opens `path` in Ponzu: ponzu.design's open page, or with `origin`, that server's
 * canvas. Slashes stay readable; anything else that could end a link is escaped, parentheses
 * too, since a markdown link ends at one.
 */
export function designLink(path: string, opts: { artboard?: string; origin?: string } = {}) {
  const q = designQuery(path, opts.artboard);
  return opts.origin ? `${opts.origin}/?${q}` : `${OPEN_PAGE}#${q}`;
}

/** The Mac app's own link to `path`, `ponzu://open?file=…`, which the open page hands it. */
export function appLink(path: string, opts: { artboard?: string } = {}) {
  return `ponzu://open?${designQuery(path, opts.artboard)}`;
}

function designQuery(path: string, artboard?: string) {
  const file = encodePart(path).replace(/%2F/g, "/");
  return `file=${file}${artboard ? `&artboard=${encodePart(artboard)}` : ""}`;
}

function encodePart(s: string): string {
  return encodeURIComponent(s).replace(
    /[()'*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `ponzu://open?file=<absolute path>.design&artboard=<id>`, as appLink writes it. Null for
 * anything else: a repo link, a relative path, one that climbs with `..`, or a bad artboard id.
 * Whether a design is there is for the opener to check.
 */
export function parseDesignLink(raw: string): DesignLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "ponzu:") return null;
  // `ponzu://open?…` puts "open" in the host; `ponzu:open?…` in the path.
  const action = url.hostname || url.pathname.replace(/^\/+|\/+$/g, "");
  if (action !== "open") return null;
  const path = (url.searchParams.get("file") ?? "").replace(/\/+$/, "");
  const segments = path.split("/").slice(1);
  if (
    !path.startsWith("/") ||
    !path.endsWith(".design") ||
    path.includes("\0") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  )
    return null;
  const artboard = url.searchParams.get("artboard") ?? undefined;
  if (artboard !== undefined && !ARTBOARD.test(artboard)) return null;
  return artboard ? { path, artboard } : { path };
}
