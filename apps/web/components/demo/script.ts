/**
 * The product demo's story, as a timeline. Each beat changes what the scene shows; the scene is a
 * pure function of the current beat plus how far into it we are.
 *
 * The file starts as Ponzu makes it: one empty "Page 1". You ask Claude for a brand, a landing
 * page and an app. It names that page Brand and draws the logo, adds a Landing page with a hero and
 * three directions, then an App page with four screens, and recommends a direction. You pin one
 * comment on the one you like; Claude makes exactly that change and resolves the thread, which
 * takes the pin off the canvas. As in the app, it doesn't reply to a change it simply made.
 */

export const PROMPT =
  "Design Fernwood, our houseplant shop: a logo, a landing page with a few directions, and the iOS app.";
export const COMMENT = "Love this one. Can we feature the Autumn Drop up top?";

export type BeatId =
  | "idle"
  | "type"
  | "send"
  | "think"
  | "brand-page"
  | "logo"
  | "palette"
  | "landing-page"
  | "hero"
  | "variants"
  | "app-page"
  | "app"
  | "shot"
  | "recommend"
  | "listen"
  | "cursor"
  | "click"
  | "comment"
  | "post"
  | "heard"
  | "revise"
  | "resolve"
  | "rest";

export interface Beat {
  id: BeatId;
  ms: number;
}

export const TYPING_MS = { type: 22, comment: 38 } as const;
export const TYPE_BEAT_MS = PROMPT.length * TYPING_MS.type + 250;

export const BEATS: Beat[] = [
  { id: "idle", ms: 700 },
  { id: "type", ms: TYPE_BEAT_MS },
  { id: "send", ms: 500 },
  { id: "think", ms: 1000 },
  { id: "brand-page", ms: 1000 },
  { id: "logo", ms: 3800 },
  { id: "palette", ms: 3400 },
  { id: "landing-page", ms: 800 },
  { id: "hero", ms: 4200 },
  { id: "variants", ms: 4400 },
  { id: "app-page", ms: 800 },
  { id: "app", ms: 4600 },
  { id: "shot", ms: 800 },
  { id: "recommend", ms: 2400 },
  { id: "listen", ms: 600 },
  { id: "cursor", ms: 1300 },
  { id: "click", ms: 450 },
  { id: "comment", ms: COMMENT.length * TYPING_MS.comment + 300 },
  { id: "post", ms: 700 },
  { id: "heard", ms: 900 },
  { id: "revise", ms: 2400 },
  { id: "resolve", ms: 1300 },
  { id: "rest", ms: 3600 },
];

export const LAST = BEATS.length - 1;
export const index = (id: BeatId) => BEATS.findIndex((b) => b.id === id);
