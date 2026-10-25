/*
 * A link to a design on one of the person's Macs, for an agent to hand the person: clicking it
 * opens the design in Ponzu, optionally on one artboard, where a path would open their editor.
 *
 *   https://ponzu.design/local#mac=studio&file=/Users/sam/app/design/app.design&artboard=ab_hero   the Mac app
 *   http://localhost:7777/?file=/Users/sam/app/design/app.design                       a `ponzu serve` canvas
 *
 * Chats drop links in schemes they don't know, so agents hand out ponzu.design/local, which passes
 * the design on to the app as `ponzu://open?mac=…&file=…` (appLink) or offers the download. The
 * path rides after the #, which browsers never send, so it stays on the person's Mac. /local pairs
 * with /gh/<owner>/<repo>/…, a design on GitHub.
 *
 * `mac` is the Mac the design is on, by its tailnet name, so the link opens it from the person's
 * other Macs too, through Ponzu's relay. Without Tailscale there's no name and the link opens the
 * path on whichever Mac clicks it.
 *
 * The Mac app also takes `ponzu://open?repo=…` for a design on GitHub (@ponzu/server/clone).
 */

/** Artboard ids are newId's: a prefix, an underscore and base-36. Leave room for older ones. */
const ARTBOARD = /^[A-Za-z0-9_-]{1,64}$/;
/** A tailnet host name, as readTailnet gives it: one lowercase DNS label. */
const MAC = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The page on ponzu.design that opens a design in the Mac app (apps/web/app/local). */
export const OPEN_PAGE = "https://ponzu.design/local";

export interface DesignLink {
  /** The .design folder, absolute, on `mac`. */
  path: string;
  artboard?: string;
  /** The tailnet name of the Mac it's on. Missing: the Mac that opens the link. */
  mac?: string;
}

interface LinkOptions {
  artboard?: string;
  mac?: string;
}

/**
 * The link that opens `path` in Ponzu: ponzu.design's open page, or with `origin`, that server's
 * canvas, which knows its own Mac. Slashes stay readable; anything else that could end a link is
 * escaped, parentheses too, since a markdown link ends at one.
 */
export function designLink(path: string, opts: LinkOptions & { origin?: string } = {}) {
  if (opts.origin) return `${opts.origin}/?${designQuery(path, { artboard: opts.artboard })}`;
  return `${OPEN_PAGE}#${designQuery(path, opts)}`;
}

/** The Mac app's own link to `path`, `ponzu://open?mac=…&file=…`, which the open page hands it. */
export function appLink(path: string, opts: LinkOptions = {}) {
  return `ponzu://open?${designQuery(path, opts)}`;
}

function designQuery(path: string, { artboard, mac }: LinkOptions) {
  const file = encodePart(path).replace(/%2F/g, "/");
  const at = mac && MAC.test(mac) ? `mac=${mac}&` : "";
  return `${at}file=${file}${artboard ? `&artboard=${encodePart(artboard)}` : ""}`;
}

function encodePart(s: string): string {
  return encodeURIComponent(s).replace(
    /[()'*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `ponzu://open?mac=<name>&file=<absolute path>.design&artboard=<id>`, as appLink writes it. Null
 * for anything else: a repo link, a relative path, one that climbs with `..`, or a bad artboard id
 * or Mac name. Whether a design is there is for the opener to check.
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
  return designFromParams((name) => url.searchParams.get(name));
}

/**
 * The design an open link's query names (`file`, `artboard`, `mac`), checked as parseDesignLink
 * checks it. For a reader that has the query without the URL: the phone's router hands it over
 * parsed, and React Native's URL reads no host from a ponzu:// link.
 */
export function designFromParams(get: (name: string) => string | null): DesignLink | null {
  const path = (get("file") ?? "").replace(/\/+$/, "");
  const segments = path.split("/").slice(1);
  if (
    !path.startsWith("/") ||
    !path.endsWith(".design") ||
    path.includes("\0") ||
    segments.some((s) => s === "" || s === "." || s === "..")
  )
    return null;
  const artboard = get("artboard") ?? undefined;
  if (artboard !== undefined && !ARTBOARD.test(artboard)) return null;
  const mac = get("mac") ?? undefined;
  if (mac !== undefined && !MAC.test(mac)) return null;
  return { path, ...(artboard ? { artboard } : {}), ...(mac ? { mac } : {}) };
}
