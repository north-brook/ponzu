/*
 * Where the window may go. It shows the studio and nothing else: a navigation anywhere else is
 * stopped, and a link meant for the browser goes there only once it checks out. Designs are
 * written by agents and anyone can comment, so nothing in the window gets to choose otherwise.
 */

/** `scheme://host` of a URL, also for schemes Node's URL doesn't count as special. */
export function originOf(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

/** Whether `url` is the studio: its own scheme, or Vite's dev server in a development build. */
export function isStudio(url: string | undefined, origins: readonly string[]): boolean {
  const origin = url ? originOf(url) : null;
  return origin !== null && origins.includes(origin);
}

/**
 * The link to open in the system browser, or null. Only https, to a named host, with no
 * credentials in it: never a file, a custom scheme (which could start another app), or http.
 */
export function externalLink(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.href;
}
