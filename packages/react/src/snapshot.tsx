/**
 * Each board's representation on the canvas, one of three tiers:
 *
 * - **live**: its DOM, rendered. lod.ts and motion.ts keep it cheap: tiny
 *   animations hold still, big animated SVGs run as an image of themselves.
 * - **picture**: below a size on screen, a picture of the board instead, and
 *   the live DOM skips rendering under `content-visibility: hidden`. That
 *   drops its layers, animation ticks, image decodes and raster, while layout
 *   still answers when asked, so fit-content measurement, pins and selection
 *   boxes keep working. Hit-testing thaws the board for the one synchronous
 *   call. Its motion keeps going over the picture: looping animation as the
 *   server's filmed loops (loops.tsx), and its videos as videos.
 * - **away**: outside the viewport and a margin, nothing: the DOM skips
 *   rendering and no picture shows.
 *
 * A small board with motion big enough to see stays live only while that
 * motion can't play over its picture: its loops are still being filmed, or
 * it has none the server could film.
 *
 * Pictures come from the server (`/api/snapshot`), made in the background and
 * cached on disk by content, so a design opens to pictures the second time.
 * On a cold open a board waits as a placeholder (or goes live, when it's
 * cheap; or shows a skeleton of its DOM) until its picture comes. Each picture
 * is decoded before it's shown, and the outgoing representation goes a frame
 * after the incoming one is drawn, so nothing pops.
 */

import { boardVersion } from "@ponzu/core";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { SKELETON_CSS } from "./coldopen.ts";
import {
  handoffToVideos,
  LoopLayer,
  type Loops,
  playing,
  syncLiveToVideos,
  useLoops,
} from "./loops.tsx";
import { warm } from "./motion.ts";

/** Below this many device px per CSS px, a board is a picture. */
export const PICTURE_SCALE = 0.5;
/** A picture comes back as a picture below this (hysteresis). */
export const PICTURE_AGAIN = PICTURE_SCALE * 0.8;
/**
 * A board whose biggest looping animation is at least this many device px on
 * screen has motion worth seeing: it stays live unless its loops can play it.
 */
export const MOTION_PX = 64;
/** Picture resolutions, device px per CSS px. The renderer goes no lower than 0.25. */
export const BUCKETS = [0.25, 0.5, 1] as const;
/** How long a board that just mounted waits before it goes live. */
const OPEN_SETTLE_MS = 120;
/** How long the camera rests, after it counts as stopped, before a picture thaws. */
const THAW_REST_MS = 350;
/** Fetches in flight at once: a missing picture answers at once (202), so these are short. */
const PARALLEL = 8;
/** How long to wait before asking again for a picture being made. */
const MISSING_RETRY_MS = 700;
/** A picture drawn before its fonts or images came (x-pz-partial) is asked for again after this. */
const PARTIAL_RETRY_MS = 30_000;
/** A board with no picture this long after mounting shows something else meanwhile. */
const MISSING_AFTER_MS = 250;
/** Longest wait before asking again after the server failed or couldn't be reached. */
const FAILED_RETRY_MAX_MS = 60_000;

export type Tier = "live" | "picture" | "away";

/** The smallest picture resolution that isn't upscaled at this scale. */
export function bucketFor(scale: number): number {
  for (const b of BUCKETS) if (b >= scale) return b;
  return BUCKETS[BUCKETS.length - 1]!;
}

/**
 * Which representation a board wants. `scale` is device px per CSS px;
 * `current` is what it shows now (for hysteresis); `motion` is the device px
 * of its biggest looping animation, and `looped` whether loops can play it
 * over the picture. `pictured` says a picture of it is decoded and at hand.
 * Without `pictures` (no renderer), a board on screen is always live.
 */
