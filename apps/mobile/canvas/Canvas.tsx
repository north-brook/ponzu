/*
 * The phone's canvas: a page of artboards drawn exactly as desktop draws them (each in its own
 * shadow root, with the design's tokens and fonts), on a plane a finger pans and two fingers
 * pinch. Double-tap a board to focus it (pinch out, or pan past it, to leave), hold to comment, tap
 * a pin to read its thread. Labels,
 * pins and traces sit on screen above the boards, so they stay a fixed size at any zoom. No
 * chrome: the app draws that around the web view.
 */
import { type Artboard, isThemed, threadPage } from "@ponzu/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
// Desktop's own pieces, from source: the app doesn't depend on @ponzu/react, whose index pulls
// in the whole studio canvas.
import { ArtboardView } from "../../../packages/react/src/Artboard.tsx";
import { arriveBoard } from "../../../packages/react/src/arrive.ts";
import { AgentMark } from "../../../packages/react/src/icons.tsx";
import {
  type Box,
  between,
  boardSize,
  type Camera,
  clampToBox,
  commentCamera,
  easeOut,
  focusCamera,
  glide,
  LABEL,
  labelCovers,
  overview,
  pinPoint,
  REST,
  readingOrder,
  type Screen,
  threadPoint,
  toScreen,
  toWorld,
  zoomAt,
} from "./camera.ts";
import { doubleTapFocus, Gestures, type Point } from "./gestures.ts";
import { arrivals, getState, send, setPage, subscribe } from "./store.ts";

/** How long a focus, or a snap back, takes. */
const MOVE_MS = 420;
/** A pinch that leaves a focused board this much smaller lets go of it. */
const LET_GO = 0.85;
/** A tap this close to a pin opens it: a 24px pin, a 44px target. */
const PIN_TARGET = 22;

interface Worker {
  id: string;
  client?: string;
}

interface PinAt {
  id: string;
  x: number;
  y: number;
}

