/*
 * The handoff: the page a browser is left on when it hands the person back to Ponzu (docs/cloud.md,
 * "Handing back to the app"). The API's GitHub setup page and the Mac app's sign-in page are this
 * document; the site's design link page is the same pattern in React (apps/web), with the same
 * wait and the same words.
 *
 * The pattern is the old product's (`/local` on ponzu.design): the page opens the app's link by
 * itself as it loads, showing the Ponzu mark and one plain line. A browser says nothing when no
 * app takes a link, so the page watches: an app launching takes the page's focus or hides it.
 * When that happens the page says Ponzu has it and closes itself (a browser that won't let a tab
 * it didn't open close leaves the words saying it can be closed). If neither happens within
 * `HANDOFF_WAIT_MS`, the page offers the link again as a button; focus that leaves later, once
 * the person answers the browser's prompt, still counts.
 *
 * Where there is no link to open (a build that takes none, or an app nobody can name) the page
 * says what happened and, when the app already has it, closes itself once the app comes forward.
 *
 * The document is self-contained: no request of its own, nothing from a query string. Its one
 * script and one style sheet are fixed text, allowed by their hashes (`csp`), so a page that
 * serves it needs neither `unsafe-inline` nor a nonce. What varies (words, the link) sits in the
 * markup, escaped, and the link must be one of the apps' own.
 */

/** How long the app has to take the page's focus before the page offers its link again. */
export const HANDOFF_WAIT_MS = 2000;

/** The schemes of the apps' links, and the only links a handoff can carry. */
export const APP_SCHEMES = ["ponzu", "ponzu-dev", "ponzu-preview"] as const;
export type AppScheme = (typeof APP_SCHEMES)[number];

/** What each app is called where a page names it: on a button, in a line. */
export const APP_NAMES: Record<AppScheme, string> = {
  ponzu: "Ponzu",
  "ponzu-dev": "Ponzu Dev",
  "ponzu-preview": "Ponzu Preview",
};

/** A link a handoff may open: one of the apps' schemes, then a path and query of plain characters. */
const APP_LINK = new RegExp(`^(${APP_SCHEMES.join("|")})://[A-Za-z0-9_\\-./?=&%]*$`);

export function isAppLink(href: string): boolean {
  return APP_LINK.test(href);
}

/** One state of the page: what it says. */
export interface HandoffView {
  /** The one plain line. */
  title: string;
  /** A quieter line under it. */
  body: string;
}

export interface Handoff {
  /** The tab's title, before " · Ponzu". */
  documentTitle: string;
  /** What the page says as it loads: while the link opens, or for good when there is none. */
  view: HandoffView;
  /**
   * The app's link, opened by the page itself, and what it says once the app has taken it
   * (`opened`) or when nothing did within the wait (`missed`, with the link as a button).
   * Null when there is nothing to open.
   */
  link: {
    href: string;
    /** The app's name, for the button: "Open Ponzu Dev". */
    app: string;
    opened: HandoffView;
    missed: HandoffView;
  } | null;
  /**
   * Without a link: the app already has what happened and is coming forward by itself, so the
   * page closes once it loses the focus to it. False when the person still has something to do.
   */
  closes?: boolean;
  /** A page that says something went wrong: the mark goes quiet. */
  problem?: boolean;
}

/*
 * The page's behaviour, as fixed text: its hash is what the content security policy allows. It
 * reads only the markup's data attributes and touches nothing outside the page.
 */
