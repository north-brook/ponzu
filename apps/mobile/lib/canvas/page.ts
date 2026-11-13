import { ASSETS_PLACEHOLDER } from "../../canvas/protocol";

/*
 * How the app loads the canvas page (components/canvas-view.tsx): from the canvas's own asset
 * origin, so every image, font and mask the boards load is same-origin and R2 needs no CORS
 * (iPhone design D3). The page is built once with a placeholder where its content security policy
 * names that origin; each canvas's goes in before it loads. Pure, so bun tests it.
 */

/**
 * The origin of a canvas's `assetsUrl`, for the page's policy and its base URL, or null when it
 * isn't one the page may load from: https only, with a plain host (the API's R2 hosts), or http
 * on this machine for the page tests and the fake. Nothing else reaches the policy, so a stray
 * quote or semicolon in a URL can never widen it.
 */
export function assetsOrigin(assetsUrl: string): string | null {
  const match =
    /^(https:\/\/[a-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?)\//i.exec(
      assetsUrl,
    );
  return match ? match[1]!.toLowerCase() : null;
}

/** The built page with this canvas's asset origin in its policy. */
export function pageHtml(html: string, origin: string): string {
  return html.replaceAll(ASSETS_PLACEHOLDER, origin);
}

/**
 * Whether the web view may go to `url`: the page's own first load (its base URL), a blank frame,
 * and a frame whose document the page's own script wrote (`about:srcdoc`: the drawing of a
 * comment's picture reads default styles in one, canvas/picture.ts), nothing else. Neither frame
 * loads anything from anywhere, and the page's policy holds in both. A tap on a link in a board
 * goes nowhere, here or in Safari.
 */
export function allowLoad(url: string, base: string): boolean {
  return url === base || url === "about:blank" || url === "about:srcdoc";
}
