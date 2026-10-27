/**
 * The product demo's stories, one per use case, each a timeline. Each beat changes what the scene
 * shows; the scene is a pure function of the tab, its current beat and how far into it we are.
 *
 * All five are Seekle, a game on the App Store, through its life: its brand, its app, its launch,
 * how it works and how it's doing. Each opens just after you've sent Claude the tab's prompt, on a
 * file as Ponzu makes it, one empty "Page 1". Claude makes a page and writes its boards, you look
 * round them, close up, and comment, and Claude makes the change and resolves it without replying
 * (or, asked a question, answers in the thread). App and Launch are how Seekle was really designed
 * in Ponzu, cut short: the real boards and the real comments, in the order they happened. Brand,
 * Explain and Operate were drawn the same way, from Seekle's source.
 */

export type TabId = "brand" | "app" | "launch" | "explain" | "operate";

/** What you say on the canvas, word for word, and where its pin went on its board. */
export interface Comment {
  id: string;
  board: string;
  x: number;
  y: number;
  text: string;
  /** A question gets an answer in the thread, and stays open. */
  reply?: string;
  /** The beat Claude resolves it on, having made the change. Resolved threads leave the canvas. */
  resolve?: string;
}

export interface Beat {
  id: string;
  ms: number;
}

export type Shot = { x: number; y: number; w: number; h: number };
/** A shot the camera drifts across over its beat, as you'd scroll along a row to read it. */
export type Drift = { from: Shot; to: Shot };

/** What Claude says in its window, and the runs of tools between, in order. */
export type Entry =
  | { say: string; at: string }
  /** Claude's plan for the turn; each step is in progress between its beats. */
  | { plan: { label: string; from: string; to: string }[]; at: string }
  /** A run of tool calls from one beat to another. A finished run collapses to "Used N tools". */
  | { tools: number; from: string; to: string };

export interface Script {
  id: TabId;
  /** The tab's name and Hugeicon, in the bar above the demo. */
  name: string;
  icon: string;
  /** What you asked Claude, shown in the bar and sent in the Claude window. */
  prompt: string;
  /** The Claude window's title. */
  title: string;
  /** What the demo shows, for screen readers. */
  label: string;
  beats: Beat[];
  comments: Comment[];
  /**
   * The pages Claude makes, in order, each the design page it draws. A page shows from `from`;
   * its boards are written on its `beat`, where they sit in the design.
   */
  pages: { design: string; from: string; beat: string }[];
  /**
   * What the camera frames, in world px on the current page, from each beat on until the next one
   * listed. The first beat's shot is the empty file.
   */
  shots: Record<string, Shot | Drift>;
  /**
   * Boards Claude rewrites after your comments, and the beat it does it on. Until then they're as
   * they were (`DemoDesign.before`).
   */
  rework?: Record<string, string>;
  /**
   * What a comment asked for, on each board it changed: elements Claude adds on `at`, absent until
   * then. Claude works on those boards from `from` through `at`.
   */
  revision?: { from: string; at: string; boards: Record<string, string> };
  thread: Entry[];
  /** The Ponzu tool running on a beat, as the app names it, where the default doesn't fit. */
  tools: Record<string, string>;
}

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
const comment = (c: Comment, cursor = 700): Beat[] => [
  { id: `${c.id}-cursor`, ms: cursor },
  { id: `${c.id}-click`, ms: 260 },
  { id: `${c.id}-type`, ms: typingMs(c.text, TYPING_MS.comment) + 350 },
  { id: `${c.id}-post`, ms: 420 },
];

/** The beats of one comment, from the cursor setting off to the comment posted. */
export const beatsOf = (c: Comment) => ({
  cursor: `${c.id}-cursor`,
  click: `${c.id}-click`,
  type: `${c.id}-type`,
  post: `${c.id}-post`,
});

/*
 * Between writing a page and the next thing, you look round it as anyone would: the camera zooms
 * in on a few boards and pans across, long enough to watch their loops play (`*-look` beats).
 * Claude screenshots its work meanwhile.
 */

const BRAND_NOTE: Comment = {
  id: "c5",
  board: "ab_jpttv",
  x: 300,
  y: 290,
  text: "A is the one. can we see how the mark holds up as the app icon, light, dark and tinted?",
  resolve: "revise-look",
};

