/*
 * What the desktop shell and the studio say to each other: `window.ponzuDesktop`, which the
 * preload script exposes, and the IPC channels behind it. Types only, plus the channel names,
 * so the studio can import it (`@ponzu/desktop/bridge`) without pulling in Electron.
 */
import type { SessionState } from "@ponzu/client";
import type { AppLink } from "@ponzu/core/links";

export type { GithubSetupResult } from "@ponzu/core/links";

/** The studio's origin inside the app: a privileged scheme of our own (studio-protocol.ts). */
export const STUDIO_ORIGIN = "ponzu-studio://app";

/**
 * A `ponzu://` link the studio may act on, in the grammar every client shares
 * (@ponzu/core/links; deep-links.ts reads it):
 *
 *   ponzu://canvas/<canvas id>?page=&artboard=&open=&question=&comment=&message=&n=
 *   ponzu://github/setup?result=installed&workspace=<workspace id>
 *   ponzu://github/setup?result=requested | pending | sign_in | failed
 *   ponzu://billing/card?setup=<setup id>&result=added | cancelled
 *   ponzu://settings?section=usage | notifications | account&n=
 *   ponzu://agents/connect?request=<agent authorization id>
 *
 * `n` names the notification a link came from (a banner clicked), so opening it reads it.
 * A canvas's link from before canvases had their name (`design/<id>`) opens the same way. A
 * sign-in's way back is the iPhone's, never the Mac's, so it is not among them.
 */
export type DeepLink = Exclude<AppLink, { kind: "auth_callback" }>;

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
   * Where this build talks to (`dev`, `production`, or `custom` for Ponzu Local pointed
   * elsewhere) and the commit it was built from: every event's `environment` and `app_commit`.
   */
  environment: string;
  commit: string;
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

/**
 * A banner the studio asks the shell to show: a row of the person's inbox (`me.notifications`),
 * in Ponzu's own words (a canvas's or workspace's name and a fixed sentence), never anything a
 * person or the agent wrote. A click brings Ponzu forward and hands `link` back through
 * `onLink`, as a `ponzu://` link would.
 */
export interface MacNotice {
  /** The notification's id: showing the same id again replaces the banner. */
  id: string;
  /** What macOS groups it under: its canvas, or its workspace. */
  groupId: string;
  title: string;
  subtitle?: string;
  body: string;
  /** A canvas link, or Settings for a workspace's billing ping; it carries the notification's id. */
  link: DeepLink;
}

/**
 * A comment's picture to draw (apps/studio/src/app/comment-picture.tsx): the document as it was
 * when the comment was made, cut down to what the picture can show (`pictureDoc`), the comment,
 * and where the canvas's files are. Plain data, so it crosses to the picture window as it is.
 */
export interface PictureRequest {
  doc: unknown;
  threadId: string;
  messageId: string;
  assetBase?: string | undefined;
}

/**
 * A comment's picture as the picture window drew it: its two WebP files; `empty`, nothing round
 * the pin to show, so the comment rightly goes without one; or `failed`, with why.
 */
export type PictureAnswer =
  | { ok: true; light: Uint8Array; dark: Uint8Array }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "failed"; message: string };

/**
 * `window.ponzuPictureHost`: what the shell's hidden picture window (pictures.ts) hands the
 * studio it loads there, in place of `window.ponzuDesktop`. It hears a picture to draw at a time
 * and answers each by its number.
 */
export interface PictureHostBridge {
  /** Hears each picture to draw; then tells the shell the studio is listening. */
  onRequest(listener: (id: number, request: PictureRequest) => void): void;
  answer(id: number, answer: PictureAnswer): void;
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
    /**
     * A test build told to run the studio on Ponzu Cloud in memory (PONZU_FAKE_BACKEND): the
     * studio does so only when it was built with the fake in it. Absent in a release.
     */
    fake?: boolean;
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
  /**
   * The Mac's own notifications (docs/cloud.md, "Notifications"): banners from the running app's
   * inbox and the dock's badge. Nothing is pushed to a Mac; the studio shows what it hears live.
   */
  notifications: {
    /** Whether this system shows notifications at all. */
    supported: boolean;
    /**
     * This install's own random id, made once and kept in the app's data folder: what the API
     * knows this Mac by (`POST /v1/me/devices`). Ponzu, Ponzu Dev and Ponzu Local each have
     * their own.
     */
    installId: string;
    /** The computer's name, as Settings lists it ("Maya's MacBook Pro"); null when it has none. */
    deviceName: string | null;
    show(notice: MacNotice): void;
    /** Take these banners away, from the screen and Notification Center. */
    remove(ids: string[]): void;
    /** The dock's number: open needs-you questions. 0 clears it. */
    setBadge(count: number): void;
    /** A banner the system wouldn't show (an unsigned build's are refused), by its id. */
    onFailed(listener: (id: string) => void): () => void;
  };
  /**
   * Whether to show the welcome from Ponzu 1.x now (legacy.ts's `takeWelcome1x`): true once, on
   * a computer that had 1.x, and false from then on, this launch and every later one.
   */
  welcome1x(): Promise<boolean>;
  /**
   * Settings › Account › Share usage data, on this computer: writes ~/.ponzu/telemetry.json,
   * which the shell reads at launch. Off also stops the main process's error reporting at once.
   * On takes effect at the next launch: nothing of PostHog was loaded this time. Answers, once
   * the file is written, whether the next launch will report (false when this build has no
   * project, or the environment says no). Absent from an older shell.
   */
  setUsageSharing?(enabled: boolean): Promise<boolean>;
  /**
   * Comments' pictures, drawn in a hidden window of the shell's own (pictures.ts), in its own
   * renderer, so drawing one never holds up this window or leaves anything in it. Absent from an
   * older shell: the studio then draws them itself.
   */
  pictures?: { draw(request: PictureRequest): Promise<PictureAnswer> };
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
  notifyShow: "ponzu:notify:show",
  notifyRemove: "ponzu:notify:remove",
  notifyBadge: "ponzu:notify:badge",
  notifyFailed: "ponzu:notify:failed",
  welcome1x: "ponzu:welcome-1x",
  usageSharing: "ponzu:usage-sharing",
  picturesDraw: "ponzu:pictures:draw",
  /** To and from the hidden picture window only. */
  pictureHostReady: "ponzu:picture-host:ready",
  pictureHostRequest: "ponzu:picture-host:request",
  pictureHostAnswer: "ponzu:picture-host:answer",
} as const;
