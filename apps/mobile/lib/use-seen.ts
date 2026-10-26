import { useIsFocused } from "expo-router";
import { useAppActive } from "./app-active";

/**
 * Whether anyone can see a loop in a route: the app in front, and this screen the one on top.
 * Designs under a design's canvas kept its cards' traces and shimmers running, a frame callback
 * each on the UI thread, for as long as the design was open.
 */
export function useSeen(): boolean {
  const active = useAppActive();
  const focused = useIsFocused();
  return active && focused;
}