const BRAND: Script = {
  id: "brand",
  name: "Brand",
  icon: "palette",
  prompt: "Explore three directions for Seekle's mark, colour and type.",
  title: "Seekle brand directions",
  label:
    "Claude Code explores three brand directions for Seekle on the Ponzu canvas, starting from its real mark, two pink squiggles: keep the squiggles, make the three card shapes the logo, or go quiet on a night table. You pick the first and ask to see it as the app icon; Claude adds it in light, dark and tinted.",
  beats: [
    { id: "think", ms: 900 },
    { id: "brand-page", ms: 300 },
    { id: "brand", ms: 2400 },
    { id: "brand-look", ms: 4200 },
    { id: "brand-look-2", ms: 3000 },
    ...comment(BRAND_NOTE, 1000),
    { id: "c5-heard", ms: 900 },
    { id: "revise", ms: 2400 },
    { id: "revise-look", ms: 3400 },
    { id: "rest", ms: 3400 },
  ],
  comments: [BRAND_NOTE],
  pages: [{ design: "pg_zu87d", from: "brand-page", beat: "brand" }],
  shots: {
    think: { x: -80, y: -110, w: 2240, h: 1220 },
    // Along the three marks, then back to the first two whole.
    "brand-look": {
      from: { x: -40, y: 60, w: 760, h: 640 },
      to: { x: 1400, y: 60, w: 760, h: 640 },
    },
    "brand-look-2": { x: -60, y: -40, w: 1440, h: 1100 },
    // In on A as its icons arrive, then closer on them.
    revise: { x: -80, y: 140, w: 1120, h: 960 },
    "revise-look": {
      from: { x: -40, y: 560, w: 760, h: 520 },
      to: { x: -20, y: 640, w: 660, h: 440 },
    },
    rest: { x: -80, y: -110, w: 2240, h: 1220 },
  },
  revision: { from: "c5-heard", at: "revise", boards: { ab_jpttv: ".icons" } },
  thread: [
    {
      say: "Starting from your real mark in apps/native/assets. It's already a card: two pink, solid squiggles.",
      at: "think",
    },
    {
      plan: [
        { label: "The mark, colours and type in apps/native", from: "think", to: "brand-page" },
        { label: "Three directions, side by side", from: "brand-page", to: "c5-cursor" },
        { label: "Your notes", from: "c5-cursor", to: "rest" },
      ],
      at: "think",
    },
    { tools: 4, from: "brand-page", to: "c5-cursor" },
    {
      say: "Three directions: A keeps the squiggles, B makes the rule the logo, C goes quiet and nightly. Comment on any of them.",
      at: "c5-cursor",
    },
    { tools: 1, from: "c5-cursor", to: "c5-heard" },
    { say: "A it is. Adding its app icon in iOS's light, dark and tinted looks.", at: "c5-heard" },
    { tools: 2, from: "revise", to: "rest" },
    {
      say: "Done: A's icon, in all three looks, under its type. Your comment's resolved.",
      at: "rest",
    },
  ],
  tools: { "brand-page": "update page", brand: "write html", revise: "write html" },
};

/** The app's real comments, word for word as they were said. */
const C0: Comment = {
  id: "c0",
  board: "ab_m_board",
  x: 250,
  y: 150,
  text: "i like the way we're animating the actual ui elements in. we should do that for all the different screens (if we're not already)",
  reply:
    "Agreed. Onboarding, Home, game over and the empty states already rise in like this; I'll build the launch hand-off itself (mark → hero card / Home logo) next, and check the rest (settings, invite, paywall) for screens that just appear.",
};
const C1: Comment = {
  id: "c1",
  board: "ab_x_a2",
  x: 227,
  y: 99,
  text: 'i like this animation a lot, but i would remove the "found" label and maybe try not adding the green color',
  resolve: "rework-2",
};
const C2: Comment = {
  id: "c2",
  board: "ab_x_b2",
  x: 210,
  y: 125,
  text: "i like score in the middle with a nice number change animation and timer in the top right",
  resolve: "rework-2",
};
const C3: Comment = {
  id: "c3",
  board: "ab_x_d2",
  x: 272,
  y: 101,
  text: "this is the best direction",
  resolve: "rest",
};

