import { cors as honoCors } from "hono/cors";
import { DISTINCT_ID_HEADER, SESSION_HEADER } from "../analytics/middleware.ts";
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

export const cors = honoCors({
  origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowHeaders: [
    "authorization",
    "content-type",
    CLIENT_HEADER,
    REQUEST_ID_HEADER,
    // posthog-js's `tracing_headers`: the app's session, which links a recording to what it did.
    SESSION_HEADER,
    DISTINCT_ID_HEADER,
  ],
  exposeHeaders: [REQUEST_ID_HEADER],
  maxAge: 600,
});
