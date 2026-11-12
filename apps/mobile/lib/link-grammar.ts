/*
 * A local copy of the app link grammar that `@ponzu/core/links` is to own (the cloud program's
 * G5: `parseAppLink(url, scheme): AppLink | null`). It is here only until that module lands:
 * then this file is deleted and lib/links.ts imports core's, with the same names and shapes.
 * Nothing but lib/links.ts imports it.
 *
 * It reads the text itself rather than through `URL`, whose React Native version does not
 * parse a custom scheme's host and path the way a browser does.
 */

export type AppLink =
  | {
      kind: "canvas";
      canvasId: string;
      pageId?: string;
      artboardId?: string;
      open?: "thread" | "pull-request" | "comment" | "usage";
      questionId?: string;
      commentThreadId?: string;
      messageSeq?: number;
      notificationId?: string;
    }
  | { kind: "github_setup"; result: string; workspaceId?: string }
  | { kind: "auth_callback"; code: string; state: string }
  | { kind: "card_setup"; setupId: string; result: "added" | "cancelled" }
  | { kind: "settings"; section?: "usage" | "notifications" | "account" };

/** The schemes a Ponzu app answers to. Each app takes only its own. */
export const APP_SCHEMES = ["ponzu", "ponzu-dev"] as const;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPENS = ["thread", "pull-request", "comment", "usage"] as const;
const SECTIONS = ["usage", "notifications", "account"] as const;
const SETUP_RESULTS = ["installed", "requested", "pending", "sign_in", "failed"];

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

function queryOf(text: string): Map<string, string> {
  const query = new Map<string, string>();
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    const name = decode(at < 0 ? pair : pair.slice(0, at));
    const value = decode(at < 0 ? "" : pair.slice(at + 1));
    // The first of a name wins, as `URLSearchParams.get` has it.
    if (name !== null && value !== null && !query.has(name)) query.set(name, value);
  }
  return query;
}

const oneOf = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  value !== undefined && (list as readonly string[]).includes(value) ? (value as T) : undefined;

/** The link `url` stands for under `scheme`, or null for anything else, which is dropped. */
export function parseAppLink(url: string, scheme: string): AppLink | null {
  const prefix = `${scheme}://`;
  if (!url.toLowerCase().startsWith(prefix)) return null;
  const rest = url.slice(prefix.length).split("#")[0]!;
  const q = rest.indexOf("?");
  const path = (q < 0 ? rest : rest.slice(0, q)).split("/").filter(Boolean);
  const query = queryOf(q < 0 ? "" : rest.slice(q + 1));
  const id = (name: string) => {
    const value = query.get(name);
    return value && ID.test(value) ? value : undefined;
  };
  const [head, second] = path;

  // `design/<id>` is a canvas link as written before canvases had their name: kept for good.
  if ((head === "canvas" || head === "design") && path.length === 2 && ID.test(second!)) {
    const seq = Number(query.get("message"));
    const link: AppLink = { kind: "canvas", canvasId: second! };
    const pageId = id("page");
    const artboardId = id("artboard");
    const open = oneOf(OPENS, query.get("open"));
    const questionId = id("question");
    const commentThreadId = id("comment");
    const notificationId = id("n");
    if (pageId) link.pageId = pageId;
    if (artboardId) link.artboardId = artboardId;
    if (open) link.open = open;
    if (questionId) link.questionId = questionId;
    if (commentThreadId) link.commentThreadId = commentThreadId;
    if (Number.isSafeInteger(seq) && seq > 0) link.messageSeq = seq;
    if (notificationId) link.notificationId = notificationId;
    return link;
  }
  if (head === "github" && second === "setup" && path.length === 2) {
    const result = query.get("result");
    if (!result || !SETUP_RESULTS.includes(result)) return null;
    const workspaceId = result === "installed" ? id("workspace") : undefined;
    return { kind: "github_setup", result, ...(workspaceId ? { workspaceId } : {}) };
  }
  if (head === "auth" && second === "callback" && path.length === 2) {
    const code = query.get("code");
    const state = query.get("state");
    return code && state ? { kind: "auth_callback", code, state } : null;
  }
  if (head === "billing" && second === "card" && path.length === 2) {
    const setupId = id("setup");
    const result = oneOf(["added", "cancelled"] as const, query.get("result"));
    return setupId && result ? { kind: "card_setup", setupId, result } : null;
  }
  if (head === "settings" && path.length === 1) {
    const section = oneOf(SECTIONS, query.get("section"));
    return { kind: "settings", ...(section ? { section } : {}) };
  }
  return null;
}
