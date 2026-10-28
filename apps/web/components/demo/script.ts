/**
 * The product demo's story, as a timeline. Each beat changes what the scene shows; the scene is a
 * pure function of the current beat plus how far into it we are.
 *
 * It's how Seekle, a game on the App Store, was designed in Ponzu, cut short: the real boards and
 * the real comments, in the order they happened. It opens just after you've asked Claude to
 * rebuild the app from its source, explore how the game should feel, redesign the website and make
 * the App Store screenshots, on a file as Ponzu makes it, one empty "Page 1".
 *
 * Claude draws the app's screens, then every one of its animations; you ask about them and it
 * answers in the thread. Then studies of the game's feel: four takes on each of three problems and
 * three full screens combining them. You comment on two studies and pick a direction; Claude
 * revises those boards in place, as they were then and as they became, and carries your notes into
 * all three directions. It draws the website hero; you ask for friends round the phone and it adds
 * them. Last, fifteen App Store screenshots in three directions. Between them you look round each
 * page, close up. As in the app, Claude resolves a change it made without replying.
 */

export const PROMPT =
  "Rebuild Seekle from apps/native, every screen and animation. Then explore the game feel, the website hero and App Store screenshots.";

/** What the demo shows, for screen readers. */
export const LABEL =
  "Claude Code rebuilds Seekle, an iPhone game, on the Ponzu canvas from the app's source: its screens, then every one of its animations, looping. It explores the game's feel in twelve animated studies; you comment on two, it combines them into three full directions, and you pick one. It designs the website hero; you ask for friends round the phone and it adds them, orbiting. Last, it makes fifteen App Store screenshots in three directions.";

/** What you say on the canvas, word for word as it was said, and where each pin went. */
export const COMMENTS = [
  {
    id: "c0",
    board: "ab_m_board",
    x: 250,
    y: 150,
    text: "i like the way we're animating the actual ui elements in. we should do that for all the different screens (if we're not already)",
    // A question gets an answer in the thread, and stays open.
    reply:
      "Agreed. Onboarding, Home, game over and the empty states already rise in like this; I'll build the launch hand-off itself (mark → hero card / Home logo) next, and check the rest (settings, invite, paywall) for screens that just appear.",
  },
  {
    id: "c1",
    board: "ab_x_a2",
    x: 227,
    y: 99,
    text: 'i like this animation a lot, but i would remove the "found" label and maybe try not adding the green color',
    resolve: "rework-2",
  },
  {
    id: "c2",
    board: "ab_x_b2",
    x: 210,
    y: 125,
    text: "i like score in the middle with a nice number change animation and timer in the top right",
    resolve: "rework-2",
  },
  {
    id: "c3",
    board: "ab_x_d2",
    x: 272,
    y: 101,
    text: "this is the best direction",
    resolve: "web-page",
  },
  {
    id: "c4",
    board: "ab_w_desktop",
    x: 1323,
    y: 457,
    text: "maybe we could put some user avatars swirling, so the impression is set with friends",
    resolve: "revise-look",
  },
] as const;

export type Comment = (typeof COMMENTS)[number];
export type CommentId = Comment["id"];

/** A typist's average gap between keys in a comment, in ms. */
export const TYPING_MS = { comment: 30 } as const;

