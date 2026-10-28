import { useSyncExternalStore } from "react";

const DARK = "(prefers-color-scheme: dark)";

/** The system's color scheme, live, as the site follows it. Light on the server. */
export function useSystemTheme(): "light" | "dark" {
  const dark = useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(DARK);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => matchMedia(DARK).matches,
    () => false,
  );
  return dark ? "dark" : "light";
}
