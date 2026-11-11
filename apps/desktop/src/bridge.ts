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
 *   ponzu://design/<design id>?page=<page id>&artboard=<artboard id>
 *   ponzu://github/setup?result=installed&workspace=<workspace id>
 *   ponzu://github/setup?result=requested | pending | sign_in | failed
 */
export type DeepLink =
  | { kind: "design"; designId: string; pageId?: string; artboardId?: string }
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
  /** The person started another, or closed the window: nothing to say. */
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "failed"; message: string };

/**
 * Where the session's tokens live. `memory`: this computer's keychain could not be used, so the
 * session lasts until Ponzu quits, and the studio says so. Never written down unencrypted.
 */
export type SessionPersistence = "keychain" | "memory";

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
export type MenuCommand = "new-design" | "settings";

export interface PonzuDesktop {
  platform: string;
  version: string;
  /**
   * Where the API is, what this app calls itself to it (`X-Ponzu-Client: macos/2.0.0`, the same
   * as the main process says), and whether this is a development build.
   */
  config: { apiUrl: string; client: string; dev: boolean };
  session: {
    state(): Promise<SessionState>;
    onState(listener: (state: SessionState) => void): () => void;
    persistence(): Promise<SessionPersistence>;
    /** An access token good for a minute more; `rejected` is one the API just turned down. */
    accessToken(rejected?: string): Promise<BorrowedToken>;
    /** An error the API answered the studio with, for the session to take in. */
    report(error: BridgeError): void;
    /** Sign in with GitHub in the system browser. Resolves once it has finished or failed. */
    signIn(): Promise<SignInResult>;
    cancelSignIn(): void;
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
}

/** The IPC channels, by what they carry. `invoke` ones answer; `send` ones don't. */
export const CHANNELS = {
  sessionState: "ponzu:session:state",
  sessionChanged: "ponzu:session:changed",
  sessionPersistence: "ponzu:session:persistence",
  accessToken: "ponzu:session:token",
  report: "ponzu:session:report",
  signIn: "ponzu:session:sign-in",
  cancelSignIn: "ponzu:session:cancel-sign-in",
  signOut: "ponzu:session:sign-out",
  links: "ponzu:links",
  link: "ponzu:link",
  command: "ponzu:command",
  updateState: "ponzu:update:state",
  updateChanged: "ponzu:update:changed",
  updateCheck: "ponzu:update:check",
  updateInstall: "ponzu:update:install",
  openExternal: "ponzu:open-external",
} as const;
