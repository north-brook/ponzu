/**
 * Motion loops on the canvas: a board drawn as a picture keeps moving, its
 * looping parts played as short videos over the picture (the server films
 * them: render/src/loop.ts). Videos are composited, decoded in hardware and
 * cost about nothing to draw, where the same animation live is one layer per
 * moving element.
 *
 * Swaps between live DOM and video don't jump. A loop video at time v shows
 * the board's timeline at t0 + v, and at t0 + v + kP for any whole k, where
 * P is that loop's period. Every animation in a board starts together when
 * the board mounts, so the board's own time is any of its animations'
 * currentTime.
 * - Picture to live: each region's animations go to t0 + v + kP (the
 *   nearest such time ahead of where they are) in the same task that
 *   unhides the live DOM. Both clocks run on wall time from there, so the
 *   first live frame shows what the video would have.
 * - Live to picture: the videos seek, paused, to where the live board will
 *   be a moment later. On that frame the live animations are put at exactly
 *   that time and paused, the picture goes in, and the videos play. At worst
 *   the swap holds one pose for a frame or two while playback starts.
 */

import { useEffect, useState } from "react";
import { animationsOf, type FieldClock, fieldsOf } from "./motion.ts";

export interface LoopRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  period: number;
  src: string;
  ids: string[];
}

export interface Loops {
  t0: number;
  regions: LoopRegion[];
}

/** Each mounted loop layer's manifest, for handoffs that start from the element. */
const layerLoops = new WeakMap<HTMLElement, Loops>();

/**
 * Videos playing at once, page-wide; the rest hold their frame. Each costs a
 * decoder and its frames in GPU memory (macOS composites at most 128 overlays).
 */
const MAX_PLAYING = 4;
/** How often to ask again for loops still being filmed. */
const POLL_MS = 3000;
/** How far ahead of the live board the videos seek at a handoff, ms. Doubles when a seek is slower. */
const LEAD_MS = 160;

/** Manifests by URL, least recently asked for first; a few pages' boards' worth. */
const manifests = new Map<string, Promise<Loops | null | "pending">>();
const MANIFESTS_KEPT = 512;

