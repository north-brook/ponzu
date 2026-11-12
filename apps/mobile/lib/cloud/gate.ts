import type { SessionState } from "@ponzu/client";

/*
 * Where the app goes for each state of the session (docs/mobile.md, "Launch and the gates").
 * Setup's own gates (where you design, Claude) come between signing in and the canvases; they
 * read the shared setup rules and arrive with the setup slice.
 */

export type GateRoute = "/sign-in" | "/update" | "/canvases";

/** Null while the session is still reading the Keychain: the launch screen stays. */
export function gateRoute(state: SessionState): GateRoute | null {
  switch (state.status) {
    case "loading":
      return null;
    case "signed_out":
    case "github_reauth":
      return "/sign-in";
    case "too_old":
      return "/update";
    case "signed_in":
      return "/canvases";
  }
}

/** The line the sign-in screen shows above its button for this state, if any. */
export function signInNotice(state: SessionState): string | null {
  return state.status === "github_reauth" ? "Sign in again so Ponzu can reach GitHub." : null;
}

/**
 * Which gate the screen at `segments` (Expo Router's) is behind: the sign-in and update screens
 * their own, every other named screen the signed-in app's. Null for the screens that move on by
 * themselves (launch, the auth callback, dev, not found): the gate leaves them be.
 */
export function areaOf(segments: readonly string[]): GateRoute | null {
  const [head] = segments;
  if (head === undefined || head === "index") return null;
  if (head === "auth" || head === "dev" || head === "+not-found") return null;
  if (head === "sign-in") return "/sign-in";
  if (head === "update") return "/update";
  return "/canvases";
}

/** Where to send the app now, or null to leave it where it is. */
export function gateMove(state: SessionState, segments: readonly string[]): GateRoute | null {
  const target = gateRoute(state);
  const area = areaOf(segments);
  return target && area && area !== target ? target : null;
}
