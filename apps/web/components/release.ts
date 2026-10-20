import { RELEASES } from "./links";

/** The updater feed electron-builder publishes with every release. Only published releases count. */
const FEED = `${RELEASES}/download/latest-mac.yml`;
const VERSION = /^version:[ \t]*['"]?(\d+\.\d+\.\d+)['"]?[ \t]*$/m;

/** The newest published version, or null before the first release or while GitHub is down. */
export async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(FEED, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return VERSION.exec(await res.text())?.[1] ?? null;
  } catch {
    return null;
  }
}
