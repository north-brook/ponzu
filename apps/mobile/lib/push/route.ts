import type { SessionState } from "@ponzu/client";
import type { PhoneSetupStep } from "@ponzu/client/model/setup";
import { areaOf } from "../cloud/gate";
import type { Tap } from "./payload";

/*
 * When and how a tap on a ping moves the app (iPhone design §12, "Taps"). A tap that opened the
 * app from cold is held until the person is signed in, through setup and off the launch screen,
 * so it never races the launch screen's own move or opens a canvas under the sign-in screen. A
 * tap while signed out is dropped: the ping was for whoever was signed in then.
 */

/** Whether a held tap can go now: signed in, setup done, on the signed-in app's screens. */
export function tapCanGo(
  state: SessionState,
  setup: PhoneSetupStep | null,
  segments: readonly string[],
): boolean {
  return state.status === "signed_in" && setup === "done" && areaOf(segments) === "/canvases";
}

/** Whether a held tap will never go: nobody is signed in to see it. */
export function tapIsStale(state: SessionState): boolean {
  return state.status === "signed_out" || state.status === "github_reauth";
}

export type TapMove =
  | { kind: "params"; params: Record<string, string | undefined> }
  | { kind: "push"; path: string }
  | { kind: "canvases" };

/**
 * How the tap moves the app: the canvas on screen takes the ping's params in place (its chat or
 * pull request opens over it); a ping naming nothing this app opens goes back to the canvases;
 * anything else is pushed over where the app is.
 */
export function tapMove(tap: Tap, onScreen: string | null): TapMove {
  if (!tap.route) return { kind: "canvases" };
  if (tap.route.screen === "canvas" && tap.canvasId === onScreen) {
    const p = tap.route.params;
    // Every param named, so one from an earlier ping or link doesn't linger.
    return {
      kind: "params",
      params: {
        page: p.page,
        artboard: p.artboard,
        sheet: p.sheet,
        question: p.question,
        thread: p.thread,
        message: p.message,
        ping: p.ping,
      },
    };
  }
  return { kind: "push", path: tap.path };
}