const APP: Script = {
  id: "app",
  name: "App",
  icon: "phone",
  prompt: "Rebuild every Seekle screen from source, in the new brand.",
  title: "Rebuild Seekle in Ponzu",
  label:
    "Claude Code rebuilds Seekle, an iPhone game, on the Ponzu canvas from the app's source: its screens, then every one of its animations, looping. You ask about one and it answers. Then it explores the game's feel in twelve animated studies; you comment on two, it combines them into three full directions, and you pick one.",
  beats: [
    { id: "think", ms: 600 },
    { id: "app-page", ms: 300 },
    { id: "app", ms: 2200 },
    { id: "app-look", ms: 3200 },
    { id: "motion-page", ms: 300 },
    { id: "motion", ms: 2500 },
    { id: "motion-look", ms: 2600 },
    { id: "motion-look-2", ms: 1800 },
    ...comment(C0, 700),
    { id: "c0-heard", ms: 800 },
    { id: "c0-reply", ms: 5000 },
    { id: "explore-page", ms: 300 },
    { id: "explore", ms: 2600 },
    { id: "explore-look", ms: 3000 },
    { id: "explore-look-2", ms: 2600 },
    ...comment(C1, 1100),
    ...comment(C2, 700),
    ...comment(C3, 1100),
    { id: "c3-heard", ms: 700 },
    // Claude revises the studies you commented on, then carries them into the directions.
    { id: "rework", ms: 2800 },
    { id: "rework-2", ms: 3200 },
    { id: "rest", ms: 3000 },
  ],
  comments: [C0, C1, C2, C3],
  pages: [
    { design: "pg_app", from: "app-page", beat: "app" },
    { design: "pg_bp3im", from: "motion-page", beat: "motion" },
    { design: "pg_g13sx", from: "explore-page", beat: "explore" },
  ],
  shots: {
    think: { x: -80, y: -110, w: 2490, h: 1060 },
    // Along the five screens.
    "app-look": {
      from: { x: -40, y: -50, w: 964, h: 974 },
      to: { x: 1406, y: -20, w: 980, h: 950 },
    },
    "motion-page": { x: -60, y: -90, w: 1872, h: 2550 },
    // Claiming a handle, then Home, where you ask about it.
    "motion-look": {
      from: { x: -30, y: -50, w: 910, h: 1000 },
      to: { x: 420, y: 280, w: 900, h: 980 },
    },
    "motion-look-2": {
      from: { x: 880, y: 640, w: 910, h: 1000 },
      to: { x: 870, y: 880, w: 910, h: 1000 },
    },
    "explore-page": { x: -60, y: -60, w: 1920, h: 2560 },
    // Along the found-set row, then the three directions.
    "explore-look": {
      from: { x: -20, y: 70, w: 904, h: 500 },
      to: { x: 864, y: 70, w: 904, h: 500 },
    },
    "explore-look-2": {
      from: { x: -20, y: 1500, w: 1000, h: 960 },
      to: { x: 400, y: 1500, w: 1000, h: 960 },
    },
    // Back out to the first two rows to comment, then down to the directions to pick one.
    "c1-cursor": { x: -40, y: 40, w: 1840, h: 1000 },
    "c3-cursor": { x: -60, y: 1440, w: 1500, h: 1040 },
    // In on the studies as Claude rewrites them, then on the directions.
    rework: { x: 260, y: 60, w: 1160, h: 980 },
    "rework-2": { x: -60, y: 1440, w: 1500, h: 1040 },
    rest: { x: -60, y: -60, w: 1920, h: 2560 },
  },
  rework: {
    ab_x_a2: "rework",
    ab_x_b2: "rework",
    ab_x_b3: "rework",
    ab_x_b4: "rework",
    ab_x_d1: "rework-2",
    ab_x_d2: "rework-2",
    ab_x_d3: "rework-2",
  },
  thread: [
    {
      say: "Reading apps/native first, so every size, string and timing comes from the source.",
      at: "think",
    },
    {
      plan: [
        {
          label: "Every screen and animation, from apps/native",
          from: "think",
          to: "explore-page",
        },
        { label: "Game feel: studies and three directions", from: "explore-page", to: "rest" },
      ],
      at: "think",
    },
    { tools: 6, from: "app-page", to: "motion-page" },
    { say: "Five screens up. Now every animation, looping on the canvas.", at: "motion-page" },
    { tools: 4, from: "motion-page", to: "c0-cursor" },
    { tools: 2, from: "c0-cursor", to: "c0-reply" },
    {
      say: "Answered your question on the Motion page: most screens already rise in.",
      at: "c0-reply",
    },
    { tools: 1, from: "c0-reply", to: "explore-page" },
    {
      say: "20 loops, timed from lib/motion.ts. Now the game feel: four takes each on the found set, the score and the clock, and three full screens combining them.",
      at: "explore-page",
    },
    { tools: 5, from: "explore-page", to: "c1-cursor" },
    {
      say: "Everything loops on one 3.2s beat, so they compare fairly. Comment on any of them.",
      at: "c1-cursor",
    },
    { tools: 1, from: "c1-cursor", to: "c3-heard" },
    {
      say: "Three comments. Taking the “found” label and the green off Collect, moving the score to the middle with the clock top right, then carrying both into the directions, D2 first.",
      at: "c3-heard",
    },
    { tools: 4, from: "rework", to: "rest" },
    {
      say: "D2 is the one: no label, no green, a rolling score and a quiet clock. Your notes are resolved, and your question's answered.",
      at: "rest",
    },
  ],
  tools: {
    "app-page": "update page",
    app: "write html",
    "motion-page": "create page",
    motion: "write html",
    "explore-page": "create page",
    explore: "write html",
    rework: "write html",
    "rework-2": "write html",
    "c0-heard": "reply",
  },
};

