/*
 * A link to a design on one of the person's Macs, for an agent to hand the person: clicking it
 * opens the design in Ponzu, optionally on one page or one artboard, where a path would open their
 * editor.
 *
 *   https://ponzu.design/local#mac=studio&file=/Users/sam/app/design/app.design&artboard=ab_hero   the Mac app
 *   https://ponzu.design/local#mac=studio&file=/Users/sam/app/design/app.design&page=pg_flow   on a page
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

import { type Doc, findArtboard } from "./doc.ts";

/** Page and artboard ids are newId's: a prefix, an underscore and base-36. Leave room for older. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A tailnet host name, as readTailnet gives it: one lowercase DNS label. */
const MAC = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The page on ponzu.design that opens a design in the Mac app (apps/web/app/local). */
export const OPEN_PAGE = "https://ponzu.design/local";

export interface DesignLink {
  /** The .design folder, absolute, on `mac`. */
  path: string;
  /** A page to open on, by id. Where it and `artboard` disagree, the page wins (linkTarget). */
  page?: string;
  artboard?: string;
  /** The tailnet name of the Mac it's on. Missing: the Mac that opens the link. */
  mac?: string;
}

interface LinkOptions {
  page?: string;
  artboard?: string;
  mac?: string;
}

/**
 * The link that opens `path` in Ponzu: ponzu.design's open page, or with `origin`, that server's
 * canvas, which knows its own Mac. Slashes stay readable; anything else that could end a link is
 * escaped, parentheses too, since a markdown link ends at one.
 */
export function designLink(path: string, opts: LinkOptions & { origin?: string } = {}) {
  if (opts.origin)
    return `${opts.origin}/?${designQuery(path, { page: opts.page, artboard: opts.artboard })}`;
  return `${OPEN_PAGE}#${designQuery(path, opts)}`;
}

/** The Mac app's own link to `path`, `ponzu://open?mac=…&file=…`, which the open page hands it. */
export function appLink(path: string, opts: LinkOptions = {}) {
  return `ponzu://open?${designQuery(path, opts)}`;
}

function designQuery(path: string, { page, artboard, mac }: LinkOptions) {
  const file = encodePart(path).replace(/%2F/g, "/");
  const at = mac && MAC.test(mac) ? `mac=${mac}&` : "";
  const on = page ? `&page=${encodePart(page)}` : "";
  return `${at}file=${file}${on}${artboard ? `&artboard=${encodePart(artboard)}` : ""}`;
}

function encodePart(s: string): string {
  return encodeURIComponent(s).replace(
    /[()'*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `ponzu://open?mac=<name>&file=<absolute path>.design&page=<id>&artboard=<id>`, as appLink writes
 * it. Null for anything else: a repo link, a relative path, one that climbs with `..`, or a bad
 * page or artboard id or Mac name. Whether a design is there is for the opener to check.
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
 * The design an open link's query names (`file`, `page`, `artboard`, `mac`), checked as
 * parseDesignLink checks it. For a reader that has the query without the URL: the phone's router
 * hands it over parsed, and React Native's URL reads no host from a ponzu:// link.
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
  const page = get("page") ?? undefined;
  if (page !== undefined && !ID.test(page)) return null;
  const artboard = get("artboard") ?? undefined;
  if (artboard !== undefined && !ID.test(artboard)) return null;
  const mac = get("mac") ?? undefined;
  if (mac !== undefined && !MAC.test(mac)) return null;
  return {
    path,
    ...(page ? { page } : {}),
    ...(artboard ? { artboard } : {}),
    ...(mac ? { mac } : {}),
  };
}

/**
 * Where a link opens in `doc`: the page it names, framed as a page, or the board it names, on its
 * page. With both, the board only when it's on that page: a board that has moved to another page
 * or gone, the page alone. A page that isn't there leaves the board to decide. Pages are found by
 * id, or by name for the phone's own links. Null when the doc has neither.
 */
export function linkTarget(
  doc: Doc,
  at: { page?: string; artboard?: string },
): { pageId: string; artboardId?: string } | null {
  const page = at.page
    ? (doc.pages.find((p) => p.id === at.page) ?? doc.pages.find((p) => p.name === at.page))
    : undefined;
  const hit = at.artboard ? findArtboard(doc, at.artboard) : null;
  if (hit && (!page || hit.page === page))
    return { pageId: hit.page.id, artboardId: hit.artboard.id };
  return page ? { pageId: page.id } : null;
}
