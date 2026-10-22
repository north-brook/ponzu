"use client";

import { AgentMark, Icon, Logo } from "@ponzu/react";
import "./ponzu.css";
import "./demo.css";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { ClaudeApp } from "./claude-app";
import { BOARDS } from "./registry";
import { BEATS, type BeatId, COMMENT, index, LAST } from "./script";

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

export type PageId = "brand" | "landing" | "app";

/** The pages Claude makes, in order. The file starts with Ponzu's default "Page 1". */
const PAGES: { id: PageId; name: string; icon: string; from: BeatId }[] = [
  { id: "brand", name: "Brand", icon: "palette", from: "brand-page" },
  { id: "landing", name: "Landing", icon: "layout", from: "landing-page" },
  { id: "app", name: "App", icon: "phone", from: "app-page" },
];

/** Where each board sits, in world px on its page, and when it's written. */
const PLACES: Record<
  string,
  { page: PageId; x: number; y: number; beat: BeatId; offset?: number }
> = {
  logo: { page: "brand", x: 0, y: 0, beat: "logo" },
  palette: { page: "brand", x: 1320, y: 0, beat: "palette" },
  home: { page: "landing", x: 0, y: 0, beat: "hero" },
  night: { page: "landing", x: 0, y: 1120, beat: "variants" },
  sunroom: { page: "landing", x: 1600, y: 1120, beat: "variants", offset: 1 },
  market: { page: "landing", x: 3200, y: 1120, beat: "variants", offset: 2 },
  product: { page: "app", x: 0, y: 0, beat: "app" },
  "app-today": { page: "app", x: 510, y: 0, beat: "app", offset: 1 },
  "app-plant": { page: "app", x: 1020, y: 0, beat: "app", offset: 2 },
  "app-shop": { page: "app", x: 1530, y: 0, beat: "app", offset: 3 },
};

/** How many of a board's pieces are written by now. Siblings on one beat start in a cascade. */
function stepsFor(id: string, total: number, beat: number, t: number) {
  const place = PLACES[id];
  if (!place) return 0;
  const start = index(place.beat);
  if (beat < start) return 0;
  if (beat > start) return total;
  const lead = (place.offset ?? 0) * 0.16;
  const local = Math.max(0, Math.min(1, (t - lead) / (1 - lead * 0.6)));
  return t < lead ? 0 : Math.max(1, Math.ceil(local * total));
}

/** Which page is showing on a beat. */
function pageAt(beat: number): PageId | null {
  const at = (id: BeatId) => beat >= index(id);
  if (at("cursor")) return "landing";
  if (at("recommend")) return "landing";
  if (at("app-page")) return "app";
  if (at("landing-page")) return "landing";
  if (at("brand-page")) return "brand";
  return null;
}

type Shot = { x: number; y: number; w: number; h: number };

/** What the camera frames on each beat, in world px on the current page. */
function shot(beat: number): Shot {
  const at = (id: BeatId) => beat >= index(id);
  if (at("cursor")) return { x: 1500, y: 1030, w: 1640, h: 1060 };
  if (at("recommend")) return { x: -120, y: -100, w: 4800, h: 2200 };
  if (at("app-page")) return { x: -80, y: -90, w: 2080, h: 1040 };
  if (at("variants")) return { x: -120, y: -100, w: 4800, h: 2200 };
  if (at("landing-page")) return { x: -80, y: -110, w: 1600, h: 1120 };
  if (at("palette")) return { x: -80, y: -90, w: 2680, h: 980 };
  return { x: -80, y: -110, w: 1360, h: 1010 };
}

export function ProductDemo() {
  const wrap = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ scale: number; narrow: boolean } | null>(null);
  const [beat, setBeat] = useState(0);
  const [t, setT] = useState(0);
  const [cycle, setCycle] = useState(0);

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

  // One clock drives everything. It pauses off screen; reduced motion shows the finished story.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // `?demo=<beat>` holds the story on one beat, for screenshots, the share card and review.
    const hold = new URLSearchParams(location.search).get("demo");
    if (hold && index(hold as BeatId) >= 0) {
      setBeat(index(hold as BeatId));
      setT(1);
      return;
    }
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
      } else if (now - painted >= TICK_MS) {
        // Everything that reads `t` moves in steps (a typed letter, a piece of a board), so
        // ~30 updates a second look the same as 60 and halve the renders.
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
  }, []);

  const narrow = fit?.narrow ?? false;
  const size = narrow ? NARROW : WIDE;

  return (
    <div
      ref={wrap}
      role="img"
      aria-label="Claude Code designs Fernwood, a houseplant shop, on the Ponzu canvas. Starting from an empty page, it creates a Brand page with a logo and palette, a Landing page with a hero and three directions, and an App page with four phone screens. You pin a comment on the Sunroom direction, and Claude makes the change and resolves it."
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
              <Studio key={cycle} beat={beat} t={t} />
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
            <Studio key={cycle} beat={beat} t={t} />
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
  const at = (id: BeatId) => beat >= index(id);
  if (!at("brand-page")) return true;
  if (at("recommend") && !at("cursor")) return true;
  if (at("heard") && !at("resolve")) return true;
  return false;
}