const C4: Comment = {
  id: "c4",
  board: "ab_w_desktop",
  x: 1323,
  y: 457,
  text: "maybe we could put some user avatars swirling, so the impression is set with friends",
  resolve: "revise-look",
};

const LAUNCH: Script = {
  id: "launch",
  name: "Launch",
  icon: "rocket",
  prompt: "Make Seekle's website hero and App Store screenshots.",
  title: "Launch Seekle",
  label:
    "Claude Code designs Seekle's website hero on the Ponzu canvas, desktop and mobile. You ask for friends round the phone and it adds them, orbiting. Then it makes fifteen App Store screenshots in three directions, from the app's real screens.",
  beats: [
    { id: "think", ms: 900 },
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
  ],
  comments: [C4],
  pages: [
    { design: "pg_ea4v6", from: "web-page", beat: "web" },
    { design: "pg_g1zbi", from: "store-page", beat: "store" },
  ],
  shots: {
    think: { x: -80, y: -110, w: 2080, h: 1290 },
    "web-look": {
      from: { x: -20, y: -40, w: 1480, h: 1000 },
      to: { x: 300, y: 0, w: 1300, h: 900 },
    },
    // On the hero's phone, with room to the right of the pin for the thread.
    "c4-cursor": { x: 380, y: -40, w: 1500, h: 1000 },
    // Pushing in on the friends orbiting it.
    "revise-look": {
      from: { x: 680, y: 40, w: 840, h: 860 },
      to: { x: 750, y: 110, w: 760, h: 780 },
    },
    "store-page": { x: -60, y: -60, w: 2430, h: 3700 },
    // Along the night table, then back along the close-ups.
    "store-look": {
      from: { x: -20, y: 150, w: 1410, h: 1000 },
      to: { x: 900, y: 150, w: 1410, h: 1000 },
    },
    "store-look-2": {
      from: { x: 900, y: 2610, w: 1410, h: 1000 },
      to: { x: -20, y: 2610, w: 1410, h: 1000 },
    },
    rest: { x: -60, y: -60, w: 2430, h: 3700 },
  },
  revision: {
    from: "c4-heard",
    at: "revise",
    boards: { ab_w_desktop: ".orbitD", ab_w_mobile: ".orbitM" },
  },
  thread: [
    {
      say: "Reading apps/web, the store listing and the app's real screens first.",
      at: "think",
    },
    {
      plan: [
        { label: "Website hero, desktop and mobile", from: "think", to: "store-page" },
        { label: "App Store screenshots, three directions", from: "store-page", to: "rest" },
      ],
      at: "think",
    },
    { tools: 3, from: "web-page", to: "c4-cursor" },
    { tools: 1, from: "c4-cursor", to: "c4-heard" },
    {
      say: "New comment on the hero. Five friends will orbit the phone: behind it at the top, in front at the bottom.",
      at: "c4-heard",
    },
    { tools: 3, from: "revise", to: "store-page" },
    { say: "Orbiting on desktop and mobile. Next, the App Store screenshots.", at: "store-page" },
    { tools: 4, from: "store-page", to: "rest" },
    {
      say: "Done: night table, ink panorama and close-up, five frames each, built from the real screens. Your comment's resolved.",
      at: "rest",
    },
  ],
  tools: {
    "web-page": "update page",
    web: "write html",
    revise: "write html",
    "store-page": "create page",
    store: "write html",
  },
};

