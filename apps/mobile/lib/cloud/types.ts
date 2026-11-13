import type { Api, Live, Session } from "@ponzu/client";

/**
 * What the app talks to Ponzu Cloud through: the real one (backend.ts) or the in-app fake
 * (backend.fake.ts), chosen when the bundle is built (PONZU_BACKEND=fake, metro.config.js).
 * Everything networked is here, on the React Native side; the canvas page never holds a token.
 */
export interface Backend {
  kind: "real" | "fake";
  /** One per app process. */
  session: Session;
  api: Api;
  /** A new `Live` for a signed-in person; the app closes it when they sign out. */
  makeLive(): Live;
  /** The page sign-in opens instead of WorkOS's (the fake's local page); null for WorkOS. */
  authorizeUrl: string | null;
  /** Ready to read the Keychain: an earlier install's session is gone. */
  prepare(): Promise<void>;
  /** This phone's install id, for `POST /v1/me/devices`. */
  installId(): Promise<string>;
  /** The fake only: put the app in a named state (app/dev.tsx). False for a name it lacks. */
  seed?(scenario: string): boolean;
  /** The fake only: put the next launch in a named state too (app/dev.tsx `relaunch=1`). */
  seedNextLaunch?(scenario: string): Promise<void>;
}
