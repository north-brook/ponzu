import { GOOGLE_FONTS_DATA } from "./google-fonts-data.ts";

/**
 * Google Fonts, loaded so text renders the same on the canvas, in screenshots
 * and in exports.
 *
 * css2 is strict: a request naming an italic or a weight a family doesn't have
 * is a 400, and one bad family in a combined request fails every family in it
 * (Instrument Serif has only 400 and 400 italic, so `ital,wght@0,100..900;…`
 * is rejected). So each family gets its own request, built from a bundled
 * table of what every Google family really has (scripts/google-fonts.ts),
 * with no network lookup at render time. A family the table doesn't know, or
 * a request Google turns down anyway, retries once with a list of discrete
 * weights, which css2 answers with whichever of them exist. A family that
 * still fails is marked on its <link> for the lint pass to report.
 */

export interface GoogleFontRequest {
  /** The family as Google names it, or as written when Google doesn't list it. */
  family: string;
  /** Whether the bundled table lists it as a Google Font. */
  known: boolean;
  /** The css2 stylesheet. */
  href: string;
  /** Tried if `href` fails. */
  retry?: string;
  /** A Google family with a similar name, when this one isn't one. */
  suggest?: string;
}

interface Axes {
  family: string;
  upright: string;
  italic: string;
}

const CSS2 = "https://fonts.googleapis.com/css2";
/** Families per page; more is almost certainly a mistake. */
const MAX_FAMILIES = 16;

let table: Map<string, Axes> | null = null;
function lookup(): Map<string, Axes> {
  if (table) return table;
  table = new Map();
  for (const line of GOOGLE_FONTS_DATA.split("\n")) {
    if (!line) continue;
    const [family = "", upright = "400", italic = ""] = line.split(";");
    table.set(family.toLowerCase(), { family, upright, italic });
  }
  return table;
}

const encode = (family: string) => encodeURIComponent(family).replace(/%20/g, "+");

/** One axis entry ("100..900", "400,700") as css2 tuples for an ital value. */
function tuples(weights: string, ital?: 0 | 1): string[] {
  const parts = weights.includes("..") ? [weights] : weights.split(",");
  return parts.map((w) => (ital === undefined ? w : `${ital},${w}`));
}

/** The css2 axis spec for exactly what a family has: "" (just 400), "wght@…" or "ital,wght@…". */
function spec(a: Axes): string {
  if (!a.italic) return a.upright === "400" ? "" : `wght@${tuples(a.upright).join(";")}`;
  const t = [...(a.upright ? tuples(a.upright, 0) : []), ...tuples(a.italic, 1)];
  return `ital,wght@${t.join(";")}`;
}

/** Every standard weight, upright and italic: css2 serves whichever exist. */
const ANY_WEIGHT = `ital,wght@${[0, 1]
  .flatMap((i) => [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => `${i},${w}`))
  .join(";")}`;

const url = (family: string, axes: string) =>
  `${CSS2}?family=${encode(family)}${axes ? `:${axes}` : ""}&display=block`;

const requests = new Map<string, GoogleFontRequest>();

/** The stylesheet that loads one family with the italics and weights it really has. */
export function googleFontRequest(name: string): GoogleFontRequest {
  const key = name.toLowerCase();
  let req = requests.get(key);
  if (!req) {
    req = buildRequest(name);
    if (requests.size > 500) requests.clear();
    requests.set(key, req);
  }
  return req;
}

function buildRequest(name: string): GoogleFontRequest {
  const axes = lookup().get(name.toLowerCase());
  if (axes) {
    // Google's table drifts; the discrete list still loads what's there.
    return {
      family: axes.family,
      known: true,
      href: url(axes.family, spec(axes)),
      retry: url(axes.family, ANY_WEIGHT),
    };
  }
  // Newer than the table, installed locally, or a typo: worth one try.
  const suggest = suggestFamily(name);
  return { family: name, known: false, href: url(name, ANY_WEIGHT), ...(suggest && { suggest }) };
}

