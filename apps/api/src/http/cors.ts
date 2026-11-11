import { cors as honoCors } from "hono/cors";
import { CLIENT_HEADER } from "./client-version.ts";
import { REQUEST_ID_HEADER } from "./request.ts";

/** The origin of the studio inside the desktop app, which the shell serves from its own scheme. */
export const DESKTOP_ORIGIN = "ponzu-studio://app";

/**
 * Which browser origins may read the API's answers.
 *
 * The API authenticates with a bearer token and never with a cookie, and it does not allow
 * credentialed requests, so CORS is not what keeps one person's data from another: a page can
 * only send a token it already holds. The list is kept short anyway, to the places Ponzu's own
 * UI runs:
 *
 * - the desktop app's studio (`DESKTOP_ORIGIN`);
 * - `https://ponzu.design` and its subdomains, for a browser app later. Designs' own content
 *   is served from ponzu.cloud, which is deliberately not here;
 * - `http://localhost` and `http://127.0.0.1` on any port, for the studio's dev server.
 *
 * Requests with no `Origin` (the desktop's main process, the phone, the runner, curl) are not
 * CORS requests and are untouched.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === DESKTOP_ORIGIN) return true;
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  // An origin has no path, query or credentials; anything else is not one a browser sent.
  if (url.origin !== origin) return false;
  if (url.protocol === "https:") {
    return url.hostname === "ponzu.design" || url.hostname.endsWith(".ponzu.design");
  }
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/**
 * What PostHog's browser SDK adds to the app's requests (`tracing_headers`), so the API can tie
 * what it captures to the person's recording (docs/analytics.md). The session id is the only one
 * read; the distinct id is never taken for who someone is, which only their token says.
 */
export const POSTHOG_TRACING_HEADERS = [
  "x-posthog-session-id",
  "x-posthog-window-id",
  "x-posthog-distinct-id",
];

export const cors = honoCors({
  origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowHeaders: [
    "authorization",
    "content-type",
    CLIENT_HEADER,
    REQUEST_ID_HEADER,
    ...POSTHOG_TRACING_HEADERS,
  ],
  exposeHeaders: [REQUEST_ID_HEADER],
  maxAge: 600,
});
