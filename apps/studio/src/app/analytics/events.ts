import type { SignInFailure } from "@ponzu/desktop/bridge";

/*
 * Every event the app captures, by name, with its properties: the app's half of the catalogue in
 * docs/analytics.md ("App events"). A fact is captured once, by the side that knows it for
 * certain: what happens on the server (a canvas created, a turn finished, a pull request merged)
 * is the API's, and what only the app knows (what is on screen, what was pressed) is here.
 *
 * Names are lowercase "object verb", past tense; properties are snake_case. Nothing here holds
 * what someone typed, a canvas's or repo's name, or a path: a canvas is its `canvas_id`.
 */

/** A first-run step (onboarding 3.2), as `setupStep` names it. */
export type SetupStepName = "where" | "claude" | "iphone";

/** A pane of the window that opens and closes. */
export type PaneName = "sidebar" | "thread" | "pull_request";

/** How a canvas came to be opened. */
export type OpenedVia = "sidebar" | "search" | "link" | "created" | "restored";

/** The group of search's results a result is in (`ResultGroup` in @ponzu/client/model/search). */
export type SearchResultGroup =
  | "canvases"
  | "boards"
  | "comments"
  | "messages"
  | "pullRequests"
  | "people";

/** A calm state the window says something in, by what it is, never by its words. */
export type NoticeName =
  | "cant_reach_ponzu"
  | "no_longer_in_workspace"
  | "workspace_suspended"
  | "canvas_unavailable"
  | "keychain_unavailable"
  | "session_file"
  | "install_requested"
  | "install_failed"
  | "canvas_not_made"
  | "first_message_not_sent"
  | "maintenance";

export interface AppEvents {
  /** The window's studio started. Once a launch: a reload after a crash isn't another. */
  "app opened": { first_launch: boolean };
  /** This launch is the first since an update installed. */
  "update installed": { from_version: string; to_version: string };
  /** An update downloaded and the title bar offers it. */
  "update available": { version: string };
  /** The person pressed Restart for it. */
  "update restart clicked": { version: string };

  "sign in started": Record<string, never>;
  "sign in completed": Record<string, never>;
  "sign in cancelled": Record<string, never>;
  "sign in failed": { reason: SignInFailure };

  "setup step reached": { step: SetupStepName };
  "setup step completed": { step: SetupStepName };

  /** An idea on the create page was picked into the composer. */
  "idea chosen": { position: number };
  /**
   * The create page sent its prompt: an idea as given, an idea the person changed, or their own
   * words. Its length is never sent, nor its text.
   */
  "create prompt sent": {
    source: "idea" | "idea_edited" | "typed";
    project: "repo" | "scratch";
    images: number;
  };

  "canvas opened": { canvas_id: string; via: OpenedVia };
  /**
   * A search result was opened, by its group and its place in the list (from 0). Never the
   * words searched for, nor what the result says.
   */
  "search result opened": { kind: SearchResultGroup; position: number };
  "page switched": { canvas_id: string };
  "pane toggled": { pane: PaneName; open: boolean; canvas_id?: string };
  "comment mode entered": { canvas_id: string };
  /** A ⌘ shortcut of the window's, by its key: `mod+k`. */
  "hotkey used": { hotkey: string };
  "settings section viewed": { section: string };
  "notice shown": { notice: NoticeName };

  /**
   * A banner the Mac showed from the person's inbox (the phone shows its own, so only the Mac's
   * are counted here), by the notification's kind: never its words.
   */
  "notification shown": { kind: string; surface: "mac" };
  /** A banner clicked, and how long after the notification was made. */
  "notification opened": { kind: string; surface: "mac"; age_ms?: number };
}

export type AppEventName = keyof AppEvents;

/**
 * Each place the window can be, as the stable, synthetic URL its `$pageview` carries: never the
 * page's own location, which in a development build is a path on someone's computer.
 */
export type View =
  | { name: "sign-in" }
  | { name: "update" }
  | { name: "setup"; step: SetupStepName }
  | { name: "create" }
  | { name: "canvas"; canvasId: string; tab: "boards" | "pull-request" }
  | { name: "settings"; section: string }
  | { name: "no-access" };

export const VIEW_ORIGIN = "ponzu://app";

/** A view's URL and the properties its `$pageview` carries. */
export function viewUrl(view: View): {
  url: string;
  path: string;
  properties: Record<string, string>;
} {
  const path = (() => {
    switch (view.name) {
      case "setup":
        return `/setup/${view.step}`;
      case "canvas":
        return view.tab === "pull-request" ? "/canvas/pull-request" : "/canvas";
      case "settings":
        return `/settings/${view.section}`;
      default:
        return `/${view.name}`;
    }
  })();
  return {
    url: `${VIEW_ORIGIN}${path}`,
    path,
    properties: view.name === "canvas" ? { canvas_id: view.canvasId } : {},
  };
}
