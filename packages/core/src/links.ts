/*
 * The apps' own links: one grammar for the Mac, the iPhone, a push and the API that writes them.
 *
 *   <scheme>://canvas/<canvas id>?page=&artboard=&open=&question=&comment=&message=&n=
 *   <scheme>://github/setup?result=<result>&workspace=<workspace id>
 *   <scheme>://auth/callback?code=<code>&state=<state>
 *   <scheme>://billing/card?setup=<setup id>&result=added|cancelled
 *   <scheme>://settings?section=usage|notifications|account&n=
 *
 * `n` is the notification a link came from (a canvas's, or a workspace's billing ping, which
 * opens Plan and usage), so opening it can mark it read.
 *
 * `<scheme>` is `ponzu`, or a development build's `ponzu-dev`. A link written as
 * `<scheme>://design/<id>` is the same canvas link from before canvases had their name: links
 * already in pull requests, threads and notifications keep it, so it is read for good. Nothing
 * writes it any more.
 *
 * Any web page can open one of these, so a link is only ever a request to show something the
 * person could open anyway. Parsing is exact: the whole link is matched before anything in it is
 * read, so a `..`, an encoded slash or a stray character drops it rather than being normalised
 * into some other path. A required part that isn't one drops the link; an optional part that
 * isn't one (or appears twice) is left out, not trusted. Pure: no DOM, no Node.
 */

/** The schemes the apps answer: the release's, and a development build's. */
export const LINK_SCHEMES = ["ponzu", "ponzu-dev"] as const;
export type LinkScheme = (typeof LINK_SCHEMES)[number];

