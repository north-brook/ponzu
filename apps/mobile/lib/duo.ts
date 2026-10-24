import { useHinge } from "expo-hinge";
import { useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type DuoLayout, duoLayout, hasRail } from "./duo-layout";

/**
 * How long the hinge must hold still, partly open, before the layout splits
 * at the fold: opening or closing the phone sweeps through partly open
 * (about 0.7s on the simulator's 0.9s sweep), and the comments half
 * shouldn't flash on the way. Flat again, it goes at once.
 */
const SETTLE_MS = 600;
/** Degrees the hinge may drift and still be holding still. */
const STILL_DEG = 4;

/**
 * The canvas's layout for the window it has now and the hinge (`duoLayout`),
 * as augmenter's `useBoardLayout`. Without expo-hinge's native module (a
 * build from before it, or an iPhone) the hinge is never partly open.
 */
export function useDuoLayout(): DuoLayout & { width: number; height: number } {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const hinge = useHinge();
  const partly = hinge?.status === "partiallyOpen";
  const [folded, setFolded] = useState(partly);
  // The angle, rounded to the drift it may have, so a hinge still moving keeps restarting the wait.
  const resting = partly ? Math.round((hinge?.angle ?? 0) / STILL_DEG) : -1;
  useEffect(() => {
    if (!partly) return setFolded(false);
    const t = setTimeout(() => setFolded(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, [partly, resting]);
  return {
    ...duoLayout(window, hasRail(insets), folded && partly),
    width: window.width,
    height: window.height,
  };
}
