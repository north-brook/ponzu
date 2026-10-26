import type { Artboard } from "@ponzu/core";
import { captureScale } from "./capture.ts";
import { type FrameDriver, MOTION_SCRIPT, type MotionInfo, prepareScript } from "./motion.ts";
import { muxH264 } from "./mp4.ts";

/*
 * Motion loops: a board's looping animation, filmed once as short videos, so
 * a board drawn small can keep moving as a picture instead of as thousands
 * of composited layers.
 *
 * Every animation a design can have at rest is CSS, SVG (SMIL) or video, and
 * one that repeats forever is periodic once its delay has passed: past the
 * moment every finite animation has settled (t0), the board at t0 + P looks
 * like it does at t0, where P is the least common multiple of its looping
 * animations' cycles. Different parts of a board loop at different rates (a
 * 0.9 s spinner next to a 7 s field), and their common multiple can be minutes,
 * so the board is split into regions: animated elements whose boxes (over a
 * whole cycle, clipped by what clips them, grown by their shadows and
 * filters) overlap belong to one region, and each region gets its own period
 * and its own video. A region whose period is longer than `maxPeriod` stays
 * still, like a picture.
 *
 * Filming steps every animation's currentTime and captures each frame, so a
 * loop is exact and its seam is invisible: frame N would be frame 0. Frames
 * are encoded in the render page with WebCodecs (H.264, which every Chromium
 * plays and encodes, in hardware on a Mac), at 60 samples a second with each
 * captured frame shown twice. A video's frame rate paces the page: Chrome
 * draws a page whose only damage is videos at their cadence, so 30 fps loops
 * cap the whole canvas at 30 fps (measured: 6 loops at 24 or 30 fps hold rAF
 * at 30; the same content at 60 samples a second, 60).
 */

export interface LoopRequest extends LoopRequestOptions {
  artboard: Artboard;
  tokens: string;
  colorScheme?: "light" | "dark";
  assetBase?: string;
  /** Load the design's big images as copies sized to the film, as a thumbnail render does. */
  thumbnail?: boolean;
  /** Gives up: the film stops and its page closes. */
  signal?: AbortSignal;
}

export interface LoopRequestOptions {
  /** Device px per CSS px. Videos are filmed at this scale, or less for very big regions. */
  scale: number;
  /** Regions whose period is longer than this (ms) stay still. Default 20 s. */
  maxPeriod?: number;
  /** Captured frames per second of loop time. Each is shown twice, at 2× this rate. Default 30. */
  fps?: number;
}

/** One looping part of a board, as a video to lay over its picture. */
export interface LoopRegion {
  /** Box in the artboard's CSS px. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** One cycle, in ms: the video's length. */
  period: number;
  /** Data ids of the nodes whose animations it shows, to sync live animations with it. */
  ids: string[];
  /** How many animations it shows. */
  animations: number;
  /** Video pixel size. */
  videoWidth: number;
  videoHeight: number;
  /** Distinct frames filmed (the video holds twice as many samples). */
  frames: number;
  bytes: Uint8Array;
  mime: "video/mp4";
}

export interface LoopResult {
  /**
   * Where the loop starts on the board's timeline, in ms: once every finite
   * animation has settled. Video time v shows timeline time t0 + v, and every
   * t0 + v + kP after it.
   */
  t0: number;
  regions: LoopRegion[];
  /**
   * Animated parts left still, and why: their period is too long, they're past
   * the budget, or this page has no encoder. A film whose encoding fails throws.
   */
  still: {
    x: number;
    y: number;
    width: number;
    height: number;
    period: number | null;
    reason: string;
  }[];
  motion: MotionInfo;
  /** Time spent filming and encoding, ms. */
  ms: number;
  /** Filmed before its fonts or images finished loading: not for keeping. */
  assetsTimedOut?: boolean;
}

interface PlannedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  period: number;
  ids: string[];
  animations: number;
}

/**
 * Runs in the page after the timeline is held. Finds looping animations,
 * their boxes and their regions. Serialized with toString.
 */