export function tierFor(o: {
  scale: number;
  current: Tier;
  onScreen: boolean;
  pictures: boolean;
  pictured: boolean;
  motion: number;
  looped: boolean;
  moving: boolean;
  attention: boolean;
}): Tier {
  if (o.attention) return "live";
  if (!o.onScreen) return "away";
  if (!o.pictures) return "live";
  // Thawing a whole board mid-gesture costs a frame or more (its images decode again):
  // a picture, or a board coming back on screen with one at hand, waits for the camera
  // to stop, even if it's a little soft until then.
  if (o.moving && o.current !== "live" && o.pictured) return "picture";
  if (o.scale >= (o.current === "picture" ? PICTURE_SCALE : PICTURE_AGAIN)) return "live";
  // Small, unless it has motion big enough to see that the picture can't play. Not
  // mid-gesture, though: motion holds still while the camera moves anyway (lod.ts), and a
  // picture is far cheaper to move.
  return o.motion >= MOTION_PX && !o.looped && !o.moving ? "live" : "picture";
}

/** A short, stable name for a string (FNV-1a, 32 bits, base 36). */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface Picture {
  url: string;
  /** Which version of the board it shows (the `v` it was asked for). */
  version: string;
  /** The board has animation that loops forever, which loops may film. */
  loops: boolean;
  /** The longest side, in CSS px, of the board's biggest looping animation. */
  loopSize: number;
  /** Drawn before its fonts or images came: shown until a full one replaces it. */
  partial?: boolean;
}

/** Not made yet: the server is making it, at the front of its queue. */
const MISSING = "missing" as const;
/** The server erred or couldn't be reached: not kept, asked again later, less often each time. */
const FAILED = "failed" as const;
type Loaded = Picture | null | typeof MISSING | typeof FAILED;

/**
 * What a picture response means before its body is read: "draw" it; MISSING
 * when it's still being made, or was made for another version (an edit raced
 * it); FAILED when the server errs (5xx, 429); null when there's none to have,
 * for good (no renderer, no such board).
 */
export function pictureAnswer(
  res: Pick<Response, "status" | "ok" | "headers">,
  asked: string | null,
): "draw" | typeof MISSING | typeof FAILED | null {
  const made = res.headers.get("x-pz-version");
  if (res.status === 202 || (res.ok && made && asked && made !== asked)) return MISSING;
  if (res.status >= 500 || res.status === 429) return FAILED;
  return res.ok ? "draw" : null;
}

/** Pictures by URL, least recently asked for first. */
const pictures = new Map<string, Promise<Loaded>>();
/** What each settled picture's blob is, by URL: to let it go when it's dropped. */
const blobs = new Map<string, string>();
/** Enough for a few pages' boards at every bucket; each one kept is a decoded JPEG. */
export const PICTURES_KEPT = 256;
/** Blobs some board shows now, and how many boards: never let go. */
const shown = new Map<string, number>();

/** Hold a picture while a board shows it, so the cache doesn't let it go; returns a release. */
export function holdPicture(blob: string): () => void {
  shown.set(blob, (shown.get(blob) ?? 0) + 1);
  return () => {
    const n = (shown.get(blob) ?? 1) - 1;
    if (n > 0) shown.set(blob, n);
    else shown.delete(blob);
  };
}

/**
 * Of `keys`, least recently used first, the ones to drop to get down to `cap`:
 * never one `kept` says to keep.
 */
export function overCap<K>(
  keys: Iterable<K>,
  size: number,
  cap: number,
  kept: (k: K) => boolean,
): K[] {
  const out: K[] = [];
  for (const k of keys) {
    if (size - out.length <= cap) break;
    if (!kept(k)) out.push(k);
  }
  return out;
}

/** Let a picture go so the next ask fetches it again, once no board shows it. */
function forget(src: string) {
  const blob = blobs.get(src);
  pictures.delete(src);
  blobs.delete(src);
  if (blob && !shown.has(blob)) URL.revokeObjectURL(blob);
}

/** Mark `src` as just used; past the cap, drop the least recently used that no board shows. */
function keep(src: string, p: Promise<Loaded>) {
  pictures.delete(src);
  pictures.set(src, p);
  // Still loading (no blob yet), or on screen: kept.
  const drop = overCap(pictures.keys(), pictures.size, PICTURES_KEPT, (k) => {
    const blob = blobs.get(k);
    return !blob || shown.has(blob);
  });
  for (const k of drop) {
    pictures.delete(k);
    URL.revokeObjectURL(blobs.get(k)!);
    blobs.delete(k);
  }
}

const queue: (() => void)[] = [];
let running = 0;

