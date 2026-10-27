"use client";

import type { Artboard } from "@ponzu/core";
import {
  AgentMark,
  ARRIVE_LAG_MS,
  ARRIVE_PLAN_MS,
  ARRIVE_STAGGER_MS,
  ArtboardView,
  arriveBoard,
  BOARD_DRAW_MS,
  BOARD_MS,
  develop,
  drawFrame,
  Icon,
  Logo,
  Rain,
  RING_OUT_MS,
  SHEET_KEYFRAMES,
} from "@ponzu/react";
import "./ponzu.css";
import "./demo.css";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ClaudeApp } from "./claude-app";
import {
  BEATS,
  type BeatId,
  beatsOf,
  COMMENTS,
  type Comment,
  index,
  LAST,
  TYPING_MS,
  typedAt,
} from "./script";
import type { DemoDesign } from "./seekle";

/**
 * The scene is laid out at a fixed size and scaled to fit. Wide, the studio and the terminal sit
 * side by side. Narrow, they overlap like windows on a laptop screen: the studio fills the frame and
 * the Claude window floats over its lower right, coming forward while Claude talks and stepping
 * back while you look at the canvas.
 */
const WIDE = { width: 1440, height: 860, studio: 952 };
const NARROW = { width: 1000, height: 1000 };
const NARROW_AT = 860;
/** How often the clock re-renders the scene within a beat. */
const TICK_MS = 33;
/** As on the canvas (Canvas.tsx): boards are this rounded, and a working one's ring sits this far
 * off its edge, in screen px at any zoom. */
const BOARD_RADIUS = 4;
const RING_GAP = 4;

export type PageId = "app" | "motion" | "explore" | "web" | "store";

/**
 * The pages Claude makes, in order, each the design page it draws. The file starts with Ponzu's
 * default "Page 1". A page's boards are written on its `beat`, where they sit in the design.
 */
const PAGES: { id: PageId; design: string; from: BeatId; beat: BeatId }[] = [
  { id: "app", design: "pg_app", from: "app-page", beat: "app" },
  { id: "motion", design: "pg_bp3im", from: "motion-page", beat: "motion" },
  { id: "explore", design: "pg_g13sx", from: "explore-page", beat: "explore" },
  { id: "web", design: "pg_ea4v6", from: "web-page", beat: "web" },
  { id: "store", design: "pg_g1zbi", from: "store-page", beat: "store" },
];

/**
 * Boards Claude rewrites after your comments, and the beat it does it on: the studies you
 * commented on, then the three directions. Until then they're as they were (`DemoDesign.before`).
 */
const REWORK: Record<string, BeatId> = {
  ab_x_a2: "rework",
  ab_x_b2: "rework",
  ab_x_b3: "rework",
  ab_x_b4: "rework",
  ab_x_d1: "rework-2",
  ab_x_d2: "rework-2",
  ab_x_d3: "rework-2",
};

/**
 * What a comment asked for, on each board it changed: the friends orbiting the phone. Claude adds
 * them on the `revise` beat; until then they aren't there.
 */
const REVISION: Record<string, string> = {
  ab_w_desktop: ".orbitD",
  ab_w_mobile: ".orbitM",
};

/**
 * The share of a build beat its boards are written in. The rest of the beat lets the last of them
 * develop and settle before the camera moves on.
 */
const WRITE = 0.5;

/**
 * How much of a board is written by now, from 0 (not yet) to 1. The boards written on one beat
 * start in a cascade across the first part of it, each finishing by WRITE.
 */
function writtenFor(beatId: BeatId, i: number, n: number, beat: number, t: number) {
  const start = index(beatId);
  if (beat < start) return 0;
  if (beat > start) return 1;
  const lead = n > 1 ? (i / (n - 1)) * WRITE * 0.6 : 0;
  if (t < lead) return 0;
  return Math.max(0.001, Math.min(1, (t - lead) / (WRITE - lead)));
}

/** Which page is showing on a beat: the last one made. */
function pageAt(beat: number): PageId | null {
  return PAGES.findLast((p) => beat >= index(p.from))?.id ?? null;
}

type Shot = { x: number; y: number; w: number; h: number };
/** A shot the camera drifts across over its beat, as you'd scroll along a row to read it. */
type Drift = { from: Shot; to: Shot };

/**
 * What the camera frames, in world px on the current page, from each beat on until the next one
 * listed. A page is framed whole while it's written; then you move in close and drift across it,
 * as a person looks round, to watch the boards play.
 */
