/*
 * What session replay and events may carry (docs/analytics.md, "Session replay"). Pure, so the
 * rules are tested without PostHog.
 *
 * Both modes: every input is masked (PostHog's default), and anything that can show a secret is
 * blocked outright, recorded as an empty box of its size: PostHog's own `ph-no-capture` class,
 * which also keeps it out of autocapture, on the Claude card (its code and API key), a secret's
 * field in Needs you, and a repo's secrets in Settings.
 *
 * `private`, besides: a design's boards are blocked wherever they are drawn (the canvas's live
 * boards and their pictures, the thread's miniatures, the sidebar's previews), and the text of
 * the canvas (board names, comments), the thread and its composer, the create page's ideas, the
 * pull request tab and the sidebar's design names is masked. The chrome, the layout and every
 * pointer and key stay watchable.
 */

export type ReplayMode = "full" | "private";

/** The class PostHog never records the inside of, nor autocaptures: for what can show a secret. */
export const SECRET_CLASS = "ph-no-capture";

/** A design's own pixels: its boards, their pictures, its previews. */
const DESIGN_PIXELS = [
  // A live board's shadow host, and in the canvas the tier around it with its picture.
  "[data-artboard-host]",
  "[data-pz-tier]",
  "[data-pz-cover]",
  '[data-replay="block"]',
];

/** Where a design's or a person's words are: masked to asterisks, kept in place. */
const DESIGN_WORDS = [".pz-root", "#thread", '[data-replay="mask"]'];

/** Attributes that say in words what an element is: a design's or board's name, often. */
const WORDY_ATTRIBUTES = new Set(["aria-label", "title", "alt", "placeholder", "aria-description"]);

export interface ReplayPrivacy {
  blockClass: string;
  blockSelector: string | null;
  maskTextSelector: string | null;
  maskAllInputs: true;
  maskAttributeFn: ((name: string, value: string, element?: Element) => string) | null;
}

export function replayPrivacy(mode: ReplayMode): ReplayPrivacy {
  const words = DESIGN_WORDS.join(", ");
  return {
    blockClass: SECRET_CLASS,
    blockSelector: mode === "private" ? DESIGN_PIXELS.join(", ") : null,
    maskTextSelector: mode === "private" ? words : null,
    maskAllInputs: true,
    // Masked text would still be read out of a label: a row's `aria-label`, a board's `title`.
    maskAttributeFn:
      mode === "private"
        ? (name, value, element) =>
            WORDY_ATTRIBUTES.has(name) && element?.closest(words) ? "*".repeat(value.length) : value
        : null,
  };
}

/**
 * A URL with nothing after its path: a query or fragment can carry a token (an upload's signed
 * address does), and a path on this computer is never sent. Anything that isn't a URL comes back
 * as it was, unless it names the page's own location, which becomes `replacement`.
 */
export function scrubUrl(value: string, page: { origin: string; replacement: string }): string {
  if (isPageUrl(value, page.origin)) return page.replacement;
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  if (url.protocol === "file:") return page.replacement;
  return `${url.origin}${url.pathname}`;
}

/**
 * A string with the folders of this computer taken out. Only a development build has any: Vite
 * serves what lies outside the studio's folder from `/@fs/<absolute path>`, so its stack frames
 * and stylesheet links name the checkout, and through it the account. Kept from the repo's own
 * folders on (`/@fs/…/packages/canvas/src/Canvas.tsx`), which is what a reader needs.
 */
export function scrubLocalPaths(value: string): string {
  return value.replace(
    /\/@fs\/[^\s"'`()]*?\/(packages|apps|node_modules)\//g,
    (_whole, folder: string) => `/@fs/…/${folder}/`,
  );
}

/** `value` with `scrubLocalPaths` applied to every string in it, however deep. */
export function scrubLocalPathsDeep<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.includes("/@fs/") ? scrubLocalPaths(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]));
    }
    return v;
  };
  return walk(value) as T;
}

function isPageUrl(value: string, origin: string): boolean {
  return value === origin || value.startsWith(`${origin}/`) || value.startsWith("file:");
}

/** The properties PostHog derives from the page's location, and what each becomes. */
const LOCATION_PROPERTIES = ["$current_url", "$initial_current_url", "$session_entry_url"];
const PATH_PROPERTIES = ["$pathname", "$initial_pathname", "$session_entry_pathname"];
const HOST_PROPERTIES = ["$host", "$initial_host", "$session_entry_host"];
const REFERRER_PROPERTIES = [
  "$referrer",
  "$initial_referrer",
  "$session_entry_referrer",
  "$referring_domain",
  "$initial_referring_domain",
  "$session_entry_referring_domain",
];

export interface ViewPlace {
  url: string;
  path: string;
  host: string;
}

/**
 * Properties with every trace of the page's real location replaced by the view's synthetic URL
 * (`ponzu://app/design`): `$current_url` and its kin, and the referrer, always `$direct`, since
 * nothing refers anyone to a desktop app. An event's own properties always say where it
 * happened (`current`); its `$set` and `$set_once`, where PostHog keeps the first ones, have only
 * what they already held rewritten.
 */
export function placeOnView(
  bag: Record<string, unknown>,
  view: ViewPlace,
  current: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...bag };
  for (const key of LOCATION_PROPERTIES) if (key in out) out[key] = view.url;
  for (const key of PATH_PROPERTIES) if (key in out) out[key] = view.path;
  for (const key of HOST_PROPERTIES) if (key in out) out[key] = view.host;
  for (const key of REFERRER_PROPERTIES) if (key in out) out[key] = "$direct";
  if (current) {
    out.$current_url = view.url;
    out.$pathname = view.path;
    out.$host = view.host;
  }
  return out;
}