const SCRIPT = `(() => {
  const main = document.querySelector("main");
  if (!main) return;
  const link = main.getAttribute("data-link");
  const state = (to) => main.setAttribute("data-state", to);
  const close = () => {
    try { window.close(); } catch {}
  };
  if (!link) {
    if (main.getAttribute("data-closes") !== "true") return;
    const away = () => close();
    if (!document.hasFocus()) return away();
    window.addEventListener("blur", away, { once: true });
    document.addEventListener("visibilitychange", () => document.hidden && away());
    return;
  }
  let timer = 0;
  let watching = false;
  const away = () => {
    end();
    state("opened");
    close();
  };
  const onVisibility = () => document.hidden && away();
  const end = () => {
    clearTimeout(timer);
    if (!watching) return;
    watching = false;
    window.removeEventListener("blur", away);
    document.removeEventListener("visibilitychange", onVisibility);
  };
  const open = () => {
    end();
    state("opening");
    watching = true;
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", onVisibility);
    timer = setTimeout(() => {
      if (document.hasFocus()) state("missed");
    }, ${HANDOFF_WAIT_MS});
    window.location.href = link;
  };
  const retry = main.querySelector("[data-retry]");
  if (retry) {
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      open();
    });
  }
  open();
})();`;

/*
 * The page's look: the cloud's tokens (apps/studio/src/cloud/styles/tokens.css) and the site's
 * handoff (`/local`): white or near black, ink, the slice in ink on light and yuzu on dark, and
 * the action in the same two. System fonts: the page loads nothing.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --ground: #ffffff;
  --ink: #111110;
  --muted: #5e5b54;
  --faint: #807c73;
  --slice: #111110;
  --quiet: #c9c5bc;
  --cta: #111110;
  --cta-ink: #ffffff;
  --ring: #ffc81e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0e0e0d;
    --ink: #f4f3ef;
    --muted: #a9a59b;
    --faint: #807c73;
    --slice: #ffc81e;
    --quiet: #5e5b54;
    --cta: #ffc81e;
    --cta-ink: #111110;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
body { display: flex; flex-direction: column; }
header {
  flex: none;
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 1440px;
  height: 82px;
  margin: 0 auto;
  padding: 0 64px;
}
.lockup { height: 27.14px; width: auto; display: block; }
.lockup .lockup-slice { fill: var(--slice); stroke: var(--slice); }
.lockup .lockup-word { fill: var(--ink); }
@media (max-width: 720px) { header { padding: 0 20px; } }
main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  padding: 24px 16px 82px;
  text-align: center;
}
.mark { width: 56px; height: 56px; flex: none; }
.mark g { fill: var(--slice); stroke: var(--slice); }
main[data-problem="true"] .mark g { fill: var(--quiet); stroke: var(--quiet); }
.view { display: none; flex-direction: column; align-items: center; gap: 10px; max-width: 460px; }
.view[data-for="opening"] { display: flex; }
main[data-state="opened"] .view[data-for="opening"],
main[data-state="missed"] .view[data-for="opening"] { display: none; }
main[data-state="opened"] .view[data-for="opened"],
main[data-state="missed"] .view[data-for="missed"] { display: flex; animation: swap 220ms cubic-bezier(0.2, 0.9, 0.3, 1); }
h1 {
  margin: 0;
  font-size: 32px;
  line-height: 38px;
  font-weight: 600;
  letter-spacing: -0.03em;
  text-wrap: balance;
}
p { margin: 0; color: var(--muted); text-wrap: balance; }
.cta {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  margin-top: 22px;
  padding: 13px 22px 13px 18px;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-ink);
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  transition: translate 150ms ease-out;
}
.cta:hover { translate: 0 -1px; }
.cta:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
.cta svg { width: 16px; height: 16px; }
.cta g { fill: currentColor; stroke: currentColor; }
main[data-state="opening"][data-link] .mark path { animation: breathe 1.2s ease-in-out infinite; }
.mark path:nth-child(2) { animation-delay: 0.2s; }
.mark path:nth-child(3) { animation-delay: 0.4s; }
.mark path:nth-child(4) { animation-delay: 0.6s; }
.mark path:nth-child(5) { animation-delay: 0.8s; }
.mark path:nth-child(6) { animation-delay: 1s; }
@keyframes breathe { 50% { opacity: 0.35; } }
@keyframes swap { from { opacity: 0; translate: 0 6px; } }
@media (prefers-reduced-motion: reduce) {
  main .mark path, main .view { animation: none !important; }
  .cta { transition: none; }
}
@media (max-width: 480px) {
  h1 { font-size: 26px; line-height: 32px; }
}
`;

/** The slice, the same six segments the apps draw (packages/canvas/src/slice.ts). */
const SLICE_PATHS = [
  "M36 25.07L36 4.99A27.3 27.3 0 0 1 53.39 15.03Z",
  "M40 32L57.39 21.96A27.3 27.3 0 0 1 57.39 42.04Z",
  "M36 38.93L53.39 48.97A27.3 27.3 0 0 1 36 59.01Z",
  "M28 38.93L28 59.01A27.3 27.3 0 0 1 10.61 48.97Z",
  "M24 32L6.61 42.04A27.3 27.3 0 0 1 6.61 21.96Z",
  "M28 25.07L10.61 15.03A27.3 27.3 0 0 1 28 4.99Z",
];