/** Whether Google Fonts has this family (case-insensitively, as CSS matches names). */
export function isGoogleFont(name: string): boolean {
  return lookup().has(name.toLowerCase());
}

/** A Google family whose name is close to `name`: different spacing, or a typo or two. */
export function suggestFamily(name: string): string | undefined {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = squash(name);
  if (want.length < 3) return;
  const limit = want.length < 6 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const { family } of lookup().values()) {
    const have = squash(family);
    if (Math.abs(have.length - want.length) >= bestDistance) continue;
    const d = have === want ? 0 : distance(want, have, bestDistance);
    if (d < bestDistance) {
      best = family;
      bestDistance = d;
      if (!d) break;
    }
  }
  return best;
}

/** Levenshtein distance, giving up once it reaches `cap`. */
function distance(a: string, b: string, cap: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      row.push(v);
      if (v < low) low = v;
    }
    if (low >= cap) return cap;
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Families named in font-family declarations, the font shorthand and --font
 * tokens, minus generic and system families and ones the page declares with
 * its own @font-face.
 */
export function fontFamilies(html: string, tokens: string): string[] {
  const families = new Map<string, string>();
  const own = new Set<string>();
  for (const src of [html.replace(/&quot;/g, "'"), tokens])
    for (const m of src.matchAll(/@font-face\s*\{[^}]*?font-family\s*:\s*([^;}]+)/gi))
      own.add(unquote(m[1]!).toLowerCase());
  const add = (list: string) => {
    for (const raw of list.split(",")) {
      const name = unquote(raw);
      if (!name || /[(){}<>]/.test(name)) continue;
      const key = name.toLowerCase();
      if (GENERIC.has(key) || SYSTEM.has(key) || own.has(key) || families.has(key)) continue;
      families.set(key, name);
    }
  };
  for (const src of [html.replace(/&quot;/g, "'"), tokens]) {
    // font-family: A, B
    for (const m of src.matchAll(/font-family\s*:\s*([^;"}]+)/gi)) add(m[1]!);
    // font: 600 40px/1 A, B  (the family list follows the size)
    for (const m of src.matchAll(
      /(?:^|[;"\s{])font\s*:\s*[^;"}]*?\d[\d.]*(?:px|em|rem|%|pt|vw|vh)(?:\s*\/\s*[\w.%-]+)?\s+([^;"}]+)/gi,
    ))
      add(m[1]!);
  }
  // Token values like --font-sans: "Inter Tight"
  for (const m of tokens.matchAll(/--font[\w-]*\s*:\s*([^;]+);/g)) add(m[1]!);
  return [...families.values()];
}

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();

/** The Google Fonts requests a page needs, one per family. */
export function googleFonts(html: string, tokens: string): GoogleFontRequest[] {
  return fontFamilies(html, tokens).slice(0, MAX_FAMILIES).map(googleFontRequest);
}

/**
 * Retries a failed font stylesheet once, then marks it failed for lint.
 * Inline so it runs in every render host (Chromium, Electron) without a script.
 */
const ON_ERROR =
  "if(this.dataset.retry){this.href=this.dataset.retry;delete this.dataset.retry}else this.setAttribute('data-font-failed','')";

const attr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** <link> tags for a page's <head>. */
export function googleFontLinks(fonts: GoogleFontRequest[]): string {
  return fonts
    .map(
      (f) =>
        `<link rel="stylesheet" href="${attr(f.href)}" data-font="${attr(f.family)}"${f.known ? " data-google" : ""}${f.retry ? ` data-retry="${attr(f.retry)}"` : ""}${f.suggest ? ` data-suggest="${attr(f.suggest)}"` : ""} onerror="${ON_ERROR}">`,
    )
    .join("\n");
}

/** The same <link>, built in a live document (the canvas). */
export function googleFontElement(doc: Document, f: GoogleFontRequest): HTMLLinkElement {
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.dataset.font = f.family;
  if (f.known) link.dataset.google = "";
  if (f.suggest) link.dataset.suggest = f.suggest;
  let retry = f.retry;
  link.onerror = () => {
    if (retry) {
      link.href = retry;
      retry = undefined;
    } else link.setAttribute("data-font-failed", "");
  };
  link.href = f.href;
  return link;
}

/**
 * Runs in the page once fonts have settled. For each family a text node asks
 * for that the page tried to load (a font <link> or an @font-face) but that
 * renders in a fallback instead, one "missing-font" issue on the first node
 * that shows it. Whether a family renders is measured, not inferred from the
 * request: a font installed locally still counts, and an @font-face whose
 * files failed doesn't.
 */
export const FONT_LINT_SCRIPT = `(() => {
  const issues = [];
  const root = document.querySelector('[data-artboard]');
  if (!root || !document.fonts) return issues;
  const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '').trim();
  const links = new Map([...document.querySelectorAll('link[data-font]')].map((l) => [l.dataset.font.toLowerCase(), l]));
  const faces = new Map();
  for (const f of document.fonts) {
    const k = unquote(f.family).toLowerCase();
    faces.set(k, faces.get(k) === true || f.status === 'loaded');
  }
  const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|math|emoji|fangsong|inherit|initial|unset|revert)$/i;
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli WWQ@0123456789 abcdefghijklmnopqrstuvwxyz';
  const seen = new Map();
  // A missing family measures exactly like the fallback after it, whichever fallback that is.
  const renders = (family, style) => {
    const k = family.toLowerCase() + '|' + style;
    if (faces.get(family.toLowerCase()) === true) return true;
    if (seen.has(k)) return seen.get(k);
    let ok = !ctx;
    for (const base of ctx ? ['monospace', 'serif'] : []) {
      ctx.font = style + ' 40px ' + base;
      const plain = ctx.measureText(sample).width;
      ctx.font = style + ' 40px ' + JSON.stringify(family) + ', ' + base;
      if (ctx.measureText(sample).width !== plain) ok = true;
    }
    seen.set(k, ok);
    return ok;
  };
  const reported = new Set();
  for (const el of root.querySelectorAll('[data-id]')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    // Text that isn't rendered (here or under a hidden ancestor) never loads its font.
    if (cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    const style = (/^(italic|oblique)/.test(cs.fontStyle) ? 'italic ' : '') + cs.fontWeight;
    const stack = cs.fontFamily.split(',').map(unquote).filter(Boolean);
    for (let i = 0; i < stack.length; i++) {
      const family = stack[i];
      const k = family.toLowerCase();
      if (generic.test(family) || renders(family, style)) break;
      // Never requested: a system font this machine lacks, which falls through quietly.
      if (!links.has(k) && !faces.has(k)) continue;
      if (reported.has(k)) break;
      reported.add(k);
      const next = stack.slice(i + 1).find((f) => generic.test(f) || renders(f, style));
      const shows = 'its text shows in ' + (next ? next : 'the default font') + ' instead';
      const link = links.get(k);
      let message;
      if (link && !('google' in link.dataset)) {
        message = 'font "' + family + '" isn\\'t a Google Font or installed here, so ' + shows +
          (link.dataset.suggest ? '. Did you mean "' + link.dataset.suggest + '"?' : '. Check the name, or pick a Google Font.');
      } else if (link) {
        message = 'font "' + family + '" didn\\'t load from Google Fonts (offline?), so ' + shows;
      } else {
        message = 'font "' + family + '" didn\\'t load; check its @font-face src. ' + shows[0].toUpperCase() + shows.slice(1);
      }
      issues.push({ id: el.getAttribute('data-id'), kind: 'missing-font', message });
      break;
    }
  }
  return issues;
})()`;

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "revert",
]);

/** Families every Mac or Windows has; never fetched from Google. */
const SYSTEM = new Set([
  "-apple-system",
  "blinkmacsystemfont",
  "segoe ui",
  "helvetica",
  "helvetica neue",
  "arial",
  "sf pro",
  "sf pro text",
  "sf pro display",
  "sf mono",
  "menlo",
  "monaco",
  "consolas",
  "times",
  "times new roman",
  "georgia",
  "courier",
  "courier new",
  "apple color emoji",
]);