/** A board's loops: null when it has none, "pending" while being filmed. Polls until known. */
export function useLoops(url: string | null): Loops | null | "pending" {
  const [loops, setLoops] = useState<Loops | null | "pending">("pending");
  useEffect(() => {
    if (!url) return setLoops(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      let p = manifests.get(url);
      if (!p) {
        p = fetch(`${url}${url.includes("?") ? "&" : "?"}wait=0`)
          .then(async (res) => {
            // Being filmed, filming failed for now, or filmed for another version (an edit
            // raced it): ask again later.
            const made = res.headers.get("x-pz-version");
            const asked = new URL(url, location.href).searchParams.get("v");
            if (res.status === 202 || (made && asked && made !== asked)) return "pending" as const;
            if (res.status === 204 || !res.ok) return null;
            const m = (await res.json()) as Loops;
            // Video URLs are relative to the server.
            return {
              ...m,
              regions: m.regions.map((r) => ({ ...r, src: new URL(r.src, url).href })),
            };
          })
          .catch(() => null);
      } else manifests.delete(url);
      manifests.set(url, p);
      if (manifests.size > MANIFESTS_KEPT) manifests.delete(manifests.keys().next().value!);
      void p.then((m) => {
        if (!live) return;
        setLoops(m);
        if (m === "pending") {
          manifests.delete(url);
          timer = setTimeout(ask, POLL_MS);
        }
      });
    };
    ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [url]);
  return loops;
}

/** Each region's animations (the live board's that its video shows), in one pass over the board's. */
function byRegion(regions: LoopRegion[], all: Animation[]): Animation[][] {
  const out = regions.map(() => [] as Animation[]);
  const at = new Map<string, number>();
  regions.forEach((r, i) => {
    for (const id of r.ids) at.set(id, i);
  });
  for (const a of all) {
    const t = (a.effect as KeyframeEffect | null)?.target;
    const id = t?.closest("[data-id]")?.getAttribute("data-id");
    const i = id ? at.get(id) : undefined;
    if (i !== undefined) out[i]!.push(a);
  }
  return out;
}

/** The live board's own time, in ms: its looping animations' currentTime. */
function boardTime(anims: Animation[]): number | null {
  for (const a of anims) {
    const t = a.currentTime;
    if (typeof t === "number") return t;
  }
  return null;
}

/** The board time a region's fields show, when its animations run as an image (motion.ts). */
function fieldTime(fields: FieldClock[]): number | null {
  for (const f of fields) {
    const t = f.time();
    if (t !== null) return t;
  }
  return null;
}

/** The board time at or after `now` that shows video time `v` of a loop. */
export function liveTimeFor(v: number, t0: number, period: number, now: number): number {
  const k = Math.max(1, Math.ceil((now - t0 - v) / period));
  return t0 + v + k * period;
}

/** The video time, in ms, that shows board time `t`. */
export function videoTimeFor(t: number, t0: number, period: number): number {
  return (((t - t0) % period) + period) % period;
}

/** Animations a handoff paused, per board: only these play again at the next thaw. */
const heldBy = new WeakMap<ShadowRoot, Set<Animation>>();

/**
 * Picture to live, synchronously, once the live DOM renders (still under
 * the picture): each region's animations go to where its video is, and
 * every other looping animation to the pose the picture shows (t0, plus
 * whole cycles of its own), so nothing moves at the swap. Everything paused
 * at the last handoff plays again.
 */
export function syncLiveToVideos(root: ShadowRoot | null | undefined, layer: HTMLElement | null) {
  if (!root) return;
  const loops = layer ? (layerLoops.get(layer) ?? null) : null;
  const videos = layer ? [...layer.querySelectorAll("video")] : [];
  // Every read first, then every write. A CSS animation's playState (and its
  // timing) brings style up to date, and each write dirties it again, so
  // interleaved they cost a style recalc per animation: two seconds for a
  // board of 2,400.
  const all = animationsOf(root);
  // Only what the handoff paused: an animation the design paused itself stays paused.
  const held = heldBy.get(root);
  heldBy.delete(root);
  const paused = held ? all.filter((a) => held.has(a) && a.playState === "paused") : [];
  const writes: [Animation, number][] = [];
  if (loops) {
    const done = new Set<Animation>();
    const groups = byRegion(loops.regions, all);
    loops.regions.forEach((r, i) => {
      const v = videos[i];
      if (!v || v.readyState < 1) return;
      const anims = groups[i]!;
      const fields = fieldsOf(root, r.ids);
      const now = boardTime(anims) ?? fieldTime(fields) ?? 0;
      const t = liveTimeFor(v.currentTime * 1000, loops.t0, r.period, now);
      for (const a of anims) {
        writes.push([a, t]);
        done.add(a);
      }
      // A field draws its region as an image of itself: that image goes to the video's pose.
      for (const f of fields) void f.phase(t);
    });
    for (const a of all) {
      if (done.has(a) || a.timeline !== document.timeline) continue;
      const timing = a.effect?.getComputedTiming();
      const cycle =
        Number(timing?.duration) * (String(timing?.direction).includes("alternate") ? 2 : 1);
      if (Number.isFinite(timing?.iterations) || !(cycle > 0)) continue;
      const now = Number(a.currentTime) || 0;
      writes.push([a, loops.t0 + Math.max(1, Math.ceil((now - loops.t0) / cycle)) * cycle]);
    }
  }
  for (const [a, t] of writes) a.currentTime = t;
  for (const a of paused) a.play();
}

/**
 * Live to picture: seeks each video, paused, to where the live board will be
 * a moment ahead, waits for that moment, then calls `swap` in the frame that
 * shows it, with the live animations held at exactly that pose. Resolves
 * true once swapped, false when cancelled.
 */
export async function handoffToVideos(
  root: ShadowRoot | null | undefined,
  layer: HTMLElement,
  loops: Loops,
  swap: () => void,
  cancelled: () => boolean,
): Promise<boolean> {
  const videos = [...layer.querySelectorAll("video")];
  const ready = (v: HTMLVideoElement) =>
    v.readyState >= 1
      ? Promise.resolve()
      : new Promise<void>((r) => {
          v.addEventListener("loadedmetadata", () => r(), { once: true });
          v.addEventListener("error", () => r(), { once: true });
        });
  await Promise.all(videos.map(ready));
  if (cancelled()) return false;
  const groups = root ? byRegion(loops.regions, animationsOf(root)) : [];
  const regions = loops.regions.map((r, i) => ({
    r,
    anims: groups[i] ?? [],
    fields: root ? fieldsOf(root, r.ids) : [],
  }));
  const timeOf = (x: (typeof regions)[number]) => boardTime(x.anims) ?? fieldTime(x.fields);
  for (let lead = LEAD_MS; lead <= LEAD_MS * 8; lead *= 2) {
    const start = performance.now();
    const targets = regions.map((x) => {
      const { r } = x;
      const now = timeOf(x);
      // A board that was never live (it opened small) has no pose to match.
      return now === null ? null : videoTimeFor(now + lead, loops.t0, r.period);
    });
    await Promise.all(
      videos.map(
        (v, i) =>
          new Promise<void>((resolve) => {
            const t = targets[i];
            v.pause();
            if (t === null || t === undefined) return resolve();
            v.addEventListener("seeked", () => resolve(), { once: true });
            setTimeout(resolve, 1000);
            v.currentTime = t / 1000;
          }),
      ),
    );
    if (cancelled()) return false;
    const due = start + lead;
    // Too slow: the live board is already past the pose the videos show. Again, further ahead.
    if (performance.now() > due - 4) continue;
    await new Promise<void>((resolve) => {
      const tick = (now: number) => (now >= due - 8 ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    if (cancelled()) return false;
    // Poses first, then the writes: reading an animation's time between writes recalcs style each time.
    const poses = regions.map((x, i) => {
      const t = targets[i];
      if (t === null || t === undefined) return null;
      return liveTimeFor(t, loops.t0, x.r.period, (timeOf(x) ?? 0) - x.r.period / 2);
    });
    const paused = new Set<Animation>();
    regions.forEach(({ anims }, i) => {
      const pose = poses[i];
      if (pose === null || pose === undefined) return;
      for (const a of anims) {
        a.currentTime = pose;
        a.pause();
        paused.add(a);
      }
    });
    if (root) heldBy.set(root, paused);
    swap();
    for (const v of videos) playing.want(v);
    return true;
  }
  // Seeks never kept up: swap anyway, in phase from the next frame on.
  swap();
  for (const v of videos) playing.want(v);
  return true;
}

/** Let a video's decoder and frames go: it shows nothing until it loads again. */
function unload(v: HTMLVideoElement) {
  v.pause();
  v.removeAttribute("src");
  v.load();
}

/** Of `videos` on screen with their area, which may play: the biggest, up to `max`. */
export function chosen<T>(videos: Map<T, number>, max: number): Set<T> {
  return new Set(
    [...videos]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([v]) => v),
  );
}

/**
 * Which of the videos the canvas lays over pictures play (loops and boards'
 * own videos alike): the biggest on screen, up to MAX_PLAYING page-wide, and
 * none while the camera moves. A board's own video that doesn't play is
 * unloaded (`src` given to `want`): the picture under it already shows its
 * frame, and a loaded video costs a decoder, buffered frames and a layer. It
 * loads again, at the time it was at, when it's chosen. A loop's video holds
 * its frame instead, since the picture doesn't have it.
 */
export const playing = (() => {
  /** Wanted videos, and the source a board's own video loads only while it plays. */
  const wanted = new Map<HTMLVideoElement, string | undefined>();
  /** On screen, by area in screen px. */
  const visible = new Map<HTMLVideoElement, number>();
  let io: IntersectionObserver | null = null;
  let held = false;
  const update = () => {
    const play = held ? new Set() : chosen(visible, MAX_PLAYING);
    for (const [v, src] of wanted) {
      const on = play.has(v);
      if (on) {
        if (src && !v.getAttribute("src")) v.src = src;
        if (v.paused) void v.play().catch(() => {});
      } else if (src) {
        if (v.getAttribute("src")) unload(v);
      } else if (!v.paused) v.pause();
    }
  };
  const observer = () =>
    (io ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target as HTMLVideoElement;
        const r = e.intersectionRect;
        if (e.isIntersecting) visible.set(v, r.width * r.height);
        else visible.delete(v);
      }
      update();
    }));
  return {
    want(v: HTMLVideoElement, src?: string) {
      wanted.set(v, src);
      observer().observe(v);
      update();
    },
    drop(v: HTMLVideoElement) {
      const src = wanted.get(v);
      wanted.delete(v);
      visible.delete(v);
      io?.unobserve(v);
      if (src) unload(v);
      else v.pause();
      update();
    },
    /** Hold every video's frame while the camera moves; play again once it rests. */
    hold(on: boolean) {
      if (on === held) return;
      held = on;
      update();
    },
  };
})();