function next() {
  while (running < PARALLEL && queue.length) {
    running++;
    queue.shift()!();
  }
}

/**
 * Fetch and decode a picture, once per URL. Resolves to null when the server
 * can't draw one (no renderer), to MISSING when it hasn't yet (it's making
 * it), and to FAILED when it erred, couldn't be reached or sent a picture that
 * won't decode. Neither of the last two is kept: a later call asks again.
 * `first` jumps the queue.
 */
function loadPicture(src: string, first = false): Promise<Loaded> {
  const hit = pictures.get(src);
  if (hit) {
    keep(src, hit);
    return hit;
  }
  const p = new Promise<Loaded>((resolve) => {
    const run = async () => {
      let url: string | undefined;
      try {
        const res = await fetch(`${src}&wait=0`);
        const asked = new URL(src, location.href).searchParams.get("v");
        const answer = pictureAnswer(res, asked);
        if (answer !== "draw") {
          if (answer !== null) pictures.delete(src);
          return resolve(answer);
        }
        const loops = res.headers.get("x-pz-loops") === "1";
        const loopSize = Number(res.headers.get("x-pz-loop-size")) || 0;
        url = URL.createObjectURL(await res.blob());
        const img = new Image();
        img.src = url;
        await img.decode();
        blobs.set(src, url);
        // Drawn before its fonts or images came: shown, but not this URL's for good.
        const partial = res.headers.get("x-pz-partial") === "1";
        if (partial) setTimeout(() => forget(src), PARTIAL_RETRY_MS);
        resolve({ url, version: asked ?? "", loops, loopSize, partial });
      } catch {
        // No server, a dropped connection or a picture that won't decode: for now, not for good.
        if (url) URL.revokeObjectURL(url);
        pictures.delete(src);
        resolve(FAILED);
      } finally {
        running--;
        next();
      }
    };
    if (first) queue.unshift(run);
    else queue.push(run);
    next();
  });
  keep(src, p);
  return p;
}

/**
 * Elements a frame may bring live. A board over it gets a frame to itself;
 * smaller ones share. A camera that stops over a page of heavy boards then
 * pays for one per frame, nearest the middle first, not all of them in one.
 */
export const THAW_BUDGET = 4000;

interface Thaw {
  go: () => void;
  /** Lower first: distance from the middle of the view. */
  rank: number;
  cost: number;
}

const thawing: Thaw[] = [];
let thawFrame = 0;

/** Which queued thaws run this frame: nearest first, up to the budget, always at least one. */
export function takeThaws<T extends { rank: number; cost: number }>(
  queue: T[],
  budget: number,
): T[] {
  queue.sort((a, b) => a.rank - b.rank);
  let spent = 0;
  let n = 0;
  while (n < queue.length && (n === 0 || spent + queue[n]!.cost <= budget))
    spent += queue[n++]!.cost;
  return queue.splice(0, n);
}

function thawTick() {
  thawFrame = 0;
  for (const t of takeThaws(thawing, THAW_BUDGET)) t.go();
  if (thawing.length) thawFrame = requestAnimationFrame(thawTick);
}

/** Run `go` in a coming frame, nearest first, within a frame's budget. Returns a cancel. */
function thawSlot(go: () => void, rank: () => number, cost: number): () => void {
  const t = { go, rank: rank(), cost };
  thawing.push(t);
  if (!thawFrame) thawFrame = requestAnimationFrame(thawTick);
  return () => {
    const i = thawing.indexOf(t);
    if (i >= 0) thawing.splice(i, 1);
  };
}

/** Loops are filmed at 1 device px per CSS px: drawn bigger they'd blur. */
const LOOPS_FILMED_AT = 1;
/**
 * A loop region moving this many parts is a mass of animation: live, it's a
 * composited layer per part, or (motion.ts) an animated SVG image repainted
 * and re-rastered whole every frame, tens of MB/s of garbage.
 */
export const MASS = 48;
/** Looping animations a board may run live while its loops could play them instead. */
export const LIVE_LOOPS = 1000;
/** The pointer rests on a board this long before it goes live for hover. */
const INTENT_MS = 80;
/** And it goes back to its picture this long after the pointer leaves. */
const LEAVE_MS = 1200;

