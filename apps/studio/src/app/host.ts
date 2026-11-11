import type { Api, KeyValueStorage, Live, Session } from "@ponzu/client";
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
  onLink(listener: (link: DeepLink) => void): () => void;
  onCommand(listener: (command: MenuCommand) => void): () => void;
  /** The shell's updater; null where there is none to restart into. */
  update: PonzuDesktop["update"] | null;
  /** Open an https link in the system browser. */
  openExternal(url: string): void;
  /** Where the last designs opened are kept for showing offline, while someone is signed in. */
  docStorage: KeyValueStorage | null;
}
