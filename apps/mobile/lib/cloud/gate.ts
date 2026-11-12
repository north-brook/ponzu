import type { SessionState } from "@ponzu/client";
import type { PhoneSetupStep } from "@ponzu/client/model/setup";

/*
 * Where the app goes for each state of the session, and of setup (docs/mobile.md, "Launch and
 * the gates"). Signed in, the person is first taken through setup's steps (where they build,
 * then Claude: the Mac's gates, `phoneSetupStep`), and only then to the canvases. Setup is read
 * from `GET /v1/me`, so a step done on the Mac is passed over here.
 */

export type GateRoute = "/sign-in" | "/update" | "/setup/where" | "/setup/claude" | "/canvases";

/**
 * Null while the session is still reading the Keychain, or, signed in, while `me` (and so
 * where setup stands) is not known yet: the screen on show stays.
 */
export function gateRoute(state: SessionState, setup: PhoneSetupStep | null): GateRoute | null {
  switch (state.status) {
    case "loading":
      return null;
    case "signed_out":
    case "github_reauth":
      return "/sign-in";
    case "too_old":
      return "/update";
    case "signed_in":
      if (setup === null) return null;
      return setup === "where"
        ? "/setup/where"
        : setup === "claude"
          ? "/setup/claude"
          : "/canvases";
  }
}

/** The line the sign-in screen shows above its button for this state, if any. */
export function signInNotice(state: SessionState): string | null {
  return state.status === "github_reauth" ? "Sign in again so Ponzu can reach GitHub." : null;
}

/**
 * Which gate the screen at `segments` (Expo Router's) is behind: the sign-in, update and setup
 * screens their own (pasting claude.ai's code is part of Connect Claude), every other named
 * screen the signed-in app's. Null for the screens that move on by themselves (launch, the
 * auth callback, GitHub's setup link, dev, not found): the gate leaves them be.
 */
export function areaOf(segments: readonly string[]): GateRoute | null {
  const [head, next] = segments;
  if (head === undefined || head === "index") return null;
  if (head === "auth" || head === "github" || head === "dev" || head === "+not-found") return null;
  if (head === "sign-in") return "/sign-in";
  if (head === "update") return "/update";
  if (head === "setup") return next === "where" ? "/setup/where" : "/setup/claude";
  return "/canvases";
}

/** Where to send the app now, or null to leave it where it is. */
export function gateMove(
  state: SessionState,
  segments: readonly string[],
  setup: PhoneSetupStep | null,
): GateRoute | null {
  const target = gateRoute(state, setup);
  const area = areaOf(segments);
  return target && area && area !== target ? target : null;
}