const EXPLAIN_NOTE: Comment = {
  id: "c6",
  board: "ab_eudqi",
  x: 1300,
  y: 690,
  text: "can you show how the streak gets worked out here too",
  resolve: "revise-look",
};

const EXPLAIN: Script = {
  id: "explain",
  name: "Explain",
  icon: "flow",
  prompt: "Draw how a Seekle game is dealt and scored, from the code.",
  title: "How a Seekle game works",
  label:
    "Claude Code reads Seekle's source and draws how a game works on the Ponzu canvas: a seed minted on the phone, a deck shuffled from it, sixteen cards dealt with a set among them, three minutes of play, and the server re-checking every set, with the three tables a game lands in. You ask for the streak; Claude adds its rule.",
  beats: [
    { id: "think", ms: 900 },
    { id: "explain-page", ms: 300 },
    { id: "explain", ms: 2600 },
    { id: "explain-look", ms: 5200 },
    { id: "explain-look-2", ms: 2800 },
    ...comment(EXPLAIN_NOTE, 1100),
    { id: "c6-heard", ms: 900 },
    { id: "revise", ms: 2400 },
    { id: "revise-look", ms: 3200 },
    { id: "rest", ms: 3400 },
  ],
  comments: [EXPLAIN_NOTE],
  pages: [{ design: "pg_2hkky", from: "explain-page", beat: "explain" }],
  shots: {
    think: { x: -80, y: -110, w: 1920, h: 1230 },
    // Along the five steps, then down to where a game lands.
    "explain-look": {
      from: { x: -40, y: -20, w: 1000, h: 760 },
      to: { x: 780, y: -20, w: 1000, h: 760 },
    },
    "explain-look-2": { x: 0, y: 560, w: 1780, h: 520 },
    // On account_stats, with room to the right of the pin for the thread.
    "c6-cursor": { x: 740, y: 470, w: 1180, h: 640 },
    revise: { x: 1000, y: 560, w: 900, h: 520 },
    "revise-look": {
      from: { x: 1120, y: 640, w: 680, h: 420 },
      to: { x: 1160, y: 680, w: 600, h: 380 },
    },
    rest: { x: -80, y: -110, w: 1920, h: 1230 },
  },
  revision: { from: "c6-heard", at: "revise", boards: { ab_eudqi: ".streak" } },
  thread: [
    {
      say: "Reading lib/game, app/game.tsx and the Supabase migrations, so every step names the code that does it.",
      at: "think",
    },
    {
      plan: [
        {
          label: "Trace a game through lib/game and record_play",
          from: "think",
          to: "explain-page",
        },
        { label: "Draw it, seed to score", from: "explain-page", to: "c6-cursor" },
        { label: "Your notes", from: "c6-cursor", to: "rest" },
      ],
      at: "think",
    },
    { tools: 5, from: "explain-page", to: "c6-cursor" },
    {
      say: "Five steps from seed to score, each naming its file, and the three tables a game lands in.",
      at: "c6-cursor",
    },
    { tools: 1, from: "c6-cursor", to: "c6-heard" },
    { say: "Adding complete_play's streak rule to account_stats.", at: "c6-heard" },
    { tools: 2, from: "revise", to: "rest" },
    {
      say: "Done: +1 after yesterday, the same on a day already counted, back to 1 after a gap. Your comment's resolved.",
      at: "rest",
    },
  ],
  tools: { "explain-page": "update page", explain: "write html", revise: "write html" },
};

