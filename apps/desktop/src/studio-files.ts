import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

/*
 * Serving the studio bundled in the app from `ponzu-studio://app`. One fixed origin, whatever
 * the build: the studio's storage, the API's CORS and the content security policy are all keyed
 * on it.
 */

export const STUDIO_SCHEME = "ponzu-studio";
const STUDIO_HOST = "app";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The file under `root` a studio URL names, and its type. A path with no extension is one of the
 * studio's own routes and gets its index.html; one that leaves `root`, names a file that isn't
 * there, or has a type the studio never ships, gets nothing.
 */
export function studioFile(root: string, url: string): { path: string; type: string } | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== `${STUDIO_SCHEME}:` || parsed.host !== STUDIO_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const base = resolve(root);
  const wanted = extname(pathname) ? resolve(base, `.${pathname}`) : resolve(base, "index.html");
  if (!wanted.startsWith(base + sep)) return null;
  const type = TYPES[extname(wanted).toLowerCase()];
  if (!type || !existsSync(wanted) || !statSync(wanted).isFile()) return null;
  return { path: wanted, type };
}
