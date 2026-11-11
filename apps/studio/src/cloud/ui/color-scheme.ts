import { useSyncExternalStore } from "react";

/*
 * The scheme the app is drawn in: the system's, unless <html data-theme> pins one. CSS reads it
 * through light-dark(); this is for what CSS can't choose, like which preview picture to show.
 */
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function current(): "light" | "dark" {
  const pinned = document.documentElement.dataset.theme;
  if (pinned === "light" || pinned === "dark") return pinned;
  return media().matches ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const query = media();
  query.addEventListener("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    query.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

export function useColorScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, current, () => "light");
}
