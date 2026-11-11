/*
 * The studio's content security policy. The canvas draws agent-authored HTML in the app's own
 * document (each board in a shadow root, sanitized on its way into the database), so this is the
 * wall behind the sanitizer: no script but the studio's own, no frames, no plugins, no forms,
 * and nothing reached but the API, Neon Realtime and the design's files.
 *
 * Images are the one thing loaded from anywhere on https: a design may show a photo from the
 * web, as the runner's previews of it do (docs/cloud.md, "Security"). An image runs no script;
 * what it costs is that the image's host learns the design was opened.
 */

/** Any environment's, for a development build that may point anywhere. */
const ANY_ASSETS = "https://*.ponzu.cloud";
const ANY_REALTIME = "https://*.neon.tech";
/** The UI's web fonts and the Google Fonts designs name. */
const FONT_CSS = "https://fonts.googleapis.com";
const FONT_FILES = "https://fonts.gstatic.com";

export function contentSecurityPolicy(where: {
  apiUrl: string;
  realtimeUrl: string | null;
  assetsUrl: string | null;
}): string {
  const assets = where.assetsUrl ? new URL(where.assetsUrl).origin : ANY_ASSETS;
  const realtime = where.realtimeUrl ? new URL(where.realtimeUrl).origin : ANY_REALTIME;
  const directives: Record<string, string[]> = {
    "default-src": ["'none'"],
    "script-src": ["'self'"],
    // Boards carry their own <style> and style attributes, and the canvas positions with both.
    "style-src": ["'self'", "'unsafe-inline'", FONT_CSS],
    "font-src": ["'self'", "data:", FONT_FILES, assets],
    // A design's pictures from the web, its own files and people's GitHub avatars among them.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "blob:", assets],
    // Realtime's socket is the same host over wss.
    "connect-src": [
      "'self'",
      new URL(where.apiUrl).origin,
      realtime,
      realtime.replace(/^https:/, "wss:"),
      assets,
    ],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "frame-src": ["'none'"],
    "child-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}