function slice(className: string): string {
  const paths = SLICE_PATHS.map((d) => `<path d="${d}"/>`).join("");
  return `<svg class="${className}" viewBox="0 0 64 64" aria-hidden="true"><g stroke-width="3.4" stroke-linejoin="round">${paths}</g></svg>`;
}

/*
 * "ponzu" in Funnel Display Bold at 100px with the lockup's -0.05em tracking, outlined from
 * apps/web/assets/og/FunnelDisplay-Bold.ttf: the page loads no font, so the word is a path.
 * Baseline at y 0.
 */
const WORDMARK =
  "M22.9 20.0L9.1 20.0L9.1-36.3L2.3-36.3L2.3-50.0L16.3-50.0L16.3-41.8L19.8-41.8Q22.4-46.2 26.9-48.6Q31.3-51.0 37.7-51.0L37.7-51.0Q45.4-51.0 50.8-47.8Q56.1-44.5 58.8-38.7Q61.6-32.8 61.6-25.0L61.6-25.0Q61.6-17.2 58.9-11.3Q56.3-5.4 51.2-2.2Q46.1 1 38.8 1L38.8 1Q33.3 1 29.4-1.0Q25.5-3.1 23.3-6.8L23.3-6.8L22.9-6.8L22.9 20.0ZM35.1-11.0L35.1-11.0Q41.4-11.0 44.6-14.8Q47.8-18.5 47.8-25.0L47.8-25.0Q47.8-31.5 44.6-35.3Q41.4-39.0 35.1-39.0L35.1-39.0Q29.5-39.0 26.2-35.9Q22.9-32.8 22.9-27.3L22.9-27.3L22.9-22.8Q22.9-17.3 26.2-14.1Q29.5-11.0 35.1-11.0ZM89 1L89 1Q80.8 1 74.8-2.2Q68.8-5.4 65.4-11.3Q62.1-17.1 62.1-25.1L62.1-25.1Q62.1-33.0 65.4-38.8Q68.7-44.7 74.8-47.8Q80.8-51.0 89.1-51.0L89.1-51.0Q97.3-51.0 103.3-47.8Q109.3-44.7 112.5-38.8Q115.8-33.0 115.8-25.0L115.8-25.0Q115.8-17.1 112.5-11.2Q109.3-5.3 103.2-2.2Q97.2 1 89 1ZM89-11.0L89-11.0Q95.3-11.0 98.6-14.8Q101.9-18.6 101.9-25.1L101.9-25.1Q101.9-31.6 98.6-35.3Q95.3-39.0 89-39.0L89-39.0Q82.7-39.0 79.3-35.3Q75.9-31.6 75.9-25.1L75.9-25.1Q75.9-18.6 79.3-14.8Q82.7-11.0 89-11.0ZM136.4 0L122.6 0L122.6-36.3L115.8-36.3L115.8-50.0L129.8-50.0L129.8-41.8L133.3-41.8Q136.2-46.2 140.6-48.5Q145-50.9 151.6-50.9L151.6-50.9Q162-50.9 167.7-45.2Q173.4-39.5 173.4-29.9L173.4-29.9L173.4 0L159.6 0L159.6-27.3Q159.6-32.8 156.6-35.7Q153.7-38.6 148-38.6L148-38.6Q142.3-38.6 139.4-35.7Q136.4-32.8 136.4-27.3L136.4-27.3L136.4 0ZM220 0L176 0L176-8.3L202-39.0L177.5-39.0L177.5-50.0L219.5-50.0L219.5-41.7L193.5-11.0L220-11.0L220 0ZM244.2 0.9L244.2 0.9Q233.8 0.9 228.2-4.6Q222.6-10.1 222.6-19.6L222.6-19.6L222.6-50.0L236.4-50.0L236.4-22.3Q236.4-16.8 239.2-14.1Q242-11.4 247.6-11.4L247.6-11.4Q253.3-11.4 256.5-14.3Q259.6-17.3 259.6-22.7L259.6-22.7L259.6-50.0L273.4-50.0L273.4-13.7L280.3-13.7L280.3 0L266.3 0L266.3-8.2L262.8-8.2Q259.8-3.8 255.5-1.4Q251.2 0.9 244.2 0.9Z";