function loopRuntime() {
  const w = window as any;
  if (w.__ponzuLoop) return;
  const root = document.querySelector("[data-artboard]") as HTMLElement | null;
  let anims: Animation[] = [];
  let svgs: SVGSVGElement[] = [];
  /** Per planned region: the animations and SVG documents it shows. */
  let regionAnims: Animation[][] = [];
  let regionSvgs: SVGSVGElement[][] = [];
  /** What `step` moves: one capture group's animations. */
  let active: { anims: Animation[]; svgs: SVGSVGElement[] } | null = null;

  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;
  const idOf = (el: Element | null | undefined) =>
    el?.closest("[data-id]")?.getAttribute("data-id") ?? "";
  const nums = (s: string) => [...s.matchAll(/(-?\d*\.?\d+)px/g)].map((m) => Number(m[1]));
  /** Comma-separated layers, ignoring commas inside rgb() and friends. */
  const layers = (s: string) => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && !depth) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    return [...out, cur];
  };
  type Sides = { l: number; t: number; r: number; b: number };
  const none: Sides = { l: 0, t: 0, r: 0, b: 0 };
  const max = (a: Sides, b: Sides): Sides => ({
    l: Math.max(a.l, b.l),
    t: Math.max(a.t, b.t),
    r: Math.max(a.r, b.r),
    b: Math.max(a.b, b.b),
  });
  const add = (a: Sides, b: Sides): Sides => ({
    l: a.l + b.l,
    t: a.t + b.t,
    r: a.r + b.r,
    b: a.b + b.b,
  });
  /** How far a shadow reaches past the box on each side: blur + spread, shifted by its offset. */
  const shadow = (x: number, y: number, reach: number): Sides => ({
    l: Math.max(0, reach - x),
    t: Math.max(0, reach - y),
    r: Math.max(0, reach + x),
    b: Math.max(0, reach + y),
  });
  const shadowInk = (s: string): Sides =>
    s === "none"
      ? none
      : layers(s).reduce((acc, l) => {
          if (/\binset\b/.test(l)) return acc;
          const [x = 0, y = 0, blur = 0, spread = 0] = nums(l);
          return max(acc, shadow(x, y, blur + spread));
        }, none);
  /** Blur and drop shadows in a filter: a blur reaches about 3 radii (it's a Gaussian's deviation). */
  const filterInk = (s: string): Sides => {
    let ink = none;
    for (const m of s.matchAll(/blur\(\s*(\d*\.?\d+)px\s*\)/g)) {
      const r = 3 * Number(m[1]);
      ink = add(ink, { l: r, t: r, r, b: r });
    }
    for (const m of s.matchAll(/drop-shadow\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      const [x = 0, y = 0, blur = 0] = nums(m[1]!);
      ink = add(ink, shadow(x, y, 3 * blur));
    }
    return ink;
  };

  function authoredPaused(a: Animation): boolean {
    const name = (a as any).animationName;
    const effect = a.effect as KeyframeEffect | null;
    if (typeof name !== "string" || !effect?.target) return false;
    const cs = getComputedStyle(effect.target, effect.pseudoElement);
    const names = cs.animationName.split(",").map((s) => s.trim());
    const states = cs.animationPlayState.split(",").map((s) => s.trim());
    const i = names.indexOf(name);
    return i >= 0 && states[i % states.length] === "paused";
  }

  /** Every looping thing at rest: the element it moves and one cycle in ms. */
  function looping() {
    const items: { el: Element; cycle: number; anim?: Animation; pseudo: boolean }[] = [];
    if (!root) return items;
    anims = document
      .getAnimations()
      .filter((a) => a.timeline === document.timeline && !authoredPaused(a));
    for (const a of anims) {
      const effect = a.effect as KeyframeEffect | null;
      if (!effect?.target) continue;
      const ct = effect.getComputedTiming();
      if (Number.isFinite(ct.iterations)) continue;
      const dur = Number(ct.duration);
      if (!(dur > 0)) continue;
      const alt = String(effect.getTiming().direction ?? "").includes("alternate");
      const cycle = dur * (alt ? 2 : 1);
      items.push({ el: effect.target, cycle, anim: a, pseudo: Boolean(effect.pseudoElement) });
    }
    svgs = [...root.querySelectorAll("svg")].filter(
      (s) => !s.parentElement?.closest("svg"),
    ) as SVGSVGElement[];
    for (const s of root.querySelectorAll("animate, animateTransform, animateMotion, set")) {
      const forever =
        s.getAttribute("repeatCount") === "indefinite" ||
        s.getAttribute("repeatDur") === "indefinite";
      const m = /^\s*(\d*\.?\d+)\s*(ms|s)?\s*$/.exec(s.getAttribute("dur") ?? "");
      if (!forever || !m) continue;
      const cycle = Number(m[1]) * (m[2] === "ms" ? 1 : 1000);
      const target = (s as any).targetElement ?? s.parentElement;
      if (cycle > 0 && target) items.push({ el: target, cycle, pseudo: false });
    }
    return items;
  }

  /** Every animation at its own time; SVG documents at theirs. */
  function setTime(t: number) {
    for (const a of anims) a.currentTime = t;
    for (const s of svgs) s.setCurrentTime(t / 1000);
  }

  function plan(opts: { t0: number; maxPeriod: number; samples: number }) {
    if (!root) return { regions: [], still: [] };
    const items = looping();
    const rb = root.getBoundingClientRect();
    const clipCache = new Map<Element, boolean>();
    const clips = (el: Element) => {
      let c = clipCache.get(el);
      if (c === undefined) {
        const cs = getComputedStyle(el);
        c =
          cs.overflowX !== "visible" ||
          cs.overflowY !== "visible" ||
          /paint|strict|content/.test(cs.contain);
        clipCache.set(el, c);
      }
      return c;
    };
    const boxes = items.map(() => ({ l: Infinity, t: Infinity, r: -Infinity, b: -Infinity }));
    const grow = (i: number, r: DOMRect) => {
      if (!r.width && !r.height) return;
      const box = boxes[i]!;
      box.l = Math.min(box.l, r.left);
      box.t = Math.min(box.t, r.top);
      box.r = Math.max(box.r, r.right);
      box.b = Math.max(box.b, r.bottom);
    };
    // SVG documents keep one clock each: sample them across the longest SMIL cycle.
    const smilCycle = Math.max(1000, ...items.filter((it) => !it.anim).map((it) => it.cycle));
    // Entrances where they settled first: one that moves a loop, or its
    // parent, would otherwise leave the box where the loop started out.
    setTime(opts.t0);
    // Boxes over a whole cycle: each animation sampled across its own.
    for (let s = 0; s < opts.samples; s++) {
      for (const it of items)
        if (it.anim) it.anim.currentTime = opts.t0 + (it.cycle * s) / opts.samples;
      for (const sv of svgs) sv.setCurrentTime((opts.t0 + (smilCycle * s) / opts.samples) / 1000);
      items.forEach((it, i) => {
        grow(i, it.el.getBoundingClientRect());
        const kids = it.el.getElementsByTagName("*");
        for (let k = 0; k < kids.length && k < 300; k++) grow(i, kids[k]!.getBoundingClientRect());
      });
    }
    // Ink past the box (shadows, filters, outlines), and what clips it.
    const rects = items.map((it, i) => {
      const box = boxes[i]!;
      if (!Number.isFinite(box.l)) return null;
      const cs = getComputedStyle(it.el);
      const o =
        cs.outlineStyle === "none"
          ? 0
          : Math.max(0, Number.parseFloat(cs.outlineWidth) + Number.parseFloat(cs.outlineOffset));
      const pad = 2 + (it.pseudo ? 24 : 0);
      const raw = add(
        max(max(shadowInk(cs.boxShadow), shadowInk(cs.textShadow)), { l: o, t: o, r: o, b: o }),
        filterInk(cs.filter),
      );
      const cap = (n: number) => pad + Math.min(160, n);
      let l = box.l - cap(raw.l);
      let t = box.t - cap(raw.t);
      let r = box.r + cap(raw.r);
      let b = box.b + cap(raw.b);
      for (let p = it.el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
        if (p !== root && !clips(p)) continue;
        const c = p.getBoundingClientRect();
        l = Math.max(l, c.left);
        t = Math.max(t, c.top);
        r = Math.min(r, c.right);
        b = Math.min(b, c.bottom);
      }
      l = Math.max(l, rb.left);
      t = Math.max(t, rb.top);
      r = Math.min(r, rb.right);
      b = Math.min(b, rb.bottom);
      return r - l >= 1 && b - t >= 1 ? { l, t, r, b } : null;
    });
    // Regions: overlapping boxes, merged until nothing overlaps.
    type Cluster = { l: number; t: number; r: number; b: number; members: number[] };
    let clusters: Cluster[] = [];
    rects.forEach((r, i) => r && clusters.push({ ...r, members: [i] }));
    clusters.sort((a, b) => a.t - b.t);
    for (let merged = true; merged; ) {
      merged = false;
      const out: Cluster[] = [];
      for (const c of clusters) {
        const hit = out.find((o) => o.l < c.r && c.l < o.r && o.t < c.b && c.t < o.b);
        if (hit) {
          hit.l = Math.min(hit.l, c.l);
          hit.t = Math.min(hit.t, c.t);
          hit.r = Math.max(hit.r, c.r);
          hit.b = Math.max(hit.b, c.b);
          hit.members.push(...c.members);
          merged = true;
        } else out.push(c);
      }
      clusters = out;
    }
    const periodOf = (members: number[]) => {
      let p = 1;
      for (const m of members) {
        p = lcm(p, Math.max(1, Math.round(items[m]!.cycle)));
        if (p > opts.maxPeriod) return Number.POSITIVE_INFINITY;
      }
      return p;
    };
    // Neighbours with the same period (ten hue swatches in a row, a grid of
    // spinners at one speed) share a video when the box around them isn't
    // mostly empty: fewer videos to decode, one capture for all of them.
    const area = (c: { l: number; t: number; r: number; b: number }) => (c.r - c.l) * (c.b - c.t);
    for (let merged = true; merged; ) {
      merged = false;
      outer: for (let i = 0; i < clusters.length; i++)
        for (let j = i + 1; j < clusters.length; j++) {
          const a = clusters[i]!;
          const b = clusters[j]!;
          const pa = periodOf(a.members);
          const pb = periodOf(b.members);
          const p = lcm(pa, pb);
          if (!Number.isFinite(p) || p > Math.max(pa, pb)) continue;
          const u = {
            l: Math.min(a.l, b.l),
            t: Math.min(a.t, b.t),
            r: Math.max(a.r, b.r),
            b: Math.max(a.b, b.b),
          };
          if (area(u) > 1.6 * (area(a) + area(b))) continue;
          clusters[i] = { ...u, members: [...a.members, ...b.members] };
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
    }
    const regions: any[] = [];
    regionAnims = [];
    regionSvgs = [];
    const still: any[] = [];
    for (const c of clusters) {
      const period = periodOf(c.members);
      const box = {
        x: Math.floor(c.l - rb.left),
        y: Math.floor(c.t - rb.top),
        width: Math.ceil(c.r - rb.left) - Math.floor(c.l - rb.left),
        height: Math.ceil(c.b - rb.top) - Math.floor(c.t - rb.top),
      };
      if (period > opts.maxPeriod) {
        still.push({ ...box, period: null, reason: "period" });
        continue;
      }
      const ids = [...new Set(c.members.map((m) => idOf(items[m]!.el)))].filter(Boolean);
      regionAnims.push(c.members.flatMap((m) => (items[m]!.anim ? [items[m]!.anim!] : [])));
      regionSvgs.push(
        svgs.filter((sv) => c.members.some((m) => !items[m]!.anim && sv.contains(items[m]!.el))),
      );
      regions.push({ ...box, period, ids, animations: c.members.length });
    }
    setTime(opts.t0);
    return { regions, still };
  }

  /* Encoding, in the page: WebCodecs H.264. */
  type Track = {
    w: number;
    h: number;
    frames: number;
    canvas: OffscreenCanvas;
    ctx: OffscreenCanvasRenderingContext2D;
    enc: VideoEncoder;
    chunks: Uint8Array[];
    keys: boolean[];
    stamps: number[];
    description: Uint8Array | null;
    error: string | null;
    n: number;
    sample: number;
    qp: boolean;
  };
  let tracks: Track[] = [];
  /** Constant quantizer, lower is better: 18 keeps the drift from the keyframe to the loop's last frame (its seam) under 1.5/255. */
  const QP = 18;
  /** Keyframe interval, in samples: a loop of up to 20 s has just one. */
  const KEY_EVERY = 1200;
  const CODECS = ["avc1.4d0028", "avc1.640028", "avc1.42001f", "avc1.640033"];

  let why = "";
  /**
   * Constant quality where the encoder offers it (VideoToolbox does), so
   * every frame of a loop looks the same and its seam doesn't pulse; a
   * bitrate target otherwise.
   */
  async function encoderFor(w: number, h: number, bitrate: number) {
    if (typeof VideoEncoder === "undefined") {
      why = isSecureContext ? "no WebCodecs" : "not a secure context";
      return null;
    }
    const base = { width: w, height: h, framerate: 60, avc: { format: "avc" as const } };
    const tries: VideoEncoderConfig[] = [];
    for (const codec of CODECS)
      tries.push({ ...base, codec, bitrateMode: "quantizer" } as VideoEncoderConfig);
    for (const hardwareAcceleration of ["no-preference", "prefer-software"] as const)
      for (const codec of CODECS)
        tries.push({ ...base, codec, bitrate, hardwareAcceleration, latencyMode: "quality" });
    for (const config of tries) {
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
      } catch (e) {
        why = String(e);
      }
    }
    why ||= `no H.264 encoder for ${w}x${h}`;
    return null;
  }

  /** Opens one encoder per region; a reason when this page can't encode H.264. */
  async function open(spec: { w: number; h: number; frames: number }[]) {
    tracks = [];
    for (const s of spec) {
      const bitrate = Math.round(Math.max(400_000, s.w * s.h * 60 * 0.12));
      const config = await encoderFor(s.w, s.h, bitrate);
      if (!config) return why;
      const canvas = new OffscreenCanvas(s.w, s.h);
      const track = {
        ...s,
        canvas,
        ctx: canvas.getContext("2d")!,
        chunks: [],
        keys: [],
        stamps: [],
        description: null,
        error: null,
        n: 0,
        sample: 0,
        qp: (config as { bitrateMode?: string }).bitrateMode === "quantizer",
      } as unknown as Track;
      track.enc = new VideoEncoder({
        output: (chunk, meta) => {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          track.chunks.push(buf);
          track.keys.push(chunk.type === "key");
          track.stamps.push(chunk.timestamp);
          const d = meta?.decoderConfig?.description;
          if (d && !track.description)
            track.description =
              d instanceof ArrayBuffer
                ? new Uint8Array(d.slice(0))
                : new Uint8Array(
                    (d as ArrayBufferView).buffer,
                    (d as ArrayBufferView).byteOffset,
                    (d as ArrayBufferView).byteLength,
                  ).slice();
        },
        error: (e) => {
          track.error = String(e);
        },
      });
      track.enc.configure(config);
      tracks.push(track);
    }
    return "";
  }

  const unbase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  function base64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  /**
   * One captured image, cropped into the regions it covers: each region's
   * next frame, encoded twice (60 samples a second for 30 captured frames).
   */
  async function push(
    png: string,
    crops: { track: number; sx: number; sy: number; sw: number; sh: number }[],
  ) {
    const bmp = await createImageBitmap(new Blob([unbase64(png)], { type: "image/png" }));
    for (const c of crops) {
      const t = tracks[c.track]!;
      t.ctx.drawImage(bmp, c.sx, c.sy, c.sw, c.sh, 0, 0, t.w, t.h);
      for (let k = 0; k < 2; k++) {
        const frame = new VideoFrame(t.canvas, { timestamp: t.sample * 16667, duration: 16667 });
        // One keyframe, at the loop's start: a loop's frames are all alike, and a
        // keyframe mid-loop is a visible quality step. Seeking decodes from it.
        t.enc.encode(frame, {
          keyFrame: t.sample % KEY_EVERY === 0,
          ...(t.qp ? { avc: { quantizer: QP } } : {}),
        } as VideoEncoderEncodeOptions);
        frame.close();
        t.sample++;
      }
      t.n++;
    }
    bmp.close();
    // Don't let the encoders' queues grow without bound.
    while (tracks.some((t) => t.enc.encodeQueueSize > 8))
      await new Promise((r) => setTimeout(r, 1));
  }

  async function finish() {
    const out = [];
    for (const t of tracks) {
      await t.enc.flush();
      t.enc.close();
      const ordered = t.stamps.every((s, i) => i === 0 || s > t.stamps[i - 1]!);
      out.push({
        error: t.error ?? (ordered ? null : "encoder reordered frames"),
        description: t.description ? base64(t.description) : "",
        samples: t.chunks.map(base64),
        keys: t.keys,
      });
    }
    tracks = [];
    return out;
  }

  /**
   * Which planned regions `step` moves: only theirs, since setting currentTime
   * on thousands of animations per frame costs more than the capture. The
   * rest hold still at t0, outside the box being captured.
   */
  function focus(regions: number[]) {
    active = {
      anims: regions.flatMap((i) => regionAnims[i] ?? []),
      svgs: [...new Set(regions.flatMap((i) => regionSvgs[i] ?? []))],
    };
    // Every other loop off: each running or paused one is a composited
    // layer, and a frame with thousands of them costs 100+ ms to draw. Their
    // elements sit outside the captured box. Cancelled CSS animations come
    // back with play(). A one-off (an entrance that fills forwards) stays where
    // it settled: cancelled, it would show its element as it was before it,
    // often invisible, in another region's video.
    const on = new Set(active.anims);
    for (const a of anims) {
      if (on.has(a)) {
        if (a.playState === "idle") a.play();
        a.pause();
      } else if (a.effect?.getTiming().iterations === Infinity) a.cancel();
    }
  }

  /** Step to time t, then hand over the previous frame: one round trip per frame. */
  async function step(arg: { t: number; png?: string; crops?: any[] }) {
    if (arg.png) await push(arg.png, arg.crops ?? []);
    if (!active) return setTime(arg.t);
    for (const a of active.anims) a.currentTime = arg.t;
    for (const sv of active.svgs) sv.setCurrentTime(arg.t / 1000);
  }

  w.__ponzuLoop = { plan, setTime, focus, open, step, finish };
}

