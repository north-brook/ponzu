/*
 * The canvas page's content security policy, as a meta tag the build writes into the page. It
 * mirrors the Mac's (apps/desktop/src/csp.ts): the page runs its own script and nothing else
 * (pinned by its hash, so an injected <script> never runs), styles inline as boards are drawn,
 * fonts from the canvas's files and Google, images from anywhere on https as the runner's
 * previews do, and it reaches only the canvas's asset origin and Google's font hosts.
 *
 * The asset origin is a placeholder here: the page is built once, and each canvas's origin
 * (`https://assets.ponzu.cloud`) is put in its place by the app before it loads the page
 * (lib/canvas/page.ts). The app's own messages arrive through WKWebView's evaluateJavaScript and
 * its message handler, which a page's policy does not govern.
 */
import { ASSETS_PLACEHOLDER } from "./protocol.ts";

/** The policy for a page whose one script hashes to `scriptHash` (base64 SHA-256). */
export function pageCsp(scriptHash: string): string {
  const assets = ASSETS_PLACEHOLDER;
  return [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    `font-src data: ${assets} https://fonts.gstatic.com`,
    `img-src data: blob: https: ${assets}`,
    `media-src blob: ${assets}`,
    `connect-src ${assets} https://fonts.googleapis.com https://fonts.gstatic.com`,
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The base64 SHA-256 of a script's text, as a CSP hash source names it. */
export function scriptHash(script: string): string {
  return new Bun.CryptoHasher("sha256").update(script).digest("base64");
}
