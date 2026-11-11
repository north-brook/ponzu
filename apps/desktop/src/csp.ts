/*
 * The studio's content security policy. The canvas draws agent-authored HTML in the app's own
 * document (each board in a shadow root, sanitized on its way into the database), so this is the
 * wall behind the sanitizer: no script but the studio's own, no frames, no plugins, no forms,
 * and nothing loaded or reached outside the places Ponzu's UI and a design's files come from.
 */

/** Where a design's files are served (docs/cloud.md, "Assets and previews"), every environment's. */
const ASSETS = "https://*.ponzu.cloud";
/** Neon Realtime, which live queries subscribe to: one host per database branch. */
const REALTIME = ["https://*.neon.tech", "wss://*.neon.tech"];
/** Where an upload's signed PUT goes: Cloudflare R2's S3 endpoint. */
const UPLOADS = "https://*.r2.cloudflarestorage.com";
/** People's pictures, from GitHub. */
const AVATARS = "https://avatars.githubusercontent.com";
/** The UI's web fonts and the Google Fonts designs name. */
const FONT_CSS = "https://fonts.googleapis.com";
const FONT_FILES = "https://fonts.gstatic.com";

export function contentSecurityPolicy(apiUrl: string): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'none'"],
    "script-src": ["'self'"],
    // Boards carry their own <style> and style attributes, and the canvas positions with both.
    "style-src": ["'self'", "'unsafe-inline'", FONT_CSS],
    "font-src": ["'self'", "data:", FONT_FILES, ASSETS],
    "img-src": ["'self'", "data:", "blob:", ASSETS, AVATARS],
    "media-src": ["'self'", "blob:", ASSETS],
    "connect-src": ["'self'", new URL(apiUrl).origin, ...REALTIME, ASSETS, UPLOADS],
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