/** Ids as every client takes them: a prefix, an underscore and base-36, with room for older. */
export const LINK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A sign-in's code and state: URL-safe characters, never more than a page of them. */
const TOKEN = /^[A-Za-z0-9._~-]{1,512}$/;
/** A message's place in its thread: a whole number written plainly. */
const SEQ = /^(?:0|[1-9][0-9]{0,15})$/;
/** The whole link: a scheme, non-empty segments of id characters, and maybe a query. */
const SHAPE =
  /^([A-Za-z][A-Za-z0-9-]*):\/\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)\/?(?:\?([^#\s]*))?$/;

export const CANVAS_OPENS = ["thread", "pull-request", "comment", "usage"] as const;
/** What to open on the canvas once it shows: its thread, its pull request, a comment, usage. */
export type CanvasOpen = (typeof CANVAS_OPENS)[number];

export const GITHUB_SETUP_RESULTS = [
  "installed",
  "requested",
  "pending",
  "sign_in",
  "failed",
] as const;
/** How GitHub's install page ended, as the API's setup page links back. */
export type GithubSetupResult = (typeof GITHUB_SETUP_RESULTS)[number];

export const CARD_SETUP_RESULTS = ["added", "cancelled"] as const;
export type CardSetupResult = (typeof CARD_SETUP_RESULTS)[number];

export const SETTINGS_SECTIONS = ["usage", "notifications", "account"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type CanvasLink = {
  kind: "canvas";
  canvasId: string;
  pageId?: string;
  artboardId?: string;
  open?: CanvasOpen;
  questionId?: string;
  commentThreadId?: string;
  messageSeq?: number;
  /** The notification the link came from, so opening it can mark it read. */
  notificationId?: string;
};

export type AppLink =
  | CanvasLink
  | { kind: "github_setup"; result: GithubSetupResult; workspaceId?: string }
  | { kind: "auth_callback"; code: string; state: string }
  | { kind: "card_setup"; setupId: string; result: CardSetupResult }
  | {
      kind: "settings";
      section?: SettingsSection;
      /** The notification the link came from, so opening it can mark it read. */
      notificationId?: string;
    };

export type AppLinkKind = AppLink["kind"];

/** A canvas link's optional parts, by the query name each is written under. */
const CANVAS_IDS = [
  ["pageId", "page"],
  ["artboardId", "artboard"],
  ["questionId", "question"],
  ["commentThreadId", "comment"],
  ["notificationId", "n"],
] as const;

export function isLinkScheme(scheme: string): scheme is LinkScheme {
  return (LINK_SCHEMES as readonly string[]).includes(scheme);
}

function oneOf<T extends string>(values: readonly T[], value: string | undefined): T | undefined {
  return value !== undefined && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** The link `url` stands for under `scheme`, or null when it is not exactly one of ours. */
export function parseAppLink(url: string, scheme: string): AppLink | null {
  if (!isLinkScheme(scheme)) return null;
  const shape = SHAPE.exec(url);
  // A scheme is the same in either case (RFC 3986); nothing else in a link is.
  if (!shape || shape[1]!.toLowerCase() !== scheme) return null;
  const path = shape[2]!.split("/");
  const query = new URLSearchParams(shape[3] ?? "");
  /** A query value given exactly once, or undefined. */
  const one = (name: string) => {
    const values = query.getAll(name);
    return values.length === 1 ? values[0] : undefined;
  };
  const id = (name: string) => {
    const value = one(name);
    return value !== undefined && LINK_ID.test(value) ? value : undefined;
  };
  const route = path.join("/");

  if ((path[0] === "canvas" || path[0] === "design") && path.length === 2) {
    if (!LINK_ID.test(path[1]!)) return null;
    const link: CanvasLink = { kind: "canvas", canvasId: path[1]! };
    for (const [field, name] of CANVAS_IDS) {
      const value = id(name);
      if (value) link[field] = value;
    }
    const open = oneOf(CANVAS_OPENS, one("open"));
    if (open) link.open = open;
    const seq = one("message");
    if (seq !== undefined && SEQ.test(seq) && Number.isSafeInteger(Number(seq))) {
      link.messageSeq = Number(seq);
    }
    return link;
  }
  if (route === "github/setup") {
    const result = oneOf(GITHUB_SETUP_RESULTS, one("result"));
    if (!result) return null;
    // Only an install names the workspace it set up.
    const workspaceId = result === "installed" ? id("workspace") : undefined;
    return { kind: "github_setup", result, ...(workspaceId ? { workspaceId } : {}) };
  }
  if (route === "auth/callback") {
    const code = one("code");
    const state = one("state");
    if (!code || !state || !TOKEN.test(code) || !TOKEN.test(state)) return null;
    return { kind: "auth_callback", code, state };
  }
  if (route === "billing/card") {
    const setupId = id("setup");
    const result = oneOf(CARD_SETUP_RESULTS, one("result"));
    if (!setupId || !result) return null;
    return { kind: "card_setup", setupId, result };
  }
  if (route === "settings") {
    const section = oneOf(SETTINGS_SECTIONS, one("section"));
    const notificationId = id("n");
    return {
      kind: "settings",
      ...(section ? { section } : {}),
      ...(notificationId ? { notificationId } : {}),
    };
  }
  return null;
}

/**
 * `link` written in `scheme`. It throws on a part that `parseAppLink` would not take back, since
 * a link that can't be followed is a bug in its writer, not something to hand a person.
 */
export function appLink(link: AppLink, scheme: LinkScheme): string {
  if (!isLinkScheme(scheme)) throw new Error("appLink: not one of the apps' schemes");
  const query = new URLSearchParams();
  const put = (name: string, value: string | undefined, pattern: RegExp) => {
    if (value === undefined) return;
    if (!pattern.test(value)) throw new Error(`appLink: ${name} is not one`);
    query.set(name, value);
  };
  const putOneOf = (name: string, values: readonly string[], value: string | undefined) => {
    if (value === undefined) return;
    if (!values.includes(value)) throw new Error(`appLink: ${name} is not one`);
    query.set(name, value);
  };
  let route: string;
  switch (link.kind) {
    case "canvas": {
      if (!LINK_ID.test(link.canvasId)) throw new Error("appLink: canvasId is not one");
      route = `canvas/${link.canvasId}`;
      put("page", link.pageId, LINK_ID);
      put("artboard", link.artboardId, LINK_ID);
      putOneOf("open", CANVAS_OPENS, link.open);
      put("question", link.questionId, LINK_ID);
      put("comment", link.commentThreadId, LINK_ID);
      if (link.messageSeq !== undefined) {
        if (!Number.isSafeInteger(link.messageSeq) || link.messageSeq < 0) {
          throw new Error("appLink: messageSeq is not one");
        }
        query.set("message", String(link.messageSeq));
      }
      put("n", link.notificationId, LINK_ID);
      break;
    }
    case "github_setup":
      route = "github/setup";
      putOneOf("result", GITHUB_SETUP_RESULTS, link.result);
      if (link.workspaceId !== undefined && link.result !== "installed") {
        throw new Error("appLink: only an install names its workspace");
      }
      put("workspace", link.workspaceId, LINK_ID);
      break;
    case "auth_callback":
      route = "auth/callback";
      put("code", link.code, TOKEN);
      put("state", link.state, TOKEN);
      break;
    case "card_setup":
      route = "billing/card";
      put("setup", link.setupId, LINK_ID);
      putOneOf("result", CARD_SETUP_RESULTS, link.result);
      break;
    case "settings":
      route = "settings";
      putOneOf("section", SETTINGS_SECTIONS, link.section);
      put("n", link.notificationId, LINK_ID);
      break;
  }
  const search = query.toString();
  return `${scheme}://${route}${search ? `?${search}` : ""}`;
}
