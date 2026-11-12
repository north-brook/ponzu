/*
 * The studio's content security policy. The canvas draws agent-authored HTML in the app's own
 * document (each board in a shadow root, sanitized on its way into the database), so this is the
 * wall behind the sanitizer: no script but the studio's own, no frames, no plugins, no forms,
 * and nothing reached but the API, Neon Realtime, the design's files and, in a build that
 * reports usage, PostHog's ingestion.
 *
 * Images are the one thing loaded from anywhere on https: a design may show a photo from the
 * web, as the runner's previews of it do (docs/cloud.md, "Security"). An image runs no script;
 * what it costs is that the image's host learns the design was opened.
 */

/** Any environment's, for a development build that may point anywhere. */
const ANY_ASSETS = "https://*.ponzu.cloud";
const ANY_REALTIME = "https://*.neon.tech";
/**
 * The Google Fonts canvases name, which the canvas loads to draw a board as its author meant. The
 * studio's own fonts ship with it and come from 'self'.
 */
const FONT_CSS = "https://fonts.googleapis.com";
const FONT_FILES = "https://fonts.gstatic.com";

/**
 * Where PostHog's browser SDK sends to, for a build that reports (docs/analytics.md): the
 * ingestion host, and for PostHog's own cloud the `-assets` host beside it, which answers the
 * project's remote config (whether to record, capture exceptions and the rest). Nothing is a
 * script source: the studio bundles every part of the SDK it uses, and the SDK it bundles never
 * loads one. Session replay's compression worker runs from a blob, which `worker-src` has.
 */
export function posthogOrigins(host: string): string[] {
  const origin = new URL(host).origin;
  const cloud = /^https:\/\/(us|eu)\.i\.posthog\.com$/.exec(origin);
  return cloud ? [origin, `https://${cloud[1]}-assets.i.posthog.com`] : [origin];
}

export function contentSecurityPolicy(where: {
  apiUrl: string;
  realtimeUrl: string | null;
  assetsUrl: string | null;
  /** Null when this build, or this person, doesn't report: then PostHog is reached by nothing. */
  posthog: { host: string } | null;
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
    // Realtime's socket is the same host over wss. The Google Fonts a board uses are read as
    // well, to go into the picture of where a comment was left (comment-picture.tsx).
    "connect-src": [
      "'self'",
      new URL(where.apiUrl).origin,
      realtime,
      realtime.replace(/^https:/, "wss:"),
      assets,
      FONT_CSS,
      FONT_FILES,
      ...(where.posthog ? posthogOrigins(where.posthog.host) : []),
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
