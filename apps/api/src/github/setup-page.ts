import type { SetupPage } from "./install.ts";
import { DEFAULT_LINK_SCHEME, type LinkScheme, linkSchemeOf } from "./link-scheme.ts";

/*
 * The page a browser lands on after GitHub's install page. It is the API's one HTML answer: no
 * script, no request of its own, nothing from the query string, and it can be framed by
 * nobody. It says what happened and offers the way back to the app.
 *
 * The way back is a deep link (docs/cloud.md, "Identity and access"):
 *
 *   ponzu://github/setup?result=installed&workspace=<workspace id>
 *   ponzu://github/setup?result=requested | pending | sign_in | failed
 *
 * The app answers any of them by fetching its accounts again (`POST /v1/github/sync`); on the
 * iPhone, opening it also closes the sheet the install page was shown in. Ponzu Preview and a
 * development build get the same links in their own schemes (`ponzu-preview://`, `ponzu-dev://`),
 * as the install's state recorded them (link-scheme.ts).
 */

/** Everything the page may load or do: its own inline style, and nothing else. */
export const SETUP_PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  // The address it was opened at carries the install's state.
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export type { SetupPage };

/** The page, linking back to the app with `scheme`; one not on the list is Ponzu's. */
export function renderSetupPage(page: SetupPage, scheme: LinkScheme = DEFAULT_LINK_SCHEME): string {
  const { title, body } = copy(page);
  const link = new URL(`${linkSchemeOf(scheme)}://github/setup`);
  link.searchParams.set("result", page.kind);
  if (page.kind === "installed") link.searchParams.set("workspace", page.workspace.id);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Ponzu</title>
<style>
:root { color-scheme: light dark; --bg: #faf9f6; --ink: #1d1c1a; --muted: #6b6860; --button: #1d1c1a; --on-button: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --ink: #f2f0ea; --muted: #a29e94; --button: #f2f0ea; --on-button: #161513; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 360px; padding: 32px 24px; text-align: center; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
p { margin: 0 0 24px; color: var(--muted); }
a { display: inline-block; padding: 10px 18px; border-radius: 10px; background: var(--button); color: var(--on-button); font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(body)}</p>
<a href="${escapeHtml(link.toString())}">Open Ponzu</a>
</main>
</body>
</html>
`;
}

function copy(page: SetupPage): { title: string; body: string } {
  switch (page.kind) {
    case "installed":
      return {
        title: `Ponzu is set up on ${page.workspace.name}`,
        body: "Go back to Ponzu to carry on.",
      };
    case "requested":
      return {
        title: "Request sent",
        body: "An owner of the organization has to approve Ponzu. It shows up in Ponzu once they do.",
      };
    case "pending":
      return {
        title: "Almost there",
        body: "Go back to Ponzu. It picks up what you set up on GitHub by itself.",
      };
    case "sign_in":
      return {
        title: "Sign in to Ponzu again",
        body: "Your GitHub connection has expired. What you set up on GitHub is kept.",
      };
    case "failed":
      return {
        title: "Ponzu couldn't reach GitHub",
        body: "What you set up on GitHub is kept. Go back to Ponzu; it catches up in a moment.",
      };
  }
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text that can only ever be text, in an element or a quoted attribute. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ENTITIES[character]!);
}