const OPERATE_NOTE: Comment = {
  id: "c7",
  board: "ab_vfzez",
  x: 646,
  y: 560,
  text: "nice. can you mark the day 1.6 went out?",
  resolve: "revise-look",
};

const OPERATE: Script = {
  id: "operate",
  name: "Operate",
  icon: "chart",
  prompt: "Turn last week's players and reviews into a one-page update.",
  title: "Seekle weekly update",
  label:
    "Claude Code turns a week of Seekle's players, streaks and App Store reviews into a one-page update on the Ponzu canvas: four numbers, players a day, streaks, three reviews and next week's plan. You ask it to mark the day version 1.6 shipped; Claude adds the marker to the chart.",
  beats: [
    { id: "think", ms: 900 },
    { id: "operate-page", ms: 300 },
    { id: "operate", ms: 2600 },
    { id: "operate-look", ms: 4800 },
    { id: "operate-look-2", ms: 3000 },
    ...comment(OPERATE_NOTE, 1100),
    { id: "c7-heard", ms: 900 },
    { id: "revise", ms: 2400 },
    { id: "revise-look", ms: 3200 },
    { id: "rest", ms: 3400 },
  ],
  comments: [OPERATE_NOTE],
  pages: [{ design: "pg_935z0", from: "operate-page", beat: "operate" }],
  shots: {
    think: { x: -80, y: -90, w: 1360, h: 1420 },
    // Down the numbers and the charts, then the reviews.
    "operate-look": {
      from: { x: -20, y: -20, w: 900, h: 780 },
      to: { x: 320, y: 280, w: 900, h: 780 },
    },
    "operate-look-2": { x: -20, y: 760, w: 1240, h: 520 },
    // Back up to the chart, with room to the right of the pin for the thread.
    "c7-cursor": { x: -20, y: 260, w: 1240, h: 760 },
    revise: { x: 160, y: 300, w: 900, h: 640 },
    "revise-look": {
      from: { x: 340, y: 360, w: 620, h: 480 },
      to: { x: 400, y: 380, w: 540, h: 420 },
    },
    rest: { x: -80, y: -90, w: 1360, h: 1420 },
  },
  revision: { from: "c7-heard", at: "revise", boards: { ab_vfzez: ".release" } },
  thread: [
    {
      say: "Pulling the week from plays, daily_bests and account_stats, and the new App Store reviews.",
      at: "think",
    },
    {
      plan: [
        {
          label: "The week, from Supabase and App Store Connect",
          from: "think",
          to: "operate-page",
        },
        {
          label: "One page: numbers, streaks, reviews, next week",
          from: "operate-page",
          to: "c7-cursor",
        },
        { label: "Your notes", from: "c7-cursor", to: "rest" },
      ],
      at: "think",
    },
    { tools: 5, from: "operate-page", to: "c7-cursor" },
    {
      say: "3,912 players, up 14%, mostly from invites. Three reviews stand for the 46, and next week's plan follows from them.",
      at: "c7-cursor",
    },
    { tools: 1, from: "c7-cursor", to: "c7-heard" },
    { say: "Marking Tuesday, when 1.6 shipped offline play.", at: "c7-heard" },
    { tools: 2, from: "revise", to: "rest" },
    { say: "Done: 1.6 is marked on Tuesday's bar. Your comment's resolved.", at: "rest" },
  ],
  tools: { "operate-page": "update page", operate: "write html", revise: "write html" },
};

/** The tabs, in the order Seekle's life goes: brand it, build it, launch it, explain it, run it. */
export const SCRIPTS: Script[] = [BRAND, APP, LAUNCH, EXPLAIN, OPERATE];

/** Where a beat sits in its script, or -1. */
export const indexIn = (s: Script, id: string) => s.beats.findIndex((b) => b.id === id);

/** How long a script runs, in ms. */
export const lengthOf = (s: Script) => s.beats.reduce((sum, b) => sum + b.ms, 0);

/**
 * The stories the demo plays and how long each runs, one a tab. Phones play each as a video
 * recorded from the live demo (scripts/record-demo.ts), one per story and color scheme.
 */
export const STORIES = SCRIPTS.map((s) => ({ id: s.id, ms: lengthOf(s), label: s.label }));