function Studio({ beat, t }: { beat: number; t: number }) {
  const at = (id: BeatId) => beat >= index(id);
  const during = (id: BeatId) => beat === index(id);
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

  const frame = shot(beat);
  const zoom = Math.min(view.w / frame.w, view.h / frame.h);
  const camera = {
    zoom,
    x: (view.w - frame.w * zoom) / 2 - frame.x * zoom,
    y: (view.h - frame.h * zoom) / 2 - frame.y * zoom,
  };
  const page = pageAt(beat);
  const pages = PAGES.filter((p) => at(p.from));
  const busy = at("think") && !at("recommend") ? true : at("heard") && !at("resolve");
  const working = (id: string) =>
    (PLACES[id] && during(PLACES[id].beat)) ||
    (id === "sunroom" && (during("heard") || during("revise")));

  // The pin sits on the Sunroom headline; the cursor travels to exactly that point.
  const sunroom = PLACES.sunroom!;
  const pinWorld = { x: sunroom.x + 520, y: sunroom.y + 300 };
  const pin = { x: pinWorld.x * zoom + camera.x, y: pinWorld.y * zoom + camera.y };
  const commented = at("post");
  const typing = during("comment") ? COMMENT.slice(0, Math.floor(t * COMMENT.length * 1.1)) : "";
  const threadOpen = at("click");
  // Claude resolves a change it made without replying; resolved threads leave the canvas.
  const resolved = at("resolve");

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
          <span className={busy ? "pz-shimmer" : undefined}>Fernwood</span>
        </span>
        <div className="dm-bar-right">
          {/* As in the app: the agent shows only while it's working or waiting on your comments. */}
          <span className="dm-agent" data-on={at("send") && !at("rest")} data-busy={busy}>
            <AgentMark client="claude" size={16} />
          </span>
        </div>
      </header>

      <div className="dm-main">
        <div className="pz-root dm-canvas">
          <div
            ref={viewport}
            className={`pz:relative pz:min-h-0 pz:flex-1 pz:overflow-hidden ${at("cursor") && !at("post") ? "pz:cursor-crosshair" : "pz:cursor-default"}`}
          >
            <div
              key={page ?? "empty"}
              className="dm-world pz:absolute pz:top-0 pz:left-0 pz:origin-top-left pz:will-change-transform"
              style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
            >
              {BOARDS.map((board) => {
                const place = PLACES[board.id];
                if (!place || place.page !== page) return null;
                const steps = stepsFor(board.id, board.steps, beat, t);
                if (!steps) return null;
                const Component = board.Component;
                return (
                  <div
                    key={board.id}
                    className="dm-board pz:absolute pz:shadow-board"
                    style={{
                      left: place.x,
                      top: place.y,
                      width: board.width,
                      height: board.height,
                    }}
                  >
                    <div
                      className="dm-board-title pz:absolute pz:right-0 pz:left-0 pz:flex pz:items-center pz:gap-[0.5em] pz:whitespace-nowrap pz:leading-[1.4] pz:text-muted-foreground"
                      style={{ fontSize: 12 / zoom, top: -22 / zoom }}
                    >
                      <span className={working(board.id) ? "pz-shimmer" : undefined}>
                        {board.name}
                      </span>
                      {working(board.id) && (
                        <span className="pz:ml-auto pz:inline-grid pz:place-items-center">
                          <AgentMark client="claude" size={12 / zoom} />
                        </span>
                      )}
                    </div>
                    {working(board.id) && (
                      <svg
                        className="dm-trace pz:pointer-events-none pz:absolute pz:inset-0 pz:overflow-visible pz:text-[var(--pz-rind)]"
                        width={board.width}
                        height={board.height}
                        aria-hidden
                      >
                        <rect
                          width={board.width}
                          height={board.height}
                          fill="none"
                          stroke="currentColor"
                          strokeOpacity={0.6}
                          strokeWidth={1 / zoom}
                        />
                        <rect
                          className="pz-trace"
                          width={board.width}
                          height={board.height}
                          pathLength={100}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={3 / zoom}
                          strokeLinecap="round"
                        />
                      </svg>
                    )}
                    <div
                      className="dm-board-body"
                      style={
                        { width: board.width, height: board.height, "--p": steps } as CSSProperties
                      }
                    >
                      <Reveal steps={steps}>
                        <Component revised={board.id === "sunroom" && at("revise")} />
                      </Reveal>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="pz:pointer-events-none pz:absolute pz:inset-0">
              {threadOpen && !resolved && (
                <div className={PIN_WRAP} style={{ left: pin.x, top: pin.y }}>
                  <span
                    className={`${PIN} dm-pin-new pz:scale-112 pz:bg-comment pz:text-comment-foreground`}
                  >
                    {commented ? 1 : "+"}
                  </span>
                  {!commented || during("post") ? (
                    <div className={THREAD_CARD}>
                      <Composer text={typing} posted={commented} />
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            <Cursor beat={beat} target={pin} view={view} />
          </div>

          <Footer
            zoom={page ? zoom : 1}
            pages={pages}
            page={page}
            busyPage={Object.entries(PLACES).find(([id]) => working(id))?.[1].page ?? null}
            mode={at("cursor") && !at("post") ? "comment" : "select"}
          />
        </div>
      </div>
    </div>
  );
}

/** Hides each `[data-r]` piece until the agent has written it. */
function Reveal({ steps, children }: { steps: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    for (const el of ref.current?.querySelectorAll<HTMLElement>("[data-r]") ?? []) {
      const shown = Number(el.dataset.r) <= steps;
      el.style.opacity = shown ? "1" : "";
      el.style.translate = shown ? "0 0" : "";
      el.style.filter = shown ? "none" : "";
    }
  }, [steps]);
  return (
    <div ref={ref} className="contents">
      {children}
    </div>
  );
}

/** Ponzu's class strings for pins and cards (Canvas.tsx, Comments.tsx), so they match exactly. */
const PIN_WRAP = "pz:pointer-events-auto pz:absolute pz:z-[2] pz:size-0";
const PIN =
  "pz:absolute pz:top-0 pz:left-0 pz:grid pz:size-6 pz:-translate-1/2 pz:place-items-center pz:rounded-full pz:font-semibold pz:text-[11px] pz:tabular-nums pz:shadow-[0_1px_3px_rgba(0,0,0,0.25)]";
const THREAD_CARD =
  "pz:absolute pz:-top-3 pz:left-5 pz:w-[300px] pz:select-text pz:overflow-hidden pz:rounded-xl pz:bg-card pz:shadow-pop";

/** The comment composer that opens where you click, as you type into it. */
function Composer({ text, posted }: { text: string; posted: boolean }) {
  return (
    <div className="pz:flex pz:items-end pz:gap-2 pz:py-2 pz:pr-2 pz:pl-3.5">
      <div className="pz:min-h-7 pz:flex-1 pz:py-1 pz:text-[13.5px] pz:leading-[1.55]">
        {posted ? (
          COMMENT
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
  beat,
  target,
  view,
}: {
  beat: number;
  target: { x: number; y: number };
  view: { w: number; h: number };
}) {
  const at = (id: BeatId) => beat >= index(id);
  const arrived = at("cursor");
  const shown = arrived && !at("heard");
  // The arrow's tip rests on the pin's centre, where the person clicked, while they type.
  const spot = arrived
    ? { x: target.x - 3, y: target.y - 2 }
    : { x: view.w * 0.82, y: view.h * 0.94 };
  return (
    <div
      className="dm-cursor"
      data-down={beat === index("click")}
      style={{
        translate: `${spot.x}px ${spot.y}px`,
        opacity: shown ? 1 : 0,
        transitionDuration: arrived ? undefined : "0ms",
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
  pages: typeof PAGES;
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
function LogoMark() {
  return (
    <>
      <span className="dark:hidden">
        <Logo size={18} />
      </span>
      <span className="hidden dark:inline">
        <Logo size={18} dark />
      </span>
    </>
  );
}
