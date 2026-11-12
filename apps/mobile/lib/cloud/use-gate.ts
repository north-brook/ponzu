import { useSessionState } from "@ponzu/client/react";
import { router, useSegments } from "expo-router";
import { useEffect } from "react";
import { backend } from "./backend";
import { gateMove } from "./gate";

/**
 * Keeps the app behind the right gate as the session changes: signing out (here or on another
 * device) goes to sign-in, a 426 to the update screen, a sign-in to the canvases. The launch
 * screen makes the first move itself (app/index.tsx).
 */
export function useGate() {
  const state = useSessionState(backend.session);
  const segments = useSegments() as string[];
  const move = gateMove(state, segments);
  useEffect(() => {
    if (!move) return;
    if (router.canDismiss()) router.dismissAll();
    router.replace(move);
  }, [move]);
}
