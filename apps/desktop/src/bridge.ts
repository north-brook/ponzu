/*
 * What the desktop shell and the studio say to each other: `window.ponzuDesktop`, which the
 * preload script exposes, and the IPC channels behind it. Types only, plus the channel names,
 * so the studio can import it (`@ponzu/desktop/bridge`) without pulling in Electron.
 */
import type { SessionState } from "@ponzu/client";

/** The studio's origin inside the app: a privileged scheme of our own (studio-protocol.ts). */
export const STUDIO_ORIGIN = "ponzu-studio://app";

/**
 * A `ponzu://` link the studio acts on (deep-links.ts has the grammar):
 *
 *   ponzu://canvas/<canvas id>?page=<page id>&artboard=<artboard id>
 *   ponzu://github/setup?result=installed&workspace=<workspace id>
 *   ponzu://github/setup?result=requested | pending | sign_in | failed
 */
export type DeepLink =
  | { kind: "canvas"; canvasId: string; pageId?: string; artboardId?: string }
  | { kind: "github_setup"; result: GithubSetupResult; workspaceId?: string };

export type GithubSetupResult = "installed" | "requested" | "pending" | "sign_in" | "failed";

/** An error as it crosses the bridge: an `ApiError`'s fields, which the studio rebuilds. */
export interface BridgeError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** An access token, or why there is none (signed out, offline, …). */
export type BorrowedToken = { token: string } | { error: BridgeError };

/** How a sign-in in the browser ended. */
export type SignInResult =
  | { ok: true }
  /**
   * Ended without its browser coming back: another attempt signed the person in, it ran out,
   * it was the oldest of too many, or Ponzu quit. Nothing to say.
   */
  | { ok: false; reason: "closed" }
  | { ok: false; reason: "failed"; message: string; code: SignInFailure };

/**
 * Why a sign-in failed, coarsely, for usage analytics: GitHub said no, the API refused the
 * exchange, it couldn't be reached, or anything else.
 */
export type SignInFailure = "access_denied" | "refused" | "network" | "other";

/**
 * The studio's usage analytics, when this build reports and the person hasn't said no
 * (docs/analytics.md): the PostHog project, what replay may show, and what only the shell knows
 * about this launch.
 */
export interface AnalyticsSetup {
  key: string;
  host: string;
  replay: "full" | "private";
  /** `Ponzu`, `Ponzu Dev` or `Ponzu Local`. */
  channel: string;
  /** The operating system's version (the user agent's is frozen). */
  osVersion: string;
  /**
   * What this launch follows, for `app opened` and `update installed`; only in the launch's
   * first window. A window opened again later (the Mac's dock icon after its window closed) has
   * null: the launch was reported already.
   */
  launch: { first: boolean; updatedFrom: string | null } | null;
}

/**
 * Where the session's tokens live. `memory`: this computer's keychain could not be used, so the
 * session lasts until Ponzu quits. `file`: a developer's saved session, unencrypted, which only
 * a development or test build takes. The studio says so for either.
 */
export type SessionPersistence = "keychain" | "memory" | "file";

/** The updater as the title bar's update mark shows it. */
export interface UpdateState {
  /** This build's version. */
  version: string;
  /** False for a build that cannot update itself: development, an unpacked folder. */
  canUpdate: boolean;
  /** Downloaded and waiting for a restart, with what's new since this version. */
  ready: { version: string; notes: string[] } | null;
  /** The person asked to restart into it; it restarts once it is downloaded. */
  installing: boolean;
}

/** A menu item the studio carries out. */
export type MenuCommand = "new-canvas" | "settings" | "toggle-sidebar" | "toggle-thread";

export interface PonzuDesktop {
  platform: string;
  /**
   * Whether the window's ground is the Mac's own material (shell-ground.ts): the studio then
   * paints its shell as a tint over it rather than as a solid colour.
   */
  glass: boolean;
  version: string;
  /**
   * Where the API is, what this app calls itself to it (`X-Ponzu-Client: macos/2.0.0`, the same
   * as the main process says), whether this is a development build, and the scheme of the links
   * this app takes (`ponzu`, `ponzu-dev`; empty for Ponzu Local, which takes none), which the
   * API's pages link back to.
   */
  config: {
    apiUrl: string;
    client: string;
    dev: boolean;
    linkScheme: string;
    /** Null when nothing is to be reported: then the studio loads none of PostHog. */
    analytics: AnalyticsSetup | null;
  };
  session: {
    state(): Promise<SessionState>;
    onState(listener: (state: SessionState) => void): () => void;
    persistence(): Promise<SessionPersistence>;
    /** An access token good for a minute more; `rejected` is one the API just turned down. */
    accessToken(rejected?: string): Promise<BorrowedToken>;
    /** An error the API answered the studio with, for the session to take in. */
    report(error: BridgeError): void;
    /**
     * Sign in with GitHub in the system browser, beside any attempt still waiting (each stays
     * able to finish for ten minutes, whatever the window does). Resolves once it has ended.
     */
    signIn(): Promise<SignInResult>;
    signOut(): Promise<void>;
  };
  /** Each link once, those that arrived before the studio listened included. */
  onLink(listener: (link: DeepLink) => void): () => void;
  onCommand(listener: (command: MenuCommand) => void): () => void;
  update: {
    state(): Promise<UpdateState>;
    onState(listener: (state: UpdateState) => void): () => void;
    /** Look for an update now: the update screen asks when the API calls this build too old. */
    check(): void;
    /** Restart into the downloaded update, fetching it first if it isn't here yet. */
    install(): void;
  };
  /** Open an https link in the system browser. Anything else is ignored. */
  openExternal(url: string): void;
  /**
   * Bring Ponzu in front of the browser: what the studio does once an install it started on
   * GitHub has come back, as the session does once a sign-in's tab has.
   */
  comeForward(): void;
}

/** The IPC channels, by what they carry. `invoke` ones answer; `send` ones don't. */
export const CHANNELS = {
  sessionState: "ponzu:session:state",
  sessionChanged: "ponzu:session:changed",
  sessionPersistence: "ponzu:session:persistence",
  accessToken: "ponzu:session:token",
  report: "ponzu:session:report",
  signIn: "ponzu:session:sign-in",
  signOut: "ponzu:session:sign-out",
  links: "ponzu:links",
  linksStop: "ponzu:links:stop",
  link: "ponzu:link",
  command: "ponzu:command",
  updateState: "ponzu:update:state",
  updateChanged: "ponzu:update:changed",
  updateCheck: "ponzu:update:check",
  updateInstall: "ponzu:update:install",
  openExternal: "ponzu:open-external",
  comeForward: "ponzu:come-forward",
} as const;
