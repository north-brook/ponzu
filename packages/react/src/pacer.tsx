/**
 * Keeps animations on the canvas at the display's frame rate while videos play.
 *
 * With two or more videos playing, Chromium's viz picks the frame rate for
 * the whole window from the fastest of them (its "video conference" matcher,
 * always on for desktop, with no switch to turn it off). On a page with 30 fps
 * clips, every CSS animation and transition in the designs then runs at
 * 30 fps too. A tiny, nearly invisible clip at 120 fps raises that floor to the
 * display's own rate. It plays only while two or more design videos play and
 * something else in a design is animating: a page of nothing but video stays
 * at the videos' rate, which saves the GPU half its frames and looks the same.
 * Camera moves don't need it: input lifts the cap by itself.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { animationsOf } from "./motion.ts";
import { PACER_SRC } from "./pacer-src.ts";

/** Viz throttles once this many videos are playing. */
export const PACE_FROM = 2;

const VIDEO_EVENTS = ["play", "playing", "pause", "ended", "emptied", "abort", "error"];
// Not animationiteration: an infinite animation fires it forever and changes nothing here.
const ANIMATION_EVENTS = [
  "animationstart",
  "animationend",
  "animationcancel",
  "transitionrun",
  "transitionend",
  "transitioncancel",
];

interface RootState {
  videos: number;
  animating: boolean;
}

const roots = new Map<ShadowRoot, RootState>();
const listeners = new Set<() => void>();
let pacing = false;

/**
 * An animated element that's removed, or a board that stops rendering, ends
 * its animations without an event. While pacing, look again this often.
 */
const RECHECK_MS = 2000;
let recheck = 0;

function emit() {
  let videos = 0;
  let animating = false;
  for (const s of roots.values()) {
    videos += s.videos;
    animating ||= s.animating;
  }
  const next = shouldPace(videos, animating);
  if (next === pacing) return;
  pacing = next;
  if (pacing && !recheck)
    recheck = window.setInterval(() => {
      for (const [root, s] of roots) if (s.animating) s.animating = isAnimating(root);
      emit();
    }, RECHECK_MS);
  else if (!pacing && recheck) {
    clearInterval(recheck);
    recheck = 0;
  }
  for (const l of listeners) l();
}

/** Whether the pacer should run, given the playing videos and whether anything else animates. */
export function shouldPace(videos: number, animating: boolean): boolean {
  return videos >= PACE_FROM && animating;
}

/** Videos that are playing in a root. */
export function countPlaying(root: ParentNode): number {
  let n = 0;
  for (const v of root.querySelectorAll("video")) if (!v.paused && !v.ended) n++;
  return n;
}

const running = (a: Animation) => a.playState === "running";

/** Whether anything in a board animates where it can be seen. */
function isAnimating(root: ShadowRoot): boolean {
  // A board that isn't rendered (a picture, or away) shows none of its animations, though
  // they exist and say they run: motion.ts makes a picture board's ahead of time.
  // checkVisibility is Safari 17.4+: elsewhere, a board counts as seen.
  const board = root.querySelector("[data-artboard]");
  if (!board || board.checkVisibility?.() === false) return false;
  // A field's image (motion.ts) animates where no animation list sees it.
  if (root.querySelector("[data-pz-field] > [data-pz-image][href]")) return true;
  // What motion.ts tracks answers at once; asking the root walks every animation it has,
  // tens of ms on a big board, and transitions on hover would ask every frame.
  return animationsOf(root, false).some(running) || root.getAnimations().some(running);
}

/**
 * Follow an artboard's shadow root: its playing videos and whether anything in
 * it animates. Media and animation events don't leave a shadow root, so each
 * root gets its own listeners. Call `recount` after replacing the root's
 * content (what was removed fires nothing) or after it starts or stops
 * rendering (no animation fires then either), and `stop` when it goes away.
 */
export function watchVideos(root: ShadowRoot): { recount: () => void; stop: () => void } {
  const state: RootState = { videos: 0, animating: false };
  roots.set(root, state);
  const videos = () => {
    state.videos = countPlaying(root);
    emit();
  };
  // A board with thousands of animations starts them all at once: look once per frame.
  let frame = 0;
  const animations = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      state.animating = isAnimating(root);
      emit();
    });
  };
  for (const e of VIDEO_EVENTS) root.addEventListener(e, videos, true);
  for (const e of ANIMATION_EVENTS) root.addEventListener(e, animations, true);
  const recount = () => {
    videos();
    animations();
  };
  recount();
  return {
    recount,
    stop: () => {
      cancelAnimationFrame(frame);
      for (const e of VIDEO_EVENTS) root.removeEventListener(e, videos, true);
      for (const e of ANIMATION_EVENTS) root.removeEventListener(e, animations, true);
      roots.delete(root);
      emit();
    },
  };
}

/** Whether the pacer is needed now. */
function usePacing(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pacing,
    () => false,
  );
}

/** The pacer: nothing visible, and nothing at all while it isn't needed. */
export function Pacer() {
  const on = usePacing();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (on) ref.current?.play().catch(() => {});
  }, [on]);
  if (!on) return null;
  return (
    <video
      ref={ref}
      src={PACER_SRC}
      muted
      loop
      autoPlay
      playsInline
      aria-hidden
      tabIndex={-1}
      disablePictureInPicture
      // Viz ignores a video it doesn't draw, and Chrome skips one it can tell is invisible:
      // on screen, 2 CSS px, black at 1% (at most 3/255 off the pixels beneath). Mid bottom
      // edge, not a corner: a host's rounded corners would clip it away. Fixed to the window,
      // outside the canvas's own layers, wherever the canvas mounts it.
      className="pz:pointer-events-none pz:fixed pz:bottom-0 pz:left-1/2 pz:z-[2147483647] pz:size-[2px] pz:opacity-[0.01]"
    />
  );
}
