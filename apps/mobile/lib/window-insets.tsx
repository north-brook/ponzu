import { createContext, type ReactNode, use } from "react";
import { type EdgeInsets, useSafeAreaInsets } from "react-native-safe-area-context";

const Context = createContext<EdgeInsets | null>(null);

/**
 * The window's safe area, read above the tabs. Each native tab gives its
 * pages a safe area of its own, which leaves out the system's bars at the
 * side: on iPhone Duo's outer display, and its inner one held sideways, the
 * status bar, the toolbar and the tabs are a rail at the trailing edge, and
 * a tab's pages would run under it. The window's, read here, takes it in,
 * and follows the window as it folds and turns.
 */
export function WindowInsetsProvider({ children }: { children: ReactNode }) {
  return <Context value={useSafeAreaInsets()}>{children}</Context>;
}

/** The window's safe area: the side rail on iPhone Duo, as well as the top and the foot. */
export function useWindowInsets(): EdgeInsets {
  const value = use(Context);
  if (!value) {
    throw new Error("useWindowInsets must be used inside WindowInsetsProvider");
  }
  return value;
}