const SHOTS: Partial<Record<BeatId, Shot | Drift>> = {
  think: { x: -80, y: -110, w: 2490, h: 1060 },
  // Along the five screens.
  "app-look": {
    from: { x: -40, y: -50, w: 964, h: 974 },
    to: { x: 1406, y: -20, w: 980, h: 950 },
  },
  "motion-page": { x: -60, y: -90, w: 1872, h: 2550 },
  // Claiming a handle, then Home, where you ask about it, then the end of a game.
  "motion-look": {
    from: { x: -30, y: -50, w: 910, h: 1000 },
    to: { x: 420, y: 280, w: 900, h: 980 },
  },
  "motion-look-2": {
    from: { x: 880, y: 640, w: 910, h: 1000 },
    to: { x: 870, y: 880, w: 910, h: 1000 },
  },
  "motion-look-3": {
    from: { x: -30, y: 1300, w: 910, h: 1100 },
    to: { x: 420, y: 1480, w: 900, h: 1000 },
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
  "web-page": { x: -80, y: -110, w: 2080, h: 1290 },
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
};

/** Slow out, slow in. */
const ease = (t: number) => 0.5 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))) / 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where the camera's headed `t` through `beat`: the shot, or how far along its drift. */
function shotAt(beat: number, t: number): Shot {
  for (let b = beat; b >= 0; b--) {
    const s = SHOTS[BEATS[b]!.id];
    if (!s) continue;
    if (!("from" in s)) return s;
    if (b < beat) return s.to;
    const e = ease(t);
    return {
      x: lerp(s.from.x, s.to.x, e),
      y: lerp(s.from.y, s.to.y, e),
      w: lerp(s.from.w, s.to.w, e),
      h: lerp(s.from.h, s.to.h, e),
    };
  }
  return SHOTS.think as Shot;
}

/** A camera as its centre in world px and its zoom's log, which a spring can follow. */
type Aim = { cx: number; cy: number; lz: number };

function aimAt(s: Shot, view: { w: number; h: number }): Aim {
  return {
    cx: s.x + s.w / 2,
    cy: s.y + s.h / 2,
    lz: Math.log(Math.min(view.w / s.w, view.h / s.h)),
  };
}

/** The camera's spring: settles in about this long, a touch under critically damped. */
const SPRING_PERIOD_S = 0.85;
const SPRING_DAMPING = 0.88;

/**
 * The camera, moved as a person moves one: it follows where the story is looking on a spring, so
 * it speeds up and eases in rather than gliding at one pace, and a slow hand-held drift keeps it
 * from ever sitting dead still. A new page, a held beat or reduced motion puts it straight there.
 */
function useCamera(
  beat: number,
  t: number,
  view: { w: number; h: number },
  page: PageId | null,
  still: boolean,
  hold: boolean,
) {
  const latest = useRef({ beat, t, view, page, still, hold });
  latest.current = { beat, t, view, page, still, hold };
  const [aim, setAim] = useState<Aim>(() => aimAt(shotAt(beat, t), view));

  useEffect(() => {
    let state: (Aim & { vx: number; vy: number; vz: number }) | null = null;
    let shownPage: PageId | null | undefined;
    let last = performance.now();
    let frame = 0;
    const k = (2 * Math.PI) / SPRING_PERIOD_S;
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      const { beat, t, view, page, still, hold } = latest.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (hold && state) return;
      const goal = aimAt(shotAt(beat, t), view);
      if (!still) {
        // A hand on a trackpad: a few px of wander, never quite repeating.
        const s = now / 1000;
        const zoom = Math.exp(goal.lz);
        goal.cx += ((Math.sin(s * 0.37) * 0.6 + Math.sin(s * 0.91 + 1.3) * 0.4) * 7) / zoom;
        goal.cy += ((Math.sin(s * 0.29 + 2.1) * 0.6 + Math.sin(s * 0.83 + 0.4) * 0.4) * 5) / zoom;
        goal.lz += Math.sin(s * 0.21 + 0.7) * 0.006;
      }
      if (!state || still || page !== shownPage) {
        state = { ...goal, vx: 0, vy: 0, vz: 0 };
        shownPage = page;
      } else {
        const pull = (x: number, v: number, to: number) =>
          v + (k * k * (to - x) - 2 * SPRING_DAMPING * k * v) * dt;
        state.vx = pull(state.cx, state.vx, goal.cx);
        state.vy = pull(state.cy, state.vy, goal.cy);
        state.vz = pull(state.lz, state.vz, goal.lz);
        state.cx += state.vx * dt;
        state.cy += state.vy * dt;
        state.lz += state.vz * dt;
      }
      setAim({ cx: state.cx, cy: state.cy, lz: state.lz });
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);

  const zoom = Math.exp(aim.lz);
  return { zoom, x: view.w / 2 - aim.cx * zoom, y: view.h / 2 - aim.cy * zoom };
}

/** The comment being left on a beat, from the cursor setting off to the comment posted. */
function leaving(beat: number): Comment | undefined {
  return COMMENTS.find((c) => {
    const b = beatsOf(c);
    return beat >= index(b.cursor) && beat <= index(b.post);
  });
}

const DARK = "(prefers-color-scheme: dark)";

/** The system's color scheme, live, as the site follows it. Light on the server. */
function useSystemTheme(): "light" | "dark" {
  const dark = useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(DARK);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => matchMedia(DARK).matches,
    () => false,
  );
  return dark ? "dark" : "light";
}