export function PhoneCanvas() {
  const s = useSyncExternalStore(subscribe, getState);
  const doc = s.doc;
  const page = doc?.pages.find((p) => p.id === s.pageId) ?? doc?.pages[0];
  const boards = page?.artboards ?? [];
  const [screenSize, setScreenSize] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const screen: Screen = useMemo(
    () => ({ ...screenSize, insets: s.insets }),
    [screenSize, s.insets],
  );
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const [cam, setCamState] = useState<Camera>({ x: 0, y: 0, zoom: 0.4 });
  const [focused, setFocused] = useState<string | null>(null);
  /** Node boxes for pins on nodes, in artboard px: measured once per change, not per frame. */
  const [nodes, setNodes] = useState<Record<string, Box>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);

  const boxes = useMemo(
    () =>
      boards.map((ab) => {
        const { w, h } = boardSize(ab.root);
        return { id: ab.id, x: ab.x, y: ab.y, w, h: h ?? measured[ab.id] ?? 900 };
      }),
    [boards, measured],
  );

  // The camera lives in a ref and paints once a frame, however many touches arrive in one.
  const camRef = useRef(cam);
  const frame = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setCam = (c: Camera) => {
    if (!Number.isFinite(c.x + c.y + c.zoom)) return;
    camRef.current = c;
    // A layer only while it moves: left on, the boards stay a bitmap drawn at an old zoom, blurry
    // once zoomed in. Off, they redraw sharp.
    if (world.current) world.current.style.willChange = "transform";
    clearTimeout(settle.current);
    settle.current = setTimeout(() => world.current?.style.removeProperty("will-change"), 150);
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setCamState(camRef.current);
      });
  };

  /** A camera move under way (a focus, a snap, a glide), stopped by the next touch. */
  const motion = useRef(0);
  const stop = () => {
    cancelAnimationFrame(motion.current);
    motion.current = 0;
  };
  const reportZoom = () => send({ t: "camera", zoom: camRef.current.zoom });
  const animateTo = (to: Camera, ms = MOVE_MS) => {
    stop();
    const from = camRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      setCam(between(from, to, easeOut(t), screen));
      if (t < 1) motion.current = requestAnimationFrame(step);
      else {
        motion.current = 0;
        reportZoom();
      }
    };
    motion.current = requestAnimationFrame(step);
  };
  /** A released pan keeps going and slows; on a focused board it stops at the board's edges. */
  const coast = (v: Point, box: Box | null) => {
    stop();
    let vel = v;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const g = glide(vel, dt);
      vel = g.v;
      const c = camRef.current;
      let next = { ...c, x: c.x + g.dx, y: c.y + g.dy };
      if (box) {
        const held = clampToBox(next, box, screen);
        if (held.x !== next.x) vel = { ...vel, x: 0 };
        if (held.y !== next.y) vel = { ...vel, y: 0 };
        next = held;
      }
      setCam(next);
      if (Math.hypot(vel.x, vel.y) > REST) motion.current = requestAnimationFrame(step);
      else {
        motion.current = 0;
        reportZoom();
      }
    };
    if (Math.hypot(v.x, v.y) > REST) motion.current = requestAnimationFrame(step);
    else reportZoom();
  };

  // Where to go back to when a focus ends.
  const before = useRef<Camera | null>(null);
  const boxOf = (id: string | null) => (id ? (boxes.find((b) => b.id === id) ?? null) : null);

  const focus = (id: string, from?: Camera) => {
    const box = boxOf(id);
    if (!box) return;
    if (!focused) before.current = from ?? camRef.current;
    setFocused(id);
    send({ t: "focused", artboardId: id });
    animateTo(focusCamera(box, screen));
  };
  const unfocus = () => {
    if (!focused) return;
    setFocused(null);
    send({ t: "focused", artboardId: null });
    animateTo(before.current ?? overview(boxes, screen) ?? camRef.current);
    before.current = null;
  };

  // A page frames itself when it first shows, before it paints, and again if the chrome changes
  // size before anyone has touched it. Not under a comment or thread sheet, whose camera keeps
  // its board up while the keyboard comes and goes.
  const fitted = useRef<string | null>(null);
  const drew = useRef(false);
  const touched = useRef(false);
  const fitKey = page ? `${page.id}:${boxes.length > 0}` : null;
  const sheetOpen = Boolean(s.pending || s.thread);
  useLayoutEffect(() => {
    if (!page || !fitKey) return;
    if (fitted.current === fitKey && (touched.current || sheetOpen)) return;
    const fresh = fitted.current !== fitKey;
    fitted.current = fitKey;
    if (fresh) touched.current = false;
    const c = overview(boxes, screen);
    if (!c) return;
    stop();
    setCam(c);
    // The first page on screen, framed: the app's placeholder can go (two frames on, once painted).
    if (!drew.current) {
      drew.current = true;
      requestAnimationFrame(() => requestAnimationFrame(() => send({ t: "drawn" })));
    }
    if (fresh && focused) {
      setFocused(null);
      before.current = null;
      send({ t: "focused", artboardId: null });
    }
  }, [fitKey, screen]);

  // The app asks for a focus: a board, maybe on another page, or none.
  const pendingFocus = useRef<string | null>(null);
  const focusAsk = s.focus;
  useEffect(() => {
    if (!focusAsk || !doc) return;
    if (!focusAsk.id) return unfocus();
    const onPage = doc.pages.find((p) => p.artboards.some((a) => a.id === focusAsk.id));
    if (!onPage) return;
    if (onPage.id !== page?.id) {
      // The other page frames itself first; the focus follows on the next render.
      setPage(onPage.id);
      send({ t: "page", pageId: onPage.id });
      pendingFocus.current = focusAsk.id;
      return;
    }
    focus(focusAsk.id);
  }, [focusAsk]);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !boxOf(id)) return;
    pendingFocus.current = null;
    focus(id);
  });

  // A focused board that goes away lets go.
  useEffect(() => {
    if (focused && !boxOf(focused)) {
      setFocused(null);
      before.current = null;
      send({ t: "focused", artboardId: null });
    }
  }, [boxes, focused]);

  useEffect(() => {
    const onResize = () => setScreenSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", s.theme === "dark");
  }, [s.theme]);

  // Measure artboards with fit-content height, before paint like the fit. As desktop does.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const next: Record<string, number> = {};
    for (const ab of boards) {
      if (boardSize(ab.root).h !== null) continue;
      const host = el.querySelector(`[data-artboard-host="${CSS.escape(ab.id)}"]`);
      const inner = host?.shadowRoot?.querySelector("[data-artboard]") as HTMLElement | null;
      if (inner) next[ab.id] = inner.offsetHeight;
    }
    if (Object.keys(next).some((k) => next[k] !== measured[k]))
      setMeasured((m) => ({ ...m, ...next }));
  });

  // Which boards agents are working on, and who.
  const working = useMemo(() => {
    const map = new Map<string, Worker[]>();
    for (const p of s.presence) {
      if (p.kind !== "agent" || (p.file && s.file && p.file !== s.file)) continue;
      for (const id of p.working)
        map.set(id, [...(map.get(id) ?? []), { id: p.id, client: p.client }]);
    }
    return map;
  }, [s.presence, s.file]);

  // Resolved threads leave the board.
  const threads = useMemo(
    () =>
      doc && page
        ? doc.threads.filter((t) => t.status === "open" && threadPage(doc, t)?.id === page.id)
        : [],
    [doc, page],
  );

  // Pins on a node follow it as it moves or resizes: its box, measured after each change.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const next: Record<string, Box> = {};
    for (const t of threads) {
      const ab = boards.find((b) => b.id === t.artboardId);
      if (!ab || !t.nodeId) continue;
      const box = nodeBox(el, ab, t.nodeId);
      if (box) next[t.id] = box;
    }
    const same =
      Object.keys(next).length === Object.keys(nodes).length &&
      Object.entries(next).every(([k, b]) => {
        const o = nodes[k];
        return o && o.x === b.x && o.y === b.y && o.w === b.w && o.h === b.h;
      });
    if (!same) setNodes(next);
  }, [threads, boards, measured]);

  const pins: PinAt[] = threads.map((t) => ({
    id: t.id,
    ...pinPoint(
      t,
      boards.find((b) => b.id === t.artboardId),
      nodes[t.id] ?? null,
      cam,
    ),
  }));

  /** Where a thread or a new comment's pin is on the page. */
  const pinWorld = (t: { artboardId?: string; x: number; y: number }) => {
    const box = boxOf(t.artboardId ?? null);
    return { box, x: (box?.x ?? 0) + t.x, y: (box?.y ?? 0) + t.y };
  };

  // Writing a comment, or reading a thread: its board comes up and its pin stays above the sheet.
  const openThread = s.thread ? doc?.threads.find((t) => t.id === s.thread) : undefined;
  const about = s.pending ?? openThread ?? null;
  useEffect(() => {
    if (!about) return;
    const at = pinWorld(about);
    if (!at.box) {
      animateTo(
        commentCamera(
          { x: at.x - 1, y: at.y - 1, w: 2, h: 2 },
          at,
          camRef.current,
          screen,
          s.sheet,
        ),
      );
      return;
    }
    const next = commentCamera(at.box, at, camRef.current, screen, s.sheet);
    const c = camRef.current;
    if (next.x !== c.x || next.y !== c.y || next.zoom !== c.zoom) animateTo(next);
  }, [about, s.sheet]);

  /** The board under a screen point, the deepest node there, and the point in its px. */
  const hitTest = (p: Point) => {
    const c = camRef.current;
    const w = toWorld(c, p.x, p.y);
    const box = [...boxes]
      .reverse()
      .find((b) => w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h);
    if (!box) return null;
    const host = viewport.current?.querySelector(`[data-artboard-host="${CSS.escape(box.id)}"]`);
    const els = host?.shadowRoot?.elementsFromPoint(p.x, p.y) ?? [];
    const el = els.find((x) => x.hasAttribute("data-id") && !x.hasAttribute("data-artboard"));
    return { box, nodeId: el?.getAttribute("data-id") ?? undefined };
  };

  // Gestures read the latest render through a ref: one listener for the canvas's life.
  const latest = useRef({
    pins,
    focused,
    boxes,
    screen,
    page,
    hitTest,
    focus,
    unfocus,
    animateTo,
    coast,
    stop,
  });
  latest.current = {
    pins,
    focused,
    boxes,
    screen,
    page,
    hitTest,
    focus,
    unfocus,
    animateTo,
    coast,
    stop,
  };

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    let pinchBase: { cam: Camera; center: Point } | null = null;
    /** This touch has told the app a gesture began on a focused board, which brings its chrome back. */
    let told = false;
    const moving = () => {
      if (told || !latest.current.focused) return;
      told = true;
      send({ t: "gesture" });
    };
    const g = new Gestures({
      down() {
        touched.current = true;
        told = false;
        latest.current.stop();
      },
      pan(dx, dy) {
        moving();
        const { focused, boxes, screen } = latest.current;
        const c = camRef.current;
        let next = { ...c, x: c.x + dx, y: c.y + dy };
        const box = focused ? boxes.find((b) => b.id === focused) : undefined;
        if (box) {
          // Across a board at its focus, a drag shows the next one; otherwise it stays in bounds.
          const held = clampToBox(next, box, screen);
          next = { ...held, x: atFocus(c, box, screen) ? next.x : held.x };
        }
        setCam(next);
      },
      pinchStart(center) {
        moving();
        pinchBase = { cam: camRef.current, center };
      },
      pinch(scale, center) {
        if (!pinchBase) return;
        const z = zoomAt(
          pinchBase.cam,
          pinchBase.cam.zoom * scale,
          pinchBase.center.x,
          pinchBase.center.y,
        );
        setCam({
          ...z,
          x: z.x + center.x - pinchBase.center.x,
          y: z.y + center.y - pinchBase.center.y,
        });
      },
      release(v, moved) {
        pinchBase = null;
        const { focused, boxes, screen, focus, unfocus, animateTo, coast } = latest.current;
        const box = focused ? boxes.find((b) => b.id === focused) : undefined;
        const c = camRef.current;
        if (!box) return coast(v, null);
        const home = focusCamera(box, screen);
        if (moved.pinched) {
          if (c.zoom < home.zoom * LET_GO) {
            // Pinched away: the canvas stays where the fingers left it.
            setFocused(null);
            before.current = null;
            send({ t: "focused", artboardId: null });
            return coast({ x: 0, y: 0 }, null);
          }
          // Still on the board: the app hides its chrome again.
          send({ t: "focused", artboardId: box.id });
          return animateTo(c.zoom < home.zoom ? home : clampToBox(c, box, screen));
        }
        if (Math.abs(c.zoom - home.zoom) < home.zoom * 0.01) {
          // A swipe across goes to the board before or after, in reading order.
          const swipe =
            Math.abs(moved.x) > Math.abs(moved.y) &&
            (Math.abs(moved.x) > screen.w * 0.25 ||
              (Math.abs(v.x) > 0.4 && Math.abs(moved.x) > 30));
          if (swipe) {
            const order = readingOrder(boxes);
            const next = order[order.findIndex((b) => b.id === box.id) + (moved.x < 0 ? 1 : -1)];
            if (next) return focus(next.id);
            // Past the first or last board: out of focus, back to where the canvas was.
            return unfocus();
          }
          send({ t: "focused", artboardId: box.id });
          if (Math.abs(c.x - home.x) > 0.5)
            return animateTo({ ...clampToBox(c, box, screen), x: home.x });
        }
        if (Math.abs(c.zoom - home.zoom) >= home.zoom * 0.01)
          send({ t: "focused", artboardId: box.id });
        coast(v, box);
      },
      tap(p) {
        const hit = nearestPin(latest.current.pins, p);
        if (hit) send({ t: "openThread", id: hit.id });
      },
      doubleTap(p) {
        const { focused, hitTest, focus } = latest.current;
        const id = doubleTapFocus(focused, focused ? null : (hitTest(p)?.box.id ?? null));
        if (id) focus(id);
      },
      longPress(p) {
        const { hitTest, page } = latest.current;
        if (!page) return;
        const hit = hitTest(p);
        const c = camRef.current;
        send({
          t: "longpress",
          pageId: page.id,
          ...(hit ? { artboardId: hit.box.id } : {}),
          ...(hit?.nodeId ? { nodeId: hit.nodeId } : {}),
          ...threadPoint(c, p.x, p.y, hit?.box),
        });
      },
    });
    const points = (list: TouchList) =>
      Array.from(list, (t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));
    const start = (e: TouchEvent) => {
      e.preventDefault();
      g.touchStart(points(e.changedTouches), performance.now());
    };
    const move = (e: TouchEvent) => {
      e.preventDefault();
      g.touchMove(points(e.changedTouches), performance.now());
    };
    const end = (e: TouchEvent) => {
      e.preventDefault();
      g.touchEnd(points(e.changedTouches), performance.now());
    };
    // A mouse, in the dev harness on a desktop, is one finger.
    let mouse = false;
    const mdown = (e: MouseEvent) => {
      mouse = true;
      g.touchStart([{ id: -1, x: e.clientX, y: e.clientY }], performance.now());
    };
    const mmove = (e: MouseEvent) =>
      mouse && g.touchMove([{ id: -1, x: e.clientX, y: e.clientY }], performance.now());
    const mup = () => {
      if (!mouse) return;
      mouse = false;
      g.touchEnd([{ id: -1 }], performance.now());
    };
    // Safari's own pinch would zoom the page itself.
    const gesture = (e: Event) => e.preventDefault();
    const opts = { passive: false } as const;
    el.addEventListener("touchstart", start, opts);
    el.addEventListener("touchmove", move, opts);
    el.addEventListener("touchend", end, opts);
    el.addEventListener("touchcancel", end, opts);
    el.addEventListener("mousedown", mdown);
    window.addEventListener("mousemove", mmove);
    window.addEventListener("mouseup", mup);
    document.addEventListener("gesturestart", gesture, opts);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("mousedown", mdown);
      window.removeEventListener("mousemove", mmove);
      window.removeEventListener("mouseup", mup);
      document.removeEventListener("gesturestart", gesture);
    };
  }, [!!doc]);

  if (!doc || !page) return <div ref={viewport} className="viewport" />;

  const scheme = (ab: Artboard) => (isThemed(doc.tokens, ab.root) ? s.theme : "light");

  return (
    <div ref={viewport} className="viewport">
      <div
        ref={world}
        className="world"
        style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})` }}
      >
        {boards.map((ab) => {
          const box = boxes.find((b) => b.id === ab.id)!;
          return (
            <div
              key={ab.id}
              ref={(el) => {
                if (el && arrivals.takeBoard(ab.id)) arriveBoard(el);
              }}
              className="board"
              style={{
                left: ab.x,
                top: ab.y,
                width: box.w,
                height: boardSize(ab.root).h ?? undefined,
              }}
            >
              <ArtboardView
                artboard={ab}
                tokens={doc.tokens}
                assetBase={s.assetBase}
                colorScheme={scheme(ab)}
                arrivals={arrivals}
              />
            </div>
          );
        })}
      </div>

      {/* On screen, so they stay crisp and a fixed size at any zoom. */}
      <div className="overlay">
        {boxes.map((b) => {
          const p = toScreen(cam, b.x, b.y);
          const w = b.w * cam.zoom;
          const h = b.h * cam.zoom;
          if (offscreen(p, w, h, screen)) return null;
          const who = working.get(b.id);
          const showLabel = !!who || !labelCovers(b, boxes, cam.zoom);
          return (
            <BoardChrome
              key={b.id}
              name={boards.find((a) => a.id === b.id)?.name ?? ""}
              x={p.x}
              y={p.y}
              w={w}
              h={h}
              who={who}
              label={showLabel && b.id !== focused}
              screen={screen}
              radius={s.radius}
            />
          );
        })}
        {pins.map((p) => (
          <span
            key={p.id}
            className={`pin${p.id === s.thread ? " open" : ""}`}
            style={{ translate: `${p.x}px ${p.y}px` }}
          >
            {doc.threads.find((t) => t.id === p.id)?.messages.length ?? 0}
          </span>
        ))}
        {s.pending &&
          (() => {
            const at = pinWorld(s.pending);
            const p = toScreen(cam, at.x, at.y);
            return (
              <span className="pin open" style={{ translate: `${p.x}px ${p.y}px` }}>
                +
              </span>
            );
          })()}
      </div>
    </div>
  );
}

/**
 * A board's hairline, its title above it (yuzu-dark with the agent's mark while one works on
 * it), and the trace. Focused on a whole screen, the trace follows the screen's corners, inset
 * so none of it is lost off the edge; it blends there as the board grows to fill the screen.
 */
function BoardChrome({
  name,
  x,
  y,
  w,
  h,
  who,
  label,
  screen,
  radius,
}: {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  who?: Worker[];
  label: boolean;
  screen: Screen;
  radius: number;
}) {
  const k = Math.min(1, Math.max(0, (w / screen.w - 0.8) / 0.2));
  // On the canvas: 3px outside the board, 2px wide, round 4. Focused: 2px in, 3px wide.
  const off = -3 + 5 * k;
  const stroke = 2 + k;
  const rx = 4 + k * Math.max(0, radius - 3 - 4);
  return (
    <>
      <div
        className="ring"
        style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
      />
      {label && (
        <div
          className={`label${who ? " working" : ""}`}
          style={{ transform: `translate(${x}px, ${y - LABEL}px)`, maxWidth: Math.max(0, w) }}
        >
          <span>{name}</span>
          {who?.map((a) => (
            <span key={a.id} className="mark">
              <AgentMark client={a.client} size={11} />
            </span>
          ))}
        </div>
      )}
      {who && (
        <svg
          aria-hidden
          className="trace"
          style={{
            transform: `translate(${x + off - stroke / 2}px, ${y + off - stroke / 2}px)`,
            width: w - 2 * off + stroke,
            height: h - 2 * off + stroke,
          }}
        >
          <rect
            className="pz-trace"
            x={stroke / 2}
            y={stroke / 2}
            width={Math.max(0, w - 2 * off)}
            height={Math.max(0, h - 2 * off)}
            rx={rx}
            pathLength={100}
            fill="none"
            stroke="var(--yuzu)"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        </svg>
      )}
    </>
  );
}

/** Whether the camera shows a focused board at its focus width, where a drag across swipes. */
function atFocus(c: Camera, box: Box, screen: Screen) {
  const home = focusCamera(box, screen);
  return Math.abs(c.zoom - home.zoom) < home.zoom * 0.01;
}

function offscreen(p: Point, w: number, h: number, screen: Screen) {
  const m = 40;
  return p.x > screen.w + m || p.y > screen.h + m || p.x + w < -m || p.y + h < -m;
}

function nearestPin(pins: PinAt[], p: Point): PinAt | null {
  let best: PinAt | null = null;
  let dist = PIN_TARGET;
  for (const pin of pins) {
    const d = Math.hypot(pin.x - p.x, pin.y - p.y);
    if (d <= dist) {
      best = pin;
      dist = d;
    }
  }
  return best;
}

/**
 * A node's box in its artboard's px. Measured against the board rather than the screen, so the
 * camera doesn't matter. As desktop does.
 */
function nodeBox(vp: HTMLElement, ab: Artboard, nodeId: string): Box | null {
  const host = vp.querySelector(`[data-artboard-host="${CSS.escape(ab.id)}"]`);
  const board = host?.parentElement;
  const el = host?.shadowRoot?.querySelector(`[data-id="${CSS.escape(nodeId)}"]`);
  if (!board || !el) return null;
  const b = board.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const k = b.width / boardSize(ab.root).w;
  if (!k) return null;
  return { x: (r.left - b.left) / k, y: (r.top - b.top) / k, w: r.width / k, h: r.height / k };
}