/** Repeatable noise in [0, 1) for the `i`th key, so every loop types the same way. */
const jitter = (i: number) => {
  const x = Math.sin(i * 12.9898 + 4.1) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * When each character of `text` lands, in ms from the first key: an uneven rhythm round `gap`,
 * a touch slower after a space and slower again after a comma or full stop, as people type.
 */
function keyTimes(text: string, gap: number): number[] {
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    const prev = text[i - 1] ?? "";
    at += gap * (0.55 + 0.9 * jitter(i));
    if (prev === " ") at += gap * 0.35;
    if (/[,.:"]/.test(prev)) at += gap * 1.6;
    out.push(at);
  }
  return out;
}

const times = new Map<string, number[]>();
const keys = (text: string, gap: number) => {
  const id = `${gap}:${text}`;
  const known = times.get(id);
  if (known) return known;
  const t = keyTimes(text, gap);
  times.set(id, t);
  return t;
};

/** How long typing `text` takes. */
export const typingMs = (text: string, gap: number) => keys(text, gap).at(-1) ?? 0;

/** What's been typed of `text`, `ms` after the first key. */
export function typedAt(text: string, gap: number, ms: number): string {
  const t = keys(text, gap);
  let n = 0;
  while (n < t.length && t[n]! <= ms) n++;
  return text.slice(0, n);
}

/** Leaving a comment: the cursor travels to the spot, clicks, types and posts. */
const comment = (c: Comment, cursor = 700) =>
  [
    { id: `${c.id}-cursor`, ms: cursor },
    { id: `${c.id}-click`, ms: 260 },
    { id: `${c.id}-type`, ms: typingMs(c.text, TYPING_MS.comment) + 350 },
    { id: `${c.id}-post`, ms: 420 },
  ] as const;

const [C0, C1, C2, C3, C4] = COMMENTS;

/**
 * Between writing a page and the next thing, you look round it as anyone would: the camera zooms
 * in on a few boards and pans across, long enough to watch their loops play (`*-look` beats).
 * Claude screenshots its work meanwhile.
 */
export const BEATS = [
  { id: "think", ms: 600 },
  { id: "app-page", ms: 300 },
  { id: "app", ms: 2200 },
  { id: "app-look", ms: 3600 },
  { id: "motion-page", ms: 300 },
  { id: "motion", ms: 2500 },
  { id: "motion-look", ms: 2800 },
  { id: "motion-look-2", ms: 2200 },
  ...comment(C0, 700),
  { id: "c0-heard", ms: 800 },
  { id: "c0-reply", ms: 5600 },
  { id: "motion-look-3", ms: 2600 },
  { id: "explore-page", ms: 300 },
  { id: "explore", ms: 2600 },
  { id: "explore-look", ms: 3400 },
  { id: "explore-look-2", ms: 3000 },
  ...comment(C1, 1100),
  ...comment(C2, 700),
  ...comment(C3, 1100),
  { id: "c3-heard", ms: 700 },
  // Claude revises the studies you commented on, then carries them into the directions.
  { id: "rework", ms: 3000 },
  { id: "rework-2", ms: 3200 },
  { id: "web-page", ms: 300 },
  { id: "web", ms: 2000 },
  { id: "web-look", ms: 2600 },
  ...comment(C4, 1100),
  { id: "c4-heard", ms: 500 },
  { id: "revise", ms: 2400 },
  { id: "revise-look", ms: 3200 },
  { id: "store-page", ms: 300 },
  { id: "store", ms: 2600 },
  { id: "store-look", ms: 3600 },
  { id: "store-look-2", ms: 3200 },
  { id: "rest", ms: 3000 },
] as const satisfies readonly { id: string; ms: number }[];

export type BeatId = (typeof BEATS)[number]["id"];

export const LAST = BEATS.length - 1;

/**
 * The stories the demo plays and how long each runs. Phones play each as a video recorded from the
 * live demo (scripts/record-demo.ts), one per story and color scheme. There's one story for now.
 */
export const STORIES = [{ id: "seekle", ms: BEATS.reduce((sum, b) => sum + b.ms, 0) }] as const;
export const index = (id: BeatId) => BEATS.findIndex((b) => b.id === id);

/** The beats of one comment, from the cursor setting off to the comment posted. */
export const beatsOf = (c: Comment) => ({
  cursor: `${c.id}-cursor` as BeatId,
  click: `${c.id}-click` as BeatId,
  type: `${c.id}-type` as BeatId,
  post: `${c.id}-post` as BeatId,
});