export function ProductDemo() {
  const wrap = useRef<HTMLDivElement>(null);
  /** The design it draws, fetched once the demo mounts: it's too big to ship in the page. */
  const [design, setDesign] = useState<DemoDesign | null>(null);
  const [fit, setFit] = useState<{ scale: number; narrow: boolean } | null>(null);
  const [beat, setBeat] = useState(0);
  const [t, setT] = useState(0);
  const [cycle, setCycle] = useState(0);
  /** Held on one beat or showing the finished story: everything is just there, nothing arrives. */
  const [still, setStill] = useState(false);
  /** Off screen, the boards' own loops hold, as the canvas holds what nobody can see. */
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const narrow = width < NARROW_AT;
      setFit({ scale: width / (narrow ? NARROW : WIDE).width, narrow });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/demo/seekle.json")
      .then((r) => r.json() as Promise<DemoDesign>)
      .then((d) => live && setDesign(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      setOnScreen(entry?.isIntersecting ?? false);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // One clock drives everything, from once the design is here. It pauses off screen; reduced
  // motion shows the finished story.
  useEffect(() => {
    const el = wrap.current;
    if (!el || !design) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStill(true);
      setBeat(LAST);
      setT(1);
      return;
    }
    let visible = false;
    let current = 0;
    let started = performance.now();
    let last = started;
    let frame = 0;
    let painted = started;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (!visible) {
        started += now - last;
        last = now;
        return;
      }
      last = now;
      const beatMs = BEATS[current]?.ms ?? 1000;
      const elapsed = now - started;
      if (elapsed >= beatMs) {
        started = now;
        current = current === LAST ? 0 : current + 1;
        if (current === 0) setCycle((c) => c + 1);
        setBeat(current);
        setT(0);
        painted = now;
      } else if (now - painted >= (/type$/.test(BEATS[current]?.id ?? "") ? 0 : TICK_MS)) {
        // Everything that reads `t` moves in steps (a piece of a board, the camera's next shot),
        // so ~30 updates a second look the same as 60 and halve the renders. Typing is the
        // exception: at 30 a second, keys a few ms apart would land two at a time.
        painted = now;
        setT(elapsed / beatMs);
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
    });
    observer.observe(el);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [design]);

  const narrow = fit?.narrow ?? false;
  const size = narrow ? NARROW : WIDE;

  return (
    <div
      ref={wrap}
      role="img"
      aria-label="Claude Code rebuilds Seekle, an iPhone game, on the Ponzu canvas from the app's source: its screens, then every one of its animations, looping. It explores the game's feel in twelve animated studies; you comment on two, it combines them into three full directions, and you pick one. It designs the website hero; you ask for friends round the phone and it adds them, orbiting. Last, it makes fifteen App Store screenshots in three directions."
      className="dm-frame relative w-full"
      data-sized={fit ? "" : undefined}
      style={{ height: fit ? size.height * fit.scale : undefined }}
    >
      {fit &&
        (narrow ? (
          <div
            aria-hidden="true"
            className="dm absolute top-0 left-0 origin-top-left"
            style={{ width: size.width, height: size.height, scale: String(fit.scale) }}
          >
            <div
              className="dm-studio-wrap absolute top-0 left-0 grid"
              style={{ width: 1000, height: 820 }}
            >
              <Studio
                key={cycle}
                design={design}
                beat={beat}
                t={t}
                still={still}
                hold={!onScreen}
              />
            </div>
            <div
              className="dm-float absolute right-0 bottom-0 grid"
              data-front={terminalInFront(beat)}
              style={{ width: 640, height: 560 }}
            >
              <ClaudeApp beat={beat} t={t} big />
            </div>
          </div>
        ) : (
          <div
            aria-hidden="true"
            className="dm absolute top-0 left-0 grid origin-top-left gap-4"
            style={{
              width: size.width,
              height: size.height,
              scale: String(fit.scale),
              gridTemplateColumns: `${WIDE.studio}px 1fr`,
            }}
          >
            <Studio key={cycle} design={design} beat={beat} t={t} still={still} hold={!onScreen} />
            <ClaudeApp beat={beat} t={t} big={false} />
          </div>
        ))}
    </div>
  );
}

/**
 * On narrow screens the terminal comes forward while you're talking to Claude, and steps back while
 * the canvas has something to show or you're commenting on it.
 */
function terminalInFront(beat: number) {
  const id = BEATS[beat]?.id;
  return beat < index("app-page") || id === "c0-heard" || id === "c3-heard" || id === "c4-heard";
}

function Studio({
  design,
  beat,
  t,
  still,
  hold,
}: {
  design: DemoDesign | null;
  beat: number;
  t: number;
  still: boolean;
  hold: boolean;
}) {
  const at = (id: BeatId) => beat >= index(id);
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 920, h: 740 });

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setView({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const page = pageAt(beat);
  const camera = useCamera(beat, t, view, page, still, hold);
  const zoom = camera.zoom;
  const scheme = useSystemTheme();
  const pageMeta = (p: (typeof PAGES)[number]) => design?.pages.find((d) => d.id === p.design);
  const tabs = PAGES.filter((p) => at(p.from)).map((p) => ({
    id: p.id,
    name: pageMeta(p)?.name ?? p.id,
    icon: pageMeta(p)?.icon ?? "board",
  }));
  const showing = PAGES.find((p) => p.id === page);
  const boards = (showing && pageMeta(showing)?.artboards) || [];
  /** The beat each board is written on: its page's. */
  const writeBeat = (id: string): BeatId | undefined =>
    PAGES.find((p) => pageMeta(p)?.artboards.some((a) => a.id === id))?.beat;
  /** A board as it is now: as it was before your comments, until Claude rewrites it. */
  const drawn = (a: Artboard) => {
    const was = design?.before[a.id];
    const rework = REWORK[a.id];
    return was && rework && !at(rework) ? was : a;
  };
  const now = BEATS[beat]?.id;
  const commenting = leaving(beat);
  const busy = at("think") && !at("rest") && !commenting;
  const workingOn = (id: string, b: number) => {
    const on = BEATS[b]?.id;
    return (
      (on !== undefined && (on === writeBeat(id) || on === REWORK[id])) ||
      (id in REVISION && (on === "c4-heard" || on === "revise"))
    );
  };
  const working = (id: string) => workingOn(id, beat);
  // A board's ring fades out over RING_OUT_MS once its work is done, as on the canvas.
  const ring = (id: string): Ring =>
    working(id)
      ? "on"
      : beat > 0 && workingOn(id, beat - 1) && t * (BEATS[beat]?.ms ?? 0) < RING_OUT_MS
        ? "leaving"
        : null;
  // The boards written on each beat, so they cascade in together.
  const groups = new Map<BeatId, string[]>();
  for (const a of boards) {
    const w = writeBeat(a.id);
    if (w) groups.set(w, [...(groups.get(w) ?? []), a.id]);
  }

  // Each comment's pin sits where it was left; the cursor travels to exactly that point.
  const toScreen = (c: Comment) => {
    const board = boards.find((a) => a.id === c.board);
    if (!board) return null;
    return { x: (board.x + c.x) * zoom + camera.x, y: (board.y + c.y) * zoom + camera.y };
  };
  const active = commenting && toScreen(commenting);
  const pins = COMMENTS.flatMap((c, i) => {
    const b = beatsOf(c);
    // Claude resolves a change it made without replying; resolved threads leave the canvas. A
    // question it answers stays open.
    if (!at(b.click) || ("resolve" in c && at(c.resolve as BeatId))) return [];
    const spot = toScreen(c);
    if (!spot) return [];
    const posted = at(b.post);
    const typed =
      now === b.type
        ? typedAt(c.text, TYPING_MS.comment, t * (BEATS[beat]?.ms ?? 0))
        : posted
          ? c.text
          : "";
    // A question's thread stays open while Claude reads it and answers, long enough to read.
    const reply = "reply" in c ? c.reply : undefined;
    const answering = reply !== undefined && (now === `${c.id}-heard` || now === `${c.id}-reply`);
    const answered = reply !== undefined && now === `${c.id}-reply`;
    return [
      {
        c,
        n: i + 1,
        spot,
        posted,
        typed,
        open: !posted || now === b.post || answering,
        reply: answered ? reply : undefined,
      },
    ];
  });

  return (
    <div className="dm-window dm-studio min-h-0">
      <header className="dm-bar">
        <span className="dm-lights">
          <i />
          <i />
          <i />
        </span>
        <span className="dm-home">
          <LogoMark />
        </span>
        <span className="dm-tab">
          <Icon name="blank" size={14} />
          <span className={busy ? "pz-shimmer" : undefined}>Seekle</span>
        </span>
        <div className="dm-bar-right">
          {/* As in the app: the agent shows only while it's working or waiting on your comments. */}
          <span className="dm-agent" data-on={!at("rest")} data-busy={busy}>
            <AgentMark client="claude" size={16} />
          </span>
        </div>
      </header>

      <div className="dm-main">
        <div className="pz-root dm-canvas">
          <div
            ref={viewport}
            className={`pz:relative pz:min-h-0 pz:flex-1 pz:overflow-hidden ${commenting && !at(beatsOf(commenting).post) ? "pz:cursor-crosshair" : "pz:cursor-default"}`}
          >
            <div
              key={page ?? "empty"}
              className="dm-world pz:absolute pz:top-0 pz:left-0 pz:origin-top-left pz:will-change-transform"
              style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
            >
              {boards.map((artboard) => {
                const w = writeBeat(artboard.id);
                const group = (w && groups.get(w)) || [];
                const written = w
                  ? writtenFor(w, group.indexOf(artboard.id), group.length, beat, t)
                  : 1;
                if (!written || !design) return null;
                return (
                  <Board
                    key={artboard.id}
                    artboard={drawn(artboard)}
                    tokens={design.tokens}
                    assets={design.assets}
                    scheme={scheme}
                    zoom={zoom}
                    written={written}
                    // A board among many is written in fewer, bigger pieces, so the page fills fast.
                    pieces={Math.min(6, Math.max(2, Math.round(18 / group.length)))}
                    landing={!still && now === w}
                    working={working(artboard.id)}
                    ring={ring(artboard.id)}
                    revised={artboard.id in REVISION && at("revise")}
                    still={still}
                    hold={hold}
                  />
                );
              })}
            </div>

            <div className="pz:pointer-events-none pz:absolute pz:inset-0">
              {pins.map(({ c, n, spot, posted, typed, open, reply }) => (
                <div key={c.id} className={PIN_WRAP} style={{ left: spot.x, top: spot.y }}>
                  <span
                    className={`${PIN} dm-pin-new pz:scale-112 pz:bg-comment pz:text-comment-foreground`}
                  >
                    {posted ? n : "+"}
                  </span>
                  {open && (
                    <div className={THREAD_CARD}>
                      {posted && "reply" in c ? (
                        <Thread text={c.text} reply={reply} />
                      ) : (
                        <Composer text={typed} posted={posted} />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <Cursor
              target={active || null}
              down={!!commenting && now === beatsOf(commenting).click}
              travelling={!!commenting && now === beatsOf(commenting).cursor}
              view={view}
            />
          </div>

          <Footer
            zoom={page ? zoom : 1}
            pages={tabs}
            page={page}
            busyPage={boards.some((a) => working(a.id)) ? page : null}
            mode={commenting && !at(beatsOf(commenting).post) ? "comment" : "select"}
          />
        </div>
      </div>
    </div>
  );
}

type Ring = "on" | "leaving" | null;

/**
 * One artboard, as the canvas draws it: the design's own HTML in Ponzu's artboard view. A board
 * written while you watch develops as it does in the app (packages/react/src/arrive.ts): its frame
 * draws round it and its sheet develops inside, then each of its pieces, in the order the agent
 * writes them, shows its plan in yuzu outlines and develops top first, playing its own entrance as
 * it does. While the agent works on it, a yuzu ring breathes round it and rain falls in its
 * header. A board on a page you come back to is just there.
 */
function Board({
  artboard,
  tokens,
  assets,
  scheme,
  zoom,
  written,
  pieces: count,
  landing,
  working,
  ring,
  revised,
  still,
  hold,
}: {
  artboard: Artboard;
  tokens: string;
  assets: string;
  scheme: "light" | "dark";
  zoom: number;
  /** How much of it is written, from just started to 1. */
  written: number;
  /** About how many pieces it's written in. */
  pieces: number;
  /** It's being written now, rather than already there when its page opened. */
  landing: boolean;
  working: boolean;
  ring: Ring;
  revised: boolean;
  still: boolean;
  hold: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const frame = useRef<SVGRectElement>(null);
  // When it landed, fixed as it mounts: everything it does on arriving runs from then.
  const [landed] = useState(() => (landing ? performance.now() : undefined));
  /** How many pieces are shown or on their way, and whether the revision is. */
  const shown = useRef(landed === undefined ? Number.POSITIVE_INFINITY : 0);
  const wasRevised = useRef(landed === undefined && revised);
  /** When the last piece to arrive started, so the next waits a stagger behind it. */
  const lastStart = useRef(Number.NEGATIVE_INFINITY);
  /** The board as rendered, and its pieces in the order they're written. */
  const parts = useRef<{ section: Element; pieces: Element[]; revision: Element[] } | null>(null);
  const fixedHeight = Number.parseFloat(artboard.root.style.height ?? "");
  /** The version of the board drawn: a rewrite develops again, piece by piece. */
  const version = useRef(artboard);
  const [measured, setMeasured] = useState(0);

  useLayoutEffect(() => {
    if (landed === undefined) return;
    if (box.current) arriveBoard(box.current, landed);
    if (frame.current) drawFrame(frame.current, landed);
    const a = sheet.current?.animate(SHEET_KEYFRAMES, { duration: BOARD_MS, fill: "backwards" });
    if (a) a.currentTime = performance.now() - landed;
  }, [landed]);

  useLayoutEffect(() => {
    // The artboard view renders into its shadow root before this runs, and again if the theme
    // changes, which starts the board over as it is now.
    const section = sheet.current
      ?.querySelector("[data-artboard-host]")
      ?.shadowRoot?.querySelector("[data-artboard]");
    if (!section) return;
    if (version.current !== artboard) {
      version.current = artboard;
      shown.current = 0;
    }
    if (parts.current?.section !== section) {
      const selector = REVISION[artboard.id];
      const revision = selector ? [...section.querySelectorAll(selector)] : [];
      parts.current = { section, pieces: piecesOf(section, revision, count), revision };
      // A board sized to its content is as tall as it renders.
      if (section instanceof HTMLElement && !fixedHeight) setMeasured(section.offsetHeight);
    }
    const { pieces, revision } = parts.current;
    const due = Math.max(1, Math.ceil(written * pieces.length));
    const fresh: Element[] = [];
    pieces.forEach((el, i) => {
      hide(el, i >= due);
      if (i < due && i >= shown.current) fresh.push(el);
    });
    shown.current = Math.max(Math.min(shown.current, pieces.length), due);
    for (const el of revision) hide(el, !revised);
    if (revised && !wasRevised.current) fresh.push(...revision);
    wasRevised.current = revised;
    if (still || !layer.current) return;
    // As on the canvas: a beat after the write, once a new board's frame has drawn, and a stagger
    // behind whatever is still arriving.
    const now = performance.now();
    let floor = now + ARRIVE_LAG_MS;
    if (landed !== undefined) floor = Math.max(floor, landed + ARRIVE_LAG_MS + BOARD_DRAW_MS);
    for (const el of fresh) {
      const start = Math.max(floor, lastStart.current + ARRIVE_STAGGER_MS);
      lastStart.current = start;
      // Negative while it waits its turn: held hidden until then.
      for (const a of develop(el, layer.current)) a.currentTime = now - start;
      // The piece's own entrance (rows rising, cards dealing in) plays as it's uncovered.
      for (const a of el.getAnimations({ subtree: true }))
        if (a instanceof CSSAnimation && a.effect?.getComputedTiming().iterations !== Infinity)
          a.currentTime = now - start - ARRIVE_PLAN_MS;
    }
  }, [written, revised, still, landed, artboard, count, fixedHeight]);

  const width = Number.parseFloat(artboard.root.style.width ?? "") || 1440;
  const height = fixedHeight || measured;
  const radius = BOARD_RADIUS / zoom;
  return (
    <div
      ref={box}
      className="dm-board pz:absolute pz:shadow-board"
      style={{
        left: artboard.x,
        top: artboard.y,
        width,
        height: height || undefined,
        borderRadius: radius,
      }}
    >
      <div
        className="dm-board-title pz:absolute pz:right-0 pz:left-0 pz:flex pz:items-center pz:gap-[0.5em] pz:whitespace-nowrap pz:leading-[1.4] pz:text-muted-foreground"
        style={{ fontSize: 12 / zoom, top: -22 / zoom }}
      >
        <span data-board-name className="pz:min-w-0 pz:truncate">
          {artboard.name}
        </span>
        {/* As on the canvas: yuzu rain at the right of a working board's header, where the
            header has room for it beside the name. */}
        {working && width * zoom > 220 && <Rain className="pz:ml-auto" />}
      </div>
      <div
        ref={sheet}
        className="dm-board-body"
        style={{
          width,
          height: height || undefined,
          borderRadius: radius,
          ["--pz-board-radius" as string]: `${radius}px`,
        }}
      >
        <ArtboardView
          artboard={artboard}
          tokens={tokens}
          assetBase={assets}
          colorScheme={scheme}
          hold={hold}
          rounded
        />
        <div ref={layer} className="dm-arrive" />
      </div>
      {/* The frame and the ring are drawn in screen px, so they're the same at any zoom. */}
      {(landed !== undefined || ring) && (
        <div
          className="dm-halo"
          style={{
            left: -RING_GAP / zoom,
            top: -RING_GAP / zoom,
            width: width * zoom + 2 * RING_GAP,
            height: height * zoom + 2 * RING_GAP,
            transform: `scale(${1 / zoom})`,
          }}
        >
          {ring && <BoardRing leaving={ring === "leaving"} landed={landed} />}
          {landed !== undefined && (
            <svg
              className="pz:absolute pz:inset-0 pz:overflow-visible pz:text-[var(--pz-rind)]"
              width="100%"
              height="100%"
              aria-hidden
            >
              <rect
                ref={frame}
                x={1}
                y={1}
                style={{ width: "calc(100% - 2px)", height: "calc(100% - 2px)" }}
                rx={BOARD_RADIUS + RING_GAP}
                pathLength={100}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeDasharray="100 100"
                strokeDashoffset={100}
              />
            </svg>
          )}
        </div>
      )}
    </div>
  );
}

/** Keeps a piece out of sight until it's written. Its own animations may set its opacity. */
function hide(el: Element, hidden: boolean) {
  if (el instanceof HTMLElement || el instanceof SVGElement)
    el.style.visibility = hidden ? "hidden" : "";
}

/**
 * The pieces a board is written in, in document order: its sections, opening up the largest of
 * them until there are `about` as many, as an agent writes a screen a part at a time. What the
 * revision adds isn't one of them; it arrives inside the piece that holds it.
 */
function piecesOf(section: Element, revision: Element[], about: number): Element[] {
  const skip = new Set(revision);
  const inside = (el: Element) =>
    [...el.children].filter((c) => c.tagName !== "STYLE" && !skip.has(c));
  const area = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };
  let pieces = inside(section);
  while (pieces.length < about) {
    const open = pieces
      .map((el, i) => ({ i, kids: inside(el), area: area(el) }))
      .filter((p) => p.kids.length > 1)
      .sort((x, y) => y.area - x.area)[0];
    if (!open) break;
    pieces = [...pieces.slice(0, open.i), ...open.kids, ...pieces.slice(open.i + 1)];
  }
  return pieces;
}

/**
 * The canvas's ring round a working board (`.pz-ring`, Canvas.tsx's Ring). On a new board it waits
 * until the frame has nearly drawn; it fades out when `leaving`.
 */
function BoardRing({ leaving, landed }: { leaving: boolean; landed?: number }) {
  // Fixed when it mounts: a running animation whose delay changed would jump.
  const [wait] = useState(() =>
    landed === undefined
      ? 0
      : Math.max(0, landed + ARRIVE_LAG_MS + BOARD_DRAW_MS - 100 - performance.now()),
  );
  return (
    <div
      className="pz:absolute pz:inset-0 pz:transition-opacity pz:duration-500"
      style={{ opacity: leaving ? 0 : 1 }}
    >
      <div
        className="pz-ring pz:absolute pz:inset-0"
        style={{ borderRadius: BOARD_RADIUS + RING_GAP, animationDelay: `${wait}ms` }}
      />
    </div>
  );
}

/** Ponzu's class strings for pins and cards (Canvas.tsx, Comments.tsx), so they match exactly. */
const PIN_WRAP = "pz:pointer-events-auto pz:absolute pz:z-[2] pz:size-0";
const PIN =
  "pz:absolute pz:top-0 pz:left-0 pz:grid pz:size-6 pz:-translate-1/2 pz:place-items-center pz:rounded-full pz:font-semibold pz:text-[11px] pz:tabular-nums pz:shadow-[0_0_0_1px_rgba(17,17,16,0.18),0_1px_3px_rgba(0,0,0,0.25)]";
const THREAD_CARD =
  "pz:absolute pz:-top-3 pz:left-5 pz:w-[300px] pz:select-text pz:overflow-hidden pz:rounded-xl pz:bg-card pz:shadow-pop";

/** Ponzu's thread text (Comments.tsx). */
const THREAD_TEXT = "pz:whitespace-pre-wrap pz:text-[13.5px] pz:leading-[1.55]";

/**
 * A posted question and, once it's come, Claude's answer, as the thread card shows them
 * (Comments.tsx; the home page's comment tile draws the same).
 */
function Thread({ text, reply }: { text: string; reply?: string }) {
  return (
    <div className="pz:flex pz:flex-col pz:gap-3.5 pz:p-3.5">
      <div className="pz:flex pz:flex-col pz:gap-1">
        <div className="pz:flex pz:h-6 pz:items-center pz:gap-1.5">
          <span className="pz:inline-grid pz:size-[18px] pz:place-items-center pz:rounded-full pz:bg-muted pz:text-[7.5px] pz:font-semibold">
            Y
          </span>
          <span className="pz:font-medium">You</span>
          <span className="pz:text-[11.5px] pz:text-muted-foreground">now</span>
        </div>
        <div className={THREAD_TEXT}>{text}</div>
      </div>
      {reply && (
        <div className="dm-reply pz:flex pz:flex-col pz:gap-1">
          <div className="pz:flex pz:items-center pz:gap-1.5">
            <AgentMark client="claude" size={18} />
            <span className="pz:font-medium">Claude</span>
            <span className="pz:text-[11.5px] pz:text-muted-foreground">now</span>
          </div>
          <div className={THREAD_TEXT}>{reply}</div>
        </div>
      )}
    </div>
  );
}

/** The comment composer that opens where you click, as you type into it. */
function Composer({ text, posted }: { text: string; posted: boolean }) {
  return (
    <div className="pz:flex pz:items-end pz:gap-2 pz:py-2 pz:pr-2 pz:pl-3.5">
      <div className="pz:min-h-7 pz:flex-1 pz:py-1 pz:text-[13.5px] pz:leading-[1.55]">
        {posted ? (
          text
        ) : text ? (
          <>
            {text}
            <span className="dm-text-caret" />
          </>
        ) : (
          <span className="pz:text-muted-foreground">Leave a comment…</span>
        )}
      </div>
      <span
        className="pz:inline-flex pz:size-7 pz:shrink-0 pz:items-center pz:justify-center pz:rounded-lg pz:bg-primary pz:text-primary-foreground"
        style={{ opacity: text && !posted ? 1 : 0.3 }}
      >
        <Icon name="send" size={14} />
      </span>
    </div>
  );
}

function Cursor({
  target,
  down,
  travelling,
  view,
}: {
  /** Where you're commenting, or nothing: then it waits off in the corner, hidden. */
  target: { x: number; y: number } | null;
  down: boolean;
  /** On its way to the spot. Once there it stays on the pin as the canvas drifts. */
  travelling: boolean;
  view: { w: number; h: number };
}) {
  // The arrow's tip rests on the pin's centre, where the person clicked, while they type.
  const spot = target
    ? { x: target.x - 3, y: target.y - 2 }
    : { x: view.w * 0.82, y: view.h * 0.94 };
  return (
    <div
      className="dm-cursor"
      data-down={down}
      style={{
        translate: `${spot.x}px ${spot.y}px`,
        opacity: target ? 1 : 0,
        transition: !target ? "none" : travelling ? undefined : "opacity 300ms",
      }}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <path
          d="M3 2.2v15.6l4.2-3.9 2.7 6.1 2.8-1.2-2.7-6h5.9Z"
          fill="#0e0e0e"
          stroke="#fff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** Ponzu's class strings for the canvas's floating bars (Canvas.tsx, ui.tsx). */
const BAR =
  "pz:flex pz:items-center pz:gap-0.5 pz:rounded-xl pz:bg-bar pz:p-1 pz:shadow-bar pz:backdrop-blur-[18px] pz:backdrop-saturate-[1.6]";
const GHOST_ICON =
  "pz:inline-flex pz:size-[26px] pz:shrink-0 pz:items-center pz:justify-center pz:rounded-[7px] pz:text-muted-foreground";
const RAISED = "pz:bg-raised pz:text-foreground pz:shadow-raised";

/** The canvas's floating bars: pages at the bottom left, the mode switcher and zoom at the right. */
function Footer({
  zoom,
  pages,
  page,
  busyPage,
  mode,
}: {
  zoom: number;
  pages: { id: PageId; name: string; icon: string }[];
  page: PageId | null;
  /** The page Claude is working on, whose tab shimmers. */
  busyPage: PageId | null;
  mode: "select" | "hand" | "comment";
}) {
  const tabs = pages.length ? pages : [{ id: null, name: "Page 1", icon: "board" }];
  return (
    <div className="pz:pointer-events-none pz:absolute pz:inset-x-2.5 pz:bottom-2.5 pz:z-[3] pz:flex pz:items-end pz:justify-between pz:gap-2.5">
      <div className={`${BAR} pz:min-w-0 pz:shrink`}>
        <div className="pz:flex pz:min-w-0 pz:items-center pz:gap-0.5">
          {tabs.map((p) => (
            <span
              key={p.name}
              className={`dm-page pz:inline-flex pz:h-7 pz:shrink-0 pz:items-center pz:gap-1.5 pz:whitespace-nowrap pz:rounded-lg pz:px-2.5 ${
                p.id === page ? RAISED : "pz:text-muted-foreground"
              } ${pages.length ? "dm-page-new" : ""}`}
            >
              <Icon name={p.icon} size={14} />
              <span className={p.id && p.id === busyPage ? "pz-shimmer" : undefined}>{p.name}</span>
            </span>
          ))}
        </div>
        <span className={`${GHOST_ICON} pz:size-7 pz:rounded-lg`}>
          <Icon name="add" size={15} />
        </span>
      </div>
      <div className={`${BAR} pz:shrink-0`}>
        <div className="pz:flex pz:gap-0.5">
          {(["select", "hand", "comment"] as const).map((m) => (
            <span
              key={m}
              className={`dm-mode pz:grid pz:size-7 pz:place-items-center pz:rounded-lg ${
                mode === m ? RAISED : "pz:text-muted-foreground"
              }`}
            >
              <Icon name={m} size={16} />
            </span>
          ))}
        </div>
        <span aria-hidden className="pz:mx-1.5 pz:h-4 pz:w-px pz:bg-foreground/10" />
        <span className={GHOST_ICON}>
          <Icon name="minus" size={14} />
        </span>
        <span className="pz:inline-flex pz:h-7 pz:min-w-9 pz:items-center pz:justify-center pz:rounded-lg pz:px-0.5 pz:text-foreground pz:tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <span className={GHOST_ICON}>
          <Icon name="plus" size={14} />
        </span>
      </div>
    </div>
  );
}

/** The studio's slice: ink in light mode, paper in dark, following the page's color scheme. */
/** As in the app: the home button's mark is quiet, like the other tabs, until Home is open. */
function LogoMark() {
  return <Logo size={18} color="currentColor" />;
}
