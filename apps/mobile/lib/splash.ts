import { hideAsync, preventAutoHideAsync, setOptions } from "expo-splash-screen";
import { useEffect } from "react";

/**
 * The native splash (yuzu alone) stays up until the first screen has drawn.
 * The launch screen draws the same yuzu and blooms the slice in on it, so
 * the splash leaves at once, without a fade.
 */
export function holdSplash() {
  preventAutoHideAsync();
  setOptions({ fade: false });
}

/** Hides the native splash once the screen that replaces it has drawn. */
export function useHideSplash() {
  useEffect(() => {
    hideAsync();
  }, []);
}