/**
 * The videos of a board's loops, laid over its picture in the board's CSS
 * px. Mounted paused while a handoff lines them up (`play` false); playing
 * once the picture shows.
 */
export function LoopLayer(props: {
  loops: Loops;
  play: boolean;
  visible: boolean;
  layerRef: (el: HTMLDivElement | null) => void;
}) {
  const { loops, play, visible } = props;
  // Each video asks to play while the layer plays, and stops asking when it goes: a new
  // manifest's videos are asked for, and the old ones' entries don't linger.
  const want = (v: HTMLVideoElement | null) => {
    if (!v) return;
    if (play) playing.want(v);
    else playing.drop(v);
    return () => playing.drop(v);
  };
  return (
    <div
      ref={(el) => {
        if (el) layerLoops.set(el, loops);
        props.layerRef(el);
      }}
      data-pz-loops=""
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        // Under the live board until the handoff swaps them: present, decoded, unseen.
        visibility: visible ? "visible" : "hidden",
      }}
    >
      {loops.regions.map((r) => (
        <video
          key={r.src}
          ref={want}
          src={r.src}
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          style={{
            position: "absolute",
            left: r.x,
            top: r.y,
            width: r.width,
            height: r.height,
            objectFit: "fill",
            display: "block",
          }}
        />
      ))}
    </div>
  );
}
