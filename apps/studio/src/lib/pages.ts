/**
 * The page each design was last on, so opening it again, or coming back to its tab, shows that
 * page rather than the first. By tab (a design's key, with its Mac's base for another Mac's), in
 * this Mac's localStorage. A page since deleted just falls back to the first.
 */
export type Pages = Record<string, string>;

const KEY = "ponzu.pages";

/** What's saved, keeping only page ids: anything else in storage counts as nothing saved. */
export function loadPages(): Pages {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(
    Object.entries(saved).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

/**
 * Kept with what another window saved since. Storage that's full or unavailable only forgets
 * the page, so it never stops the app.
 */
export function savePage(tab: string, page: string) {
  const saved = loadPages();
  if (saved[tab] === page) return;
  saved[tab] = page;
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {}
}
