import { type AppLink, parseAppLink } from "@ponzu/core/links";

/*
 * The app's only reader of links: deep links (app/+native-intent.tsx), and later pushes and the
 * links in a thread. A link is only ever a request to show something the person could open
 * anyway: it never signs in, writes or sends anything. It must use this build's own scheme
 * (`ponzu`, or Ponzu Dev's `ponzu-dev`); anything else is refused, so a link meant for the
 * other app never opens here.
 *
 * The grammar is `@ponzu/core/links`, the one every client reads. On Hermes its query parsing
 * uses React Native's URLSearchParams, which can throw on bad percent-encoding;
 * app/+native-intent.tsx catches that and opens the launch screen.
 */

export type { AppLink };

export type Route =
  | {
      screen: "canvas";
      id: string;
      params: {
        page?: string;
        artboard?: string;
        sheet?: "chat" | "pull-request";
        question?: string;
        thread?: string;
        message?: string;
      };
    }
  | { screen: "github-setup"; params: { result: string; workspace?: string } }
  | { screen: "auth-callback" }
  | { screen: "settings"; params: { section?: string } };

/** What a link opens in this app, or null when it opens nothing here. */
export function routeOf(link: AppLink): Route | null {
  switch (link.kind) {
    case "canvas": {
      const params: Extract<Route, { screen: "canvas" }>["params"] = {};
      if (link.pageId) params.page = link.pageId;
      if (link.artboardId) params.artboard = link.artboardId;
      if (link.open === "thread") params.sheet = "chat";
      if (link.open === "pull-request") params.sheet = "pull-request";
      if (link.questionId) {
        params.question = link.questionId;
        params.sheet = "chat";
      }
      if (link.commentThreadId) params.thread = link.commentThreadId;
      if (link.messageSeq !== undefined) params.message = String(link.messageSeq);
      return { screen: "canvas", id: link.canvasId, params };
    }
    case "github_setup":
      return {
        screen: "github-setup",
        params: {
          result: link.result,
          ...(link.workspaceId ? { workspace: link.workspaceId } : {}),
        },
      };
    case "auth_callback":
      // The auth session takes its own redirect; one that arrives as a link goes nowhere.
      return { screen: "auth-callback" };
    case "settings":
      return { screen: "settings", params: link.section ? { section: link.section } : {} };
    case "card_setup":
      // Billing is the Mac's: the phone never adds a card.
      return null;
  }
}

/** `url` read under this build's `scheme`, as a route, or null. */
export function parseLink(url: string, scheme: string): Route | null {
  const link = parseAppLink(url, scheme);
  return link ? routeOf(link) : null;
}

const query = (params: Record<string, string | undefined>) => {
  const pairs = Object.entries(params).filter((pair): pair is [string, string] => !!pair[1]);
  return pairs.length
    ? `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
    : "";
};

/** The in-app path a route opens (Expo Router's). */
export function pathOf(route: Route): string {
  switch (route.screen) {
    case "canvas":
      return `/canvas/${route.id}${query(route.params)}`;
    case "github-setup":
      return `/github/setup${query(route.params)}`;
    case "auth-callback":
      return "/auth/callback";
    case "settings":
      return `/settings${query(route.params)}`;
  }
}

/** A page's or board's id, as the canvas's own addresses carry them. */
const PLACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A canvas's own address on the web, exactly: https, the host alone, the one path. */
const CANVAS_ADDRESS =
  /^https:\/\/ponzu\.design\/(?:canvases|designs)\/([A-Za-z0-9_-]{1,64})\/?(?:\?([^#\s]*))?(?:#[^\s]*)?$/;

/**
 * A link in Ponzu's reply in the thread, if it is to a canvas: the canvas's own address as the
 * API gives it to the agent (`https://ponzu.design/canvases/<id>?page=…` or `?artboard=…`, and
 * the older `/designs/<id>`), or this build's own canvas link. Anything else is an ordinary link
 * (or none). Read exactly, as the Mac reads it (apps/studio/src/cloud/ui/canvas-address.ts): a
 * place that isn't an id, or named twice, makes it not a canvas link at all.
 */
export function threadLink(
  href: string,
  scheme: string,
): Extract<Route, { screen: "canvas" }> | null {
  const address = CANVAS_ADDRESS.exec(href.trim());
  if (address) {
    const params: { page?: string; artboard?: string } = {};
    for (const pair of (address[2] ?? "").split("&")) {
      if (!pair) continue;
      const at = pair.indexOf("=");
      const name = at < 0 ? pair : pair.slice(0, at);
      const value = at < 0 ? "" : pair.slice(at + 1);
      if (name !== "page" && name !== "artboard") continue;
      if (params[name] !== undefined || !PLACE_ID.test(value)) return null;
      params[name] = value;
    }
    return { screen: "canvas", id: address[1]!, params };
  }
  try {
    const route = parseLink(href.trim(), scheme);
    return route?.screen === "canvas" ? route : null;
  } catch {
    // React Native's URLSearchParams throws on bad percent-encoding: not a canvas link.
    return null;
  }
}

/**
 * Where an incoming link goes: its path, or the launch screen for a link this build refuses or
 * doesn't know. `https://ponzu.design/canvases/<id>` (a universal link, once the site serves
 * the association) is read as the same canvas link. `<scheme>://dev?…` reaches app/dev.tsx
 * only when `dev` is set: a build on the fake backend, for tests and demos.
 */
export function incomingPath(url: string, scheme: string, opts: { dev?: boolean } = {}): string {
  // Already a path in the app (the router's own), not a link from outside.
  if (url.startsWith("/")) return url;
  const dev = new RegExp(`^${scheme}://dev/?(\\?[^#]*)?$`, "i").exec(url);
  if (dev) return opts.dev ? `/dev${dev[1] ?? ""}` : "/";
  const universal = /^https:\/\/ponzu\.design\/canvases\/([^/?#]+)(\?[^#]*)?/.exec(url);
  const asApp = universal ? `${scheme}://canvas/${universal[1]}${universal[2] ?? ""}` : url;
  const route = parseLink(asApp, scheme);
  return route ? pathOf(route) : "/";
}
