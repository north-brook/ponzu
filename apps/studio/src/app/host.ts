import type { Api, ApiError, KeyValueStorage, Live, Session } from "@ponzu/client";
import type {
  DeepLink,
  MenuCommand,
  PonzuDesktop,
  SessionPersistence,
  SignInResult,
} from "@ponzu/desktop/bridge";
import type { Lights } from "../cloud/window/chrome.tsx";

declare global {
  interface Window {
    /** Set by the desktop app's preload script (apps/desktop/src/bridge.ts). */
    ponzuDesktop?: PonzuDesktop;
  }
}

/*
 * What the app runs on: the session, the API and live queries, and what the place it runs in
 * offers around them. In the Mac app that is the desktop shell (desktop-host.ts); in a plain
 * browser, for development and tests, Ponzu Cloud in memory (fake-host.ts).
 */
export interface Host {
  session: Session;
  api: Api;
  live: Live;
  /**
   * The Mac draws its own traffic lights in the chrome; a browser gets painted ones; Windows
   * and Linux keep their own title bar, with nothing on the chrome's left.
   */
  lights: Lights;
  /**
   * Sign in with GitHub, beside any attempt still waiting in the browser; resolves once this
   * one has ended. Nothing cancels one: it finishes, fails, or the shell closes it.
   */
  signIn(): Promise<SignInResult>;
  persistence(): Promise<SessionPersistence>;
  /**
   * The app's links, and the outcome of each GitHub install it started (`installGithub`) as a
   * `github_setup` link, once each, whether the setup page's link brought it or the API did.
   */
  onLink(listener: (link: DeepLink) => void): () => void;
  /**
   * Open GitHub's install page, suggesting `githubAccountId`. When it comes back, the app comes
   * forward and its outcome reaches `onLink`, link or no link (installs.ts). Rejects when the
   * page couldn't be had.
   */
  installGithub(body: { githubAccountId?: number }): Promise<void>;
  onCommand(listener: (command: MenuCommand) => void): () => void;
  /** The shell's updater; null where there is none to restart into. */
  update: PonzuDesktop["update"] | null;
  /** Open an https link in the system browser. */
  openExternal(url: string): void;
  /** Where the last canvases opened are kept for showing offline, while someone is signed in. */
  docStorage: KeyValueStorage | null;
  /**
   * The Mac's own banners and dock badge, and this install as the API knows it
   * (app/notifications.ts); null where there are none (a browser, an older shell).
   */
  notifications: HostNotifications | null;
  /**
   * Hear each error the API answers any request of the window's with, whoever sent it (a
   * mutation, the thread, a canvas's sync), such as the maintenance switch's 503. Returns the
   * unsubscribe. Left out where the host doesn't tell.
   */
  onApiError?(listener: (error: ApiError) => void): () => void;
  /**
   * Whether to show the welcome from Ponzu 1.x now: the shell's answer, true once ever. Absent
   * where there is no shell (a browser, the tests), which never shows it.
   */
  welcome1x?(): Promise<boolean>;
  /**
   * Share usage data, on this computer: the shell writes what its next launch reads, and stops
   * its own reporting when it is turned off. Answers whether its next launch will report.
   * Absent where there is no shell.
   */
  setUsageSharing?(enabled: boolean): Promise<boolean>;
}

/** The shell's notifications, with the app's version for registering this install. */
export type HostNotifications = PonzuDesktop["notifications"] & { appVersion: string | null };