/** Installs `window.__ponzuLoop`. */
export const LOOP_SCRIPT = `(${loopRuntime.toString()})()`;

function loopCall(method: string, arg?: unknown): string {
  return `window.__ponzuLoop.${method}(${arg === undefined ? "" : JSON.stringify(arg)})`;
}

/**
 * Captures one board's loops may take in all: a capture costs 10-40 ms, so
 * this is up to half a minute of background filming. Regions past it stay
 * still, longest first.
 */
const MAX_CAPTURES = 720;
/** Videos per board, biggest first. The rest stay still. */
const MAX_REGIONS = 16;
/** Smallest video side, in px: encoders refuse tiny frames. */
const MIN_VIDEO_PX = 32;
/**
 * Regions that step at the same rate share one capture of the box around
 * them, up to this many device px: a capture costs 13-25 ms at any size.
 */
const SHARED_CAPTURE_PX = 2_000_000;

/** Longest side of a loop video, in px. */
const MAX_VIDEO_PX = 1280;

/**
 * Films a board's loops on a page that already shows it, and leaves the
 * page unusable for anything else. Returns regions with their videos, and
 * what was left still. Needs a secure context for
 * WebCodecs; without an H.264 encoder every region is left still.
 */
export async function filmLoops(page: FrameDriver, opts: LoopRequestOptions): Promise<LoopResult> {
  const began = Date.now();
  const fps = opts.fps ?? 30;
  const maxPeriod = opts.maxPeriod ?? 20_000;
  const motion = await page.evaluate<MotionInfo | { error: string }>(prepareScript({ at: 0 }));
  if ("error" in motion) throw new Error(motion.error);
  const t0 = Math.ceil(motion.settled);
  if (!motion.loops) return { t0, regions: [], still: [], motion, ms: Date.now() - began };
  await page.evaluate(`(${MOTION_SCRIPT}, ${LOOP_SCRIPT})`);
  const planned = await page.evaluate<{ regions: PlannedRegion[]; still: LoopResult["still"] }>(
    loopCall("plan", { t0, maxPeriod, samples: 12 }),
  );
  const origin = await page.evaluate<{ x: number; y: number }>(
    `(() => { const r = document.querySelector('[data-artboard]').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY }; })()`,
  );
  const still = [...planned.still];
  // Biggest first, within the region and capture budgets; the rest stay still.
  // Regions stepping at one rate share captures, so a rate costs its longest loop.
  const ranked = planned.regions
    .map((r, index) => ({ ...r, index }))
    .sort((p, q) => q.width * q.height - p.width * p.height);
  const chosen: (PlannedRegion & { index: number })[] = [];
  const rates = new Map<number, number>();
  const spent = () => [...rates.values()].reduce((a, n) => a + n, 0);
  for (const r of ranked) {
    const frames = Math.max(1, Math.round((r.period / 1000) * fps));
    const rate = Math.round((r.period / frames) * 100);
    const extra = Math.max(0, frames - (rates.get(rate) ?? 0));
    if (chosen.length >= MAX_REGIONS || spent() + extra > MAX_CAPTURES)
      still.push({
        ...r,
        reason: chosen.length >= MAX_REGIONS ? "too many regions" : "too long to film",
      });
    else {
      chosen.push(r);
      rates.set(rate, Math.max(rates.get(rate) ?? 0, frames));
    }
  }
  // Regions share captures only where their box fits one capture: charge each group its steps,
  // and leave the smallest regions still until what's filmed fits the budget.
  let plan = shareCaptures(chosen, opts.scale, fps);
  while (chosen.length > 1 && plan.captures > MAX_CAPTURES) {
    const r = chosen.pop()!;
    still.push({ ...r, reason: "too long to film" });
    plan = shareCaptures(chosen, opts.scale, fps);
  }
  if (!chosen.length) return { t0, regions: [], still, motion, ms: Date.now() - began };
  const { scale, specs, dt, groups } = plan;
  const cant = await page.evaluate<string>(loopCall("open", specs));
  if (cant) {
    for (const r of chosen) still.push({ ...r, reason: cant });
    return { t0, regions: [], still, motion, ms: Date.now() - began };
  }
  for (const g of groups) {
    const steps = Math.max(...g.members.map((m) => specs[m]!.frames));
    const step = dt[g.members[0]!]!;
    const clip = { ...g.box, x: g.box.x + origin.x, y: g.box.y + origin.y };
    let pending: { png: string; crops: unknown[] } | null = null;
    await page.evaluate(
      loopCall(
        "focus",
        g.members.map((m) => chosen[m]!.index),
      ),
    );
    for (let i = 0; i < steps; i++) {
      await page.evaluate(loopCall("step", { t: t0 + i * step, ...(pending ?? {}) }));
      const png = await page.capture(clip, scale);
      pending = {
        png: base64(png),
        crops: cropsFor(
          g.box,
          g.members.filter((m) => i < specs[m]!.frames).map((m) => ({ ...chosen[m]!, track: m })),
          scale,
        ),
      };
    }
    if (pending) await page.evaluate(loopCall("step", { t: t0, ...pending }));
  }
  const encoded = await page.evaluate<
    { error: string | null; description: string; samples: string[]; keys: boolean[] }[]
  >(loopCall("finish"));
  const regions: LoopRegion[] = [];
  chosen.forEach((r, i) => {
    const e = encoded[i]!;
    const spec = specs[i]!;
    const samples = e.samples.map(fromBase64);
    // A film that broke isn't a board that can't loop: it fails, and is tried again.
    if (e.error || !e.description || samples.length !== spec.frames * 2)
      throw new Error(`Filming a loop failed: ${e.error ?? "the encoder dropped frames"}`);
    // Timescale: 2N samples in P ms, exactly.
    const bytes = muxH264({
      width: spec.w,
      height: spec.h,
      timescale: spec.frames * 2 * 1000,
      sampleDuration: r.period,
      description: fromBase64(e.description),
      samples,
      keyframes: e.keys,
    });
    const { index: _index, ...box } = r;
    regions.push({
      ...box,
      videoWidth: spec.w,
      videoHeight: spec.h,
      frames: spec.frames,
      bytes,
      mime: "video/mp4",
    });
  });
  // The page is spent: filming cancelled the animations it wasn't showing.
  return { t0, regions, still, motion, ms: Date.now() - began };
}