/**
 * Whether a board that would be live stays a picture with its loops playing
 * over it. Its loops look the same, keep moving and cost a video each; live,
 * a mass of animation costs layers, paint and garbage every frame, and most
 * of a second to thaw. So it goes live only for what the loops can't do:
 * hover (`intent`, the pointer resting on it), `attention`, or drawn bigger
 * than they were filmed. Boards with a little motion (a spinner, a caret)
 * stay live: cheap, and their motion doesn't wait for a video.
 */
export function holdsForLoops(o: {
  regions: { ids: string[] }[];
  scale: number;
  attention: boolean;
  intent: boolean;
}): boolean {
  if (!o.regions.length || o.attention || o.intent || o.scale >= LOOPS_FILMED_AT) return false;
  let n = 0;
  for (const r of o.regions) {
    if (r.ids.length >= MASS) return true;
    n += r.ids.length;
  }
  return n > LIVE_LOOPS;
}

/** Run `f` with a board's live DOM rendering, e.g. to hit-test it. */
export function thawed<T>(el: HTMLElement | null | undefined, f: () => T): T {
  if (!el || el.style.contentVisibility !== "hidden") return f();
  el.style.contentVisibility = "visible";
  try {
    return f();
  } finally {
    el.style.contentVisibility = "hidden";
  }
}

/**
 * A board's tier, its picture and its loops. The tier only turns to
 * "picture" once a picture for this version is decoded, and every change
 * waits a frame, so the incoming representation is on screen before the
 * outgoing one goes. A board that loops gets its loops too, and turns into a
 * picture only once they're ready to play, so it never stops moving.
 */