/*
 * The site's lockup (apps/web/components/icons.tsx `Lockup`) as one drawing, at a font size of
 * 100: the slice 1.18em wide, centred on the word's line box, 0.32em before the word.
 */
const LOCKUP = `<svg class="lockup" viewBox="0 -92.5 432.5 118" role="img" aria-label="Ponzu"><g class="lockup-slice" transform="translate(0 -92.5) scale(1.84375)" stroke-width="3.4" stroke-linejoin="round">${SLICE_PATHS.map((d) => `<path d="${d}"/>`).join("")}</g><path class="lockup-word" transform="translate(150 0)" d="${WORDMARK}"/></svg>`;

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** A value that can only ever be text inside a double-quoted attribute. */
export function escapeAttribute(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ENTITIES[character]!);
}

/** Text that can only ever be text between tags: no tag can open, no entity can start. */
export function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (character) => ENTITIES[character]!);
}

function view(state: string, { title, body }: HandoffView, extra = ""): string {
  return `<section class="view" data-for="${state}">
<h1>${escapeText(title)}</h1>
<p>${escapeText(body)}</p>${extra}
</section>`;
}

let hashes: Promise<{ script: string; style: string }> | null = null;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/** The hashes of the page's script and style, worked out once. */
function handoffHashes(): Promise<{ script: string; style: string }> {
  hashes ??= Promise.all([sha256(SCRIPT), sha256(STYLE)]).then(([script, style]) => ({
    script,
    style,
  }));
  return hashes;
}

/**
 * Everything the page may do: its own script and style, by hash, and nothing else. No request,
 * no form, no frame around it.
 */
export async function handoffPolicy(): Promise<string> {
  const { script, style } = await handoffHashes();
  return `default-src 'none'; script-src ${script}; style-src ${style}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/**
 * The page, and the content security policy to serve it under. Throws on a link that isn't one
 * of the apps': nothing may make a handoff open anything else.
 */
export async function renderHandoff(page: Handoff): Promise<{ html: string; csp: string }> {
  const { link } = page;
  if (link && !isAppLink(link.href)) throw new Error("A handoff opens only the apps' own links.");
  const attributes = [
    `data-state="opening"`,
    link ? `data-link="${escapeAttribute(link.href)}"` : "",
    !link && page.closes ? `data-closes="true"` : "",
    page.problem ? `data-problem="true"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const views = link
    ? [
        view("opening", page.view),
        view("opened", link.opened),
        view(
          "missed",
          link.missed,
          `\n<a class="cta" href="${escapeAttribute(link.href)}" data-retry>${slice("")}Open ${escapeText(link.app)}</a>`,
        ),
      ]
    : [view("opening", page.view)];
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeText(page.documentTitle)} · Ponzu</title>
<style>${STYLE}</style>
</head>
<body>
<header>${LOCKUP}</header>
<main ${attributes} role="status" aria-live="polite">
${slice("mark")}
${views.join("\n")}
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
  return { html, csp: await handoffPolicy() };
}