/**
 * How regions are filmed: the scale, each one's video size and frames, its
 * step, and the groups that share captures. Each region steps by its own
 * period / frames, so its seam is exact; regions with the same step share
 * captures, one per step of the box around them, as long as that box fits one
 * capture. `captures` is what that costs in all.
 */
export function shareCaptures(
  chosen: { x: number; y: number; width: number; height: number; period: number }[],
  maxScale: number,
  fps: number,
) {
  const biggest = Math.max(...chosen.map((r) => Math.max(r.width, r.height)));
  const scale = Math.min(maxScale, MAX_VIDEO_PX / biggest);
  const even = (n: number) => Math.max(MIN_VIDEO_PX, 2 * Math.ceil((n * scale) / 2));
  const specs = chosen.map((r) => ({
    w: even(r.width),
    h: even(r.height),
    frames: Math.max(1, Math.round((r.period / 1000) * fps)),
  }));
  const dt = chosen.map((r, i) => r.period / specs[i]!.frames);
  const groups: {
    box: { x: number; y: number; width: number; height: number };
    members: number[];
  }[] = [];
  chosen.forEach((r, i) => {
    const near = groups.find((g) => {
      if (Math.abs(dt[g.members[0]!]! - dt[i]!) > 0.01) return false;
      const x = Math.min(g.box.x, r.x);
      const y = Math.min(g.box.y, r.y);
      const area =
        (Math.max(g.box.x + g.box.width, r.x + r.width) - x) *
        (Math.max(g.box.y + g.box.height, r.y + r.height) - y);
      // A capture costs about the same at any size, so anything that fits is shared.
      return area * scale ** 2 <= SHARED_CAPTURE_PX;
    });
    if (near) {
      const x = Math.min(near.box.x, r.x);
      const y = Math.min(near.box.y, r.y);
      near.box = {
        x,
        y,
        width: Math.max(near.box.x + near.box.width, r.x + r.width) - x,
        height: Math.max(near.box.y + near.box.height, r.y + r.height) - y,
      };
      near.members.push(i);
    } else groups.push({ box: { x: r.x, y: r.y, width: r.width, height: r.height }, members: [i] });
  });
  let captures = 0;
  for (const g of groups) captures += Math.max(...g.members.map((m) => specs[m]!.frames));
  return { scale, specs, dt, groups, captures };
}

/**
 * Where each region sits in one capture of `box`, in the capture's pixels. A
 * capture of a box too long for one image comes back at less than `scale`
 * (captureScale), so the crops go by the scale it's actually taken at.
 */
export function cropsFor(
  box: { width: number; height: number; x: number; y: number },
  regions: { track: number; x: number; y: number; width: number; height: number }[],
  scale: number,
): { track: number; sx: number; sy: number; sw: number; sh: number }[] {
  const k = captureScale(box.width, box.height, scale);
  return regions.map((r) => ({
    track: r.track,
    sx: (r.x - box.x) * k,
    sy: (r.y - box.y) * k,
    sw: r.width * k,
    sh: r.height * k,
  }));
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}
