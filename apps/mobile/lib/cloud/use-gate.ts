import { useSessionState } from "@ponzu/client/react";
import { router, useSegments } from "expo-router";
import { useEffect } from "react";
import { backend } from "./backend";
import { gateMove, gateStep } from "./gate";
import { useSetupStep } from "./use-setup";

/**
 * Keeps the app behind the right gate as the session and setup change: signing out (here or on
 * another device) goes to sign-in, a 426 to the update screen, a sign-in to setup or the
 * canvases, and each setup step done (here, or on the Mac, which the live `me` row says) to the
 * next. The launch screen makes the first move itself (app/index.tsx).
 */
export function useGate() {
  const state = useSessionState(backend.session);
  // With no `me` to be had, as on launch: signed in on the sign-in screen, the app goes on to
  // the canvases rather than keep the button turning for good.
  const step = gateStep(useSetupStep());
  const segments = useSegments() as string[];
  const move = gateMove(state, segments, step);
  useEffect(() => {
    if (!move) return;
    if (router.canDismiss()) router.dismissAll();
    router.replace(move);
  }, [move]);
}