function useTier(opts: {
  id: string;
  scale: number;
  onScreen: boolean;
  moving: boolean;
  attention: boolean;
  snapshotUrl?: (id: string, scale: number) => string;
  loopsUrl?: (id: string) => string;
  /** Cheap enough to show live while its picture is missing. */
  cheap?: boolean;
  /** Its distance from the middle of the view: nearer boards go live first. Asked when it queues. */
  rank?: () => number;
  /** What going live costs, in elements. */
  cost?: number;
  /** The pointer rests on it: hover states need it live, even when its loops could play it. */
  intent?: boolean;
}): { tier: Tier | "pending"; picture: Picture | null; loops: Loops | null; missing: boolean } {
  // The URL functions may be new every render: the effects go by the URLs they make.
  const { id, scale, onScreen, moving, attention, snapshotUrl, loopsUrl, cheap } = opts;
  // Read when a slot is taken, not effect dependencies.
  const order = useRef({ rank: opts.rank, cost: opts.cost ?? 0 });
  order.current = { rank: opts.rank, cost: opts.cost ?? 0 };
  const rank = () => order.current.rank?.() ?? 0;
  // Every board starts hidden, and goes live a frame later if it's big enough.
  // The page fits its camera in between, so a board that opens small never
  // pays for images, layers and raster nobody can see: it waits, hidden, for
  // its picture.
  const [tier, setTier] = useState<Tier | "pending">(() =>
    snapshotUrl && !attention ? "pending" : "live",
  );
  const [held, setPicture] = useState<Picture | null>(null);
  // Only a picture of the board as it is now: after an edit, the one it had shows what was undone.
  const now = snapshotUrl ? versionIn(snapshotUrl(id, 1)) : "";
  const picture = held && held.version === now ? held : null;
  const [failed, setFailed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  /** Asks in a row the server failed: the next waits longer. */
  const failures = useRef(0);
  const pictureRef = useRef<Picture | null>(null);
  pictureRef.current = picture;
  const bucket = bucketFor(scale);
  const up = bucketFor(bucket * 1.01);
  // Only boards near or below the line need a picture; big live ones don't.
  // One that loops may stay a picture up to the scale its loops were filmed at.
  const near = scale <= (picture?.loops ? LOOPS_FILMED_AT : PICTURE_SCALE * 1.5);
  const src = snapshotUrl && near ? snapshotUrl(id, bucket) : "";
  // Promote early: past 70% of this bucket, fetch the next one up too.
  const upSrc =
    snapshotUrl && near && up > bucket && scale > bucket * 0.7 ? snapshotUrl(id, up) : "";
  // Loops: asked for once the board is known to loop and is drawn small.
  const loopState = useLoops(
    loopsUrl && picture?.loops && scale < LOOPS_FILMED_AT ? loopsUrl(id) : null,
  );
  const loops = loopState && loopState !== "pending" ? loopState : null;
  const current: Tier = tier === "pending" ? "picture" : tier;
  let want = tierFor({
    scale,
    current,
    onScreen,
    pictures: !!snapshotUrl && !failed,
    pictured: !!picture,
    // The picture says how big its motion is. Until then it's taken as still, so a
    // board that opens small doesn't go live just to find out.
    motion: (picture?.loopSize ?? 0) * scale,
    looped: !!loops,
    moving,
    attention,
  });
  // A mass of looping animation stays a picture with its loops playing over it,
  // until the pointer rests on it, it has attention, or it's drawn close up.
  if (
    want === "live" &&
    picture &&
    loops &&
    holdsForLoops({ regions: loops.regions, scale, attention, intent: !!opts.intent })
  )
    want = "picture";
  // No picture yet: a cheap board is live meanwhile; others wait as a placeholder.
  if (want === "picture" && !picture && missing && cheap) want = "live";
  // A picture that hasn't come soon after mount counts as missing, whatever
  // the server says: on a cold open it's busy drawing, and even its "not
  // yet" can take a while.
  useEffect(() => {
    if (!src) return;
    const timer = setTimeout(() => setMissing((m) => m || !pictureRef.current), MISSING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [src]);
  useEffect(() => {
    if (!src) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (upSrc) void loadPicture(upSrc);
    void loadPicture(src, onScreen).then((p) => {
      if (!live) return;
      if (p === MISSING || p === FAILED) {
        setMissing(true);
        failures.current = p === FAILED ? failures.current + 1 : 0;
        const wait = MISSING_RETRY_MS * 2 ** failures.current;
        timer = setTimeout(() => setRetry((n) => n + 1), Math.min(FAILED_RETRY_MAX_MS, wait));
        return;
      }
      failures.current = 0;
      if (!p) return setFailed(true);
      setMissing(false);
      setPicture((cur) => (cur?.url === p.url ? cur : p));
      // Drawn too early: kept on screen, and asked for again once it's let go (just after).
      if (p.partial) timer = setTimeout(() => setRetry((n) => n + 1), PARTIAL_RETRY_MS + 50);
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [src, upSrc, bucket, up, onScreen, retry]);
  useEffect(() => {
    if (want === tier) return;
    if (want === "picture" && !picture) return;
    // A live board that loops stays live until its loops are ready to play.
    if (
      want === "picture" &&
      tier === "live" &&
      picture?.loops &&
      loopsUrl &&
      loopState === "pending"
    )
      return;
    // Leaving "pending" waits out the page's first camera fit, so a board that
    // opens small doesn't go live for a frame and start loading everything.
    if (tier === "pending") {
      const timer = setTimeout(() => setTier(want), OPEN_SETTLE_MS);
      return () => clearTimeout(timer);
    }
    // Going live thaws a whole board: spread over frames, nearest first, so a
    // camera that stops over many boards doesn't pay for all of them in one. From a
    // picture, only once the camera has rested a moment: a gesture that
    // pauses and goes on would pay for the thaw mid-gesture. Attention (an
    // agent's work arriving, a selection) needs it now.
    if (want === "live") {
      const go = () => setTier("live");
      if (tier !== "picture" || (attention && !moving))
        return thawSlot(go, rank, order.current.cost);
      let cancel = () => {};
      const timer = setTimeout(() => {
        cancel = thawSlot(go, rank, order.current.cost);
      }, THAW_REST_MS);
      return () => {
        clearTimeout(timer);
        cancel();
      };
    }
    const raf = requestAnimationFrame(() => setTier(want));
    return () => cancelAnimationFrame(raf);
  }, [want, tier, picture, loopState, loopsUrl, attention, moving]);
  // The picture this board has stays decoded while it has it.
  const pictureUrl = picture?.url;
  useEffect(() => (pictureUrl ? holdPicture(pictureUrl) : undefined), [pictureUrl]);
  return { tier, picture, loops, missing };
}

/** The version a picture URL asks for (its `v`). */
function versionIn(url: string): string {
  return /[?&]v=([^&#]*)/.exec(url)?.[1] ?? "";
}

/**
 * What an artboard looks like, as a short name: the server's own (boardVersion), so the picture
 * it says it drew (`x-pz-version`) is the one asked for.
 */
const versions = new WeakMap<object, { tokens: string; v: string }>();
export function versionOf(ab: object, tokens: string, serialize: () => string): string {
  const hit = versions.get(ab);
  if (hit && hit.tokens === tokens) return hit.v;
  const v = boardVersion(serialize(), tokens);
  versions.set(ab, { tokens, v });
  return v;
}

/** Where the pointer last was, page-wide: a move that doesn't change it isn't the person's. */
let pointerAt = { x: Number.NaN, y: Number.NaN };

/**
 * Whether the person is pointing at a board: the pointer moved over it and
 * has rested there {@link INTENT_MS}, until {@link LEAVE_MS} after it leaves
 * (like a field's image, motion.ts). Only real moves with the camera still
 * count: Chromium sends a pointer event at the same spot when content moves
 * under a resting pointer, and a zoom that ends over a board isn't pointing
 * at it.
 */
function useIntent(moving: boolean) {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const move = (e: React.PointerEvent) => {
    const moved = e.clientX !== pointerAt.x || e.clientY !== pointerAt.y;
    pointerAt = { x: e.clientX, y: e.clientY };
    if (!moved || moving || e.pointerType === "touch") return;
    clearTimeout(timer.current);
    if (!on) timer.current = setTimeout(() => setOn(true), INTENT_MS);
  };
  const leave = () => {
    clearTimeout(timer.current);
    if (on) timer.current = setTimeout(() => setOn(false), LEAVE_MS);
  };
  return { on, move, leave };
}

/** What a board draws: "thaw" is live DOM rendering under its picture, for a frame or two. */
type Shown = Tier | "pending" | "thaw";

/**
 * How long a picture takes to fade in over its live board, or out from over
 * it. The browser draws text a little differently than the renderer that made
 * the picture (2 or 3 levels in 255 on a text-heavy board, whatever the
 * picture's quality), so a cut between them shows: faded over 7 frames, no
 * frame changes by more than a level or so.
 */
const FADE_MS = 120;

/**
 * A board's content in its tier: live DOM; a picture, its loops and its
 * videos over the same DOM kept in layout but not rendered; nothing, away; or
 * a placeholder while a picture is being made. `children` is told whether
 * the DOM is hidden, so it can stop what rendering wouldn't.
 */
export function TieredBoard(props: {
  id: string;
  w: number;
  h: number;
  scale: number;
  onScreen: boolean;
  moving: boolean;
  attention: boolean;
  snapshotUrl?: (id: string, scale: number) => string;
  loopsUrl?: (id: string) => string;
  cheap?: boolean;
  rank?: () => number;
  cost?: number;
  /** May show as a skeleton (live DOM, media hidden, no motion) while its picture is missing. */
  skeleton?: boolean;
  /** What a placeholder fills with. */
  fill?: string;
  children: (hidden: boolean) => ReactNode;
}) {
  const intent = useIntent(props.moving);
  const { tier, picture, loops, missing } = useTier({ ...props, intent: intent.on });
  const host = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  const want: Shown =
    tier === "picture" && picture ? "picture" : tier === "picture" ? "pending" : tier;
  // What's drawn: lags `want` while loop videos line up with the live board.
  const [shown, setShown] = useState<Shown>(want);
  // The picture fading in over the live board ("in") or out from over it ("out"), into `of`.
  const [fade, setFade] = useState<{ kind: "in" | "out"; of: Shown } | null>(null);
  const moving = useRef(props.moving);
  moving.current = props.moving;
  const show = (next: Shown, kind?: "in" | "out") => {
    setShown(next);
    setFade(kind && !moving.current ? { kind, of: next } : null);
  };
  const fading = fade && fade.of === shown && !props.moving ? fade.kind : null;
  const root = () => host.current?.querySelector("[data-artboard-host]")?.shadowRoot;
  // Live to picture with loops: hand off in phase. Picture to live: thaw the
  // live DOM under the picture first, so it's laid out, drawn and in phase
  // before the picture goes. Either way the picture fades, over the live
  // board, unless the camera moves. Everything else swaps now.
  useEffect(() => {
    if (want === shown) return;
    if (want === "live" && shown === "picture" && picture) {
      show("thaw");
      return;
    }
    if (shown === "thaw" && want !== "live") {
      show(want);
      return;
    }
    if (shown === "thaw") {
      // Animations under content-visibility: hidden hold still, and resume on
      // their own clock a frame after the subtree shows: set their time then,
      // with the picture and videos still on top, and start the fade in the same task.
      let f2 = 0;
      const f1 = requestAnimationFrame(() => {
        f2 = requestAnimationFrame(() => {
          syncLiveToVideos(root(), layer.current);
          flushSync(() => show("live", "out"));
        });
      });
      return () => {
        cancelAnimationFrame(f1);
        cancelAnimationFrame(f2);
      };
    }
    if (want === "picture" && shown === "live" && loops && layer.current) {
      let off = false;
      void handoffToVideos(
        root(),
        layer.current,
        loops,
        () => flushSync(() => show("picture", "in")),
        () => off,
      );
      return () => {
        off = true;
      };
    }
    show(want, want === "picture" && shown === "live" ? "in" : undefined);
  }, [want, shown, loops, picture]);
  const cover = useRef<HTMLDivElement>(null);
  // Stepped from script, not a Web Animation: an animation lifts the picture onto a layer of
  // its own, drawn a little differently, so its first and last frames would show a change.
  useLayoutEffect(() => {
    const el = cover.current;
    if (!el) return;
    // One turned around halfway goes back from where it is, in the time that takes.
    const from = el.style.opacity ? Number(el.style.opacity) : null;
    if (!fading) {
      el.style.opacity = "";
      return;
    }
    const to = fading === "in" ? 1 : 0;
    const start = from ?? 1 - to;
    const duration = FADE_MS * Math.abs(to - start);
    el.style.opacity = String(start);
    // The frame that swaps draws the live board (or stops drawing it) and takes a while: the
    // fade counts from the one after, so its own frames are even.
    let began = 0;
    let frame = 0;
    const step = (now: number) => {
      began ||= now;
      const k = duration ? Math.min(1, (now - began) / duration) : 1;
      el.style.opacity = String(start + (to - start) * k);
      if (k < 1) frame = requestAnimationFrame(step);
      else setFade(null);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [fading]);
  // A camera move finishes a fade at once, and it doesn't start again after.
  useEffect(() => {
    if (props.moving) setFade(null);
  }, [props.moving]);
  // A picture board that moves gets its animations made while the camera rests,
  // so going live (hover, or zooming in) doesn't pay for that in one frame.
  const warmable = shown === "picture" && !!loops?.regions.length && !props.moving;
  useEffect(() => {
    if (!warmable) return;
    const idle = globalThis.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200));
    const cancel = globalThis.cancelIdleCallback ?? clearTimeout;
    const id = idle(() => thawed(host.current, () => warm(root())), { timeout: 2000 });
    return () => cancel(id as number);
  }, [warmable]);
  // While thawing, the picture and its videos stay on top of the live DOM; fading out, too.
  const still = (shown === "picture" || shown === "thaw") && picture;
  const covered = Boolean(still || (fading === "out" && picture));
  // Cold, with no picture yet: a skeleton of the live DOM instead of a flat placeholder.
  const skeleton = shown === "pending" && missing && Boolean(props.skeleton);
  // The live board renders under a picture fading in, until it's all there.
  const hidden = shown !== "live" && shown !== "thaw" && !skeleton && fading !== "in";
  useLayoutEffect(() => {
    const r = root();
    if (!r) return;
    let st = r.querySelector("style[data-pz-skeleton]");
    if (skeleton && !st) {
      st = document.createElement("style");
      st.setAttribute("data-pz-skeleton", "");
      st.textContent = SKELETON_CSS;
      r.appendChild(st);
    } else if (!skeleton && st) st.remove();
  }, [skeleton]);
  const box = {
    position: "absolute",
    left: 0,
    top: 0,
    width: props.w,
    height: props.h,
    pointerEvents: "none",
  } as const;
  return (
    <>
      <div
        ref={host}
        onPointerMove={intent.move}
        onPointerLeave={intent.leave}
        data-pz-tier={shown === "thaw" ? "thaw" : still ? "picture" : skeleton ? "skeleton" : shown}
        style={{
          contentVisibility: hidden ? "hidden" : undefined,
          containIntrinsicSize: `${props.w}px ${props.h}px`,
        }}
      >
        {props.children(hidden)}
      </div>
      {shown === "pending" && !skeleton && (
        <div
          data-pz-placeholder={missing ? "missing" : "waiting"}
          style={{ ...box, background: props.fill ?? "#fff" }}
        />
      )}
      {/* The picture with its videos and loops: one layer, so it fades as one. */}
      <div ref={cover} data-pz-cover="" style={box}>
        {picture && (covered || want === "picture") && (
          <img
            alt=""
            draggable={false}
            src={picture.url}
            style={{ ...box, visibility: covered ? "visible" : "hidden" }}
          />
        )}
        {still && shown === "picture" && <VideoLayer root={root} scale={props.scale} />}
        {/* Mounted while the board is small, so its videos are loaded and placed for the next handoff. */}
        {loops && picture && (
          <LoopLayer
            loops={loops}
            play={covered}
            visible={covered}
            layerRef={(el) => {
              layer.current = el;
            }}
          />
        )}
      </div>
    </>
  );
}

/**
 * A picture board's looping videos big enough to see, playing over its
 * picture where the live ones sit (paused while their board doesn't render:
 * lod.ts), from where they were. A video is one composited layer, decoded in
 * hardware: far cheaper than the board's live DOM, and it keeps moving.
 */
function VideoLayer({
  root,
  scale,
}: {
  root: () => ShadowRoot | null | undefined;
  /** Device px per CSS px. */
  scale: number;
}) {
  const [videos, setVideos] = useState<
    { src: string; x: number; y: number; w: number; h: number; t: number; fit: string }[]
  >([]);
  useLayoutEffect(() => {
    const r = root();
    const board = r?.querySelector("[data-artboard]");
    if (!r || !board) return;
    const b = board.getBoundingClientRect();
    const k = (board as HTMLElement).offsetWidth / (b.width || 1);
    setVideos(
      [...r.querySelectorAll("video")]
        .filter((v) => v.currentSrc && v.loop && (v.autoplay || v.played.length))
        .map((v) => {
          const o = v.getBoundingClientRect();
          const w = o.width * k;
          const h = o.height * k;
          if (Math.max(w, h) * scale < MOTION_PX) return null;
          return {
            src: v.currentSrc,
            x: (o.left - b.left) * k,
            y: (o.top - b.top) * k,
            w,
            h,
            t: v.currentTime,
            fit: getComputedStyle(v).objectFit,
          };
        })
        .filter((v) => v !== null),
    );
  }, [root, scale]);
  return (
    <>
      {videos.map((v) => (
        <PictureVideo key={v.src + v.x + v.y} {...v} />
      ))}
    </>
  );
}

/**
 * One of a picture board's videos. Loaded and played by `playing` (loops.tsx)
 * when it's among the canvas's chosen videos; until then the picture shows its
 * frame. From where the live one was. Asked for once, while it's mounted: a
 * board re-rendering doesn't unload and reload it.
 */
function PictureVideo(v: {
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
  t: number;
  fit: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const { src, t } = v;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const seek = () => {
      if (t) el.currentTime = t % (el.duration || Number.POSITIVE_INFINITY);
    };
    el.addEventListener("loadedmetadata", seek, { once: true });
    playing.want(el, src);
    return () => {
      el.removeEventListener("loadedmetadata", seek);
      playing.drop(el);
    };
  }, [src, t]);
  return (
    <video
      ref={ref}
      muted
      loop
      playsInline
      disablePictureInPicture
      style={{
        position: "absolute",
        left: v.x,
        top: v.y,
        width: v.w,
        height: v.h,
        objectFit: v.fit as "cover",
        pointerEvents: "none",
      }}
    />
  );
}
