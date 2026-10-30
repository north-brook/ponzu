/*
 * The phone's canvas: a page of artboards drawn exactly as desktop draws them (each in its own
 * shadow root, with the design's tokens and fonts), on a plane a finger pans and two fingers
 * pinch. Double-tap a board to focus it (pinch out, or pan past it, to leave), hold to comment, tap
 * a pin to read its thread. Labels,
 * pins and rings sit on screen above the boards, so they stay a fixed size at any zoom. No
 * chrome: the app draws that around the web view.
 */
import { Edit03Icon } from "@hugeicons/core-free-icons";
import { type Artboard, isThemed, threadPage } from "@ponzu/core";
import {
  type CSSProperties,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
// Desktop's own pieces, from source: the app doesn't depend on @ponzu/react, whose index pulls
// in the whole studio canvas.
import { ArtboardView } from "../../../packages/react/src/Artboard.tsx";
import {
  type Arrivals,
  arriveBoard,
  arriveName,
  drawFrame,
  RING_OUT_MS,
  ringDelay,
} from "../../../packages/react/src/arrive.ts";
import { useWindowStill } from "../../../packages/react/src/still.ts";
import { Rain, useLingering } from "../../../packages/react/src/working.tsx";
import {
  BOARD_RADIUS,
  type Box,
  between,
  boardSize,
  type Camera,
  CameraStore,
  CameraTrack,
  clampToBox,
  commentCamera,
  easeFollow,
  easeOut,
  focusCamera,
  followCamera,
  GLIDE_STEP_MS,
  glide,
  LABEL,
  labelCovers,
  onPixels,
  overlayCamera,
  overview,
  pinPoint,
  REST,
  readingOrder,
  ringAround,
  type Screen,
  threadPoint,
  toScreen,
  toWorld,
  transformOf,
  zoomAt,
} from "./camera.ts";
import { doubleTapFocus, Gestures, type Point } from "./gestures.ts";
import { arrivals, getState, placeUnsent, send, setPage, subscribe } from "./store.ts";

/** How long a focus, or a snap back, takes. */
const MOVE_MS = 420;
/** A pinch that leaves a focused board this much smaller lets go of it. */
const LET_GO = 0.85;
/** A tap this close to a pin opens it: a 24px pin, a 44px target. */
const PIN_TARGET = 22;
/** A column of rain and its gap, in em of the label's 12px. */
const RAIN_PITCH = 0.42 * 12;

/** The board radius in page px for a zoom: the same few px on screen, to a quarter octave. */
function boardRadius(zoom: number) {
  return BOARD_RADIUS / 2 ** (Math.round(Math.log2(zoom) * 4) / 4);
}

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

  const byId = useMemo(() => new Map(boxes.map((b) => [b.id, b])), [boxes]);

  // The camera isn't React state: a frame moves the world's transform and the overlay above it,
  // never the boards, which re-render only when what they show (or whether they hold) changes.
  const camRef = useRef<Camera>({ x: 0, y: 0, zoom: 0.4 });
  const camera = useMemo(() => new CameraStore(camRef), []);
  /** The overlay's element: a layer that slides with the world's while the camera pans. */
  const overlayEl = useRef<HTMLDivElement>(null);
  /** The zoom the world's layer was drawn at. */
  const layerZoom = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const layers = (on: boolean) => {
    for (const el of [world.current, overlayEl.current]) {
      if (on) el?.style.setProperty("will-change", "transform");
      else el?.style.removeProperty("will-change");
    }
  };
  // Set as it's asked for: a touch reaches here once a frame (the gestures' track), and a glide or
  // an ease from its frame, so the camera shows in that frame rather than the next.
  const setCam = (c: Camera) => {
    if (!Number.isFinite(c.x + c.y + c.zoom)) return;
    camRef.current = c;
    camera.resting = false;
    const w = world.current;
    // A layer while it moves, so a frame only moves it.
    if (w && !w.style.willChange) {
      layerZoom.current = c.zoom;
      layers(true);
    }
    clearTimeout(settle.current);
    settle.current = setTimeout(rest, 150);
    // On the screen's own pixels: a layer kept at rest on a fraction of one draws soft.
    if (w) w.style.transform = transformOf(onPixels(c, window.devicePixelRatio));
    camera.emit();
  };
  /** The camera has stopped. */
  const rest = () => {
    const w = world.current;
    if (!w) return;
    const c = camRef.current;
    camera.resting = true;
    // Zoomed while it was a layer, the boards are a bitmap drawn at the old zoom, blurry once
    // zoomed in: off, they redraw sharp. Only panned, the layer is as sharp as it was and stays
    // one, so the next pan doesn't start by drawing every board on screen into a new layer.
    if (w.style.willChange && layerZoom.current !== c.zoom) layers(false);
    // Only at rest, and when it crosses a quarter octave: each change restyles every board.
    const r = `${boardRadius(c.zoom)}px`;
    if (w.style.getPropertyValue("--pz-board-radius") !== r)
      w.style.setProperty("--pz-board-radius", r);
    camera.emit();
  };
  useEffect(() => () => clearTimeout(settle.current), []);

  /** A camera move under way (a focus, a snap, a glide), stopped by the next touch. */
  const motion = useRef(0);
  const stop = () => {
    cancelAnimationFrame(motion.current);
    motion.current = 0;
  };
  const reportZoom = () => send({ t: "camera", zoom: camRef.current.zoom });
  const animateTo = (to: Camera, ms = MOVE_MS, ease = easeOut) => {
    stop();
    if (ms <= 0) {
      setCam(to);
      reportZoom();
      return;
    }
    const from = camRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      setCam(between(from, to, ease(t), screen));
      if (t < 1) motion.current = requestAnimationFrame(step);
      else {
        motion.current = 0;
        reportZoom();
      }
    };
    motion.current = requestAnimationFrame(step);
  };
  /**
   * A released pan keeps going and slows; on a focused board it stops at the board's edges.
   * `from` is the frame the finger was last shown in, so the first frame after the lift moves as
   * far as any other rather than the sliver since the lift.
   */
  const coast = (v: Point, box: Box | null, from = performance.now()) => {
    stop();
    let vel = v;
    let last = from;
    const step = (now: number) => {
      const dt = Math.min(GLIDE_STEP_MS, Math.max(0, now - last));
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
  const boxOf = (id: string | null) => (id ? (byId.get(id) ?? null) : null);

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
  // The page's fit-content boards, once measured: the first fit used a stand-in height, so a
  // measurement reframes the page until someone has touched it.
  const sized = useMemo(
    () =>
      boards
        .filter((ab) => boardSize(ab.root).h === null)
        .map((ab) => `${ab.id}=${measured[ab.id] ?? ""}`)
        .join(","),
    [boards, measured],
  );
  const sheetOpen = Boolean(s.pending || s.thread);
  // The window changing size (iPhone Duo opening, closing or turning) keeps the camera: the
  // boards stay where they were and the rest of the page lays out beside them.
  const lastSize = useRef(screenSize);
  useLayoutEffect(() => {
    const resized = lastSize.current.w !== screenSize.w || lastSize.current.h !== screenSize.h;
    lastSize.current = screenSize;
    if (!page || !fitKey) return;
    // A focused board keeps the camera too: a measurement or an inset changing doesn't pull it
    // back out to the page. A new page still reframes (and drops the focus, below).
    if (fitted.current === fitKey && (touched.current || sheetOpen || resized || focused)) return;
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
  }, [fitKey, screen, sized]);

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

  // Standby: the camera eases to each board the agent touches and rests there.
  const followAsk = s.follow;
  useEffect(() => {
    if (!followAsk) return;
    const box = boxOf(followAsk.id);
    if (box) animateTo(followCamera(box, screen), followAsk.ms, easeFollow);
  }, [followAsk]);
  // Out of standby the page is framed again, as it opens.
  const wasStandby = useRef(false);
  useEffect(() => {
    if (wasStandby.current && !s.standby) {
      const c = overview(boxes, screen);
      if (c) animateTo(c);
    }
    wasStandby.current = s.standby;
  }, [s.standby]);

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

  // Which boards agents are working on, and who. A board stays ringed a moment after its agent
  // leaves, so the ring can fade.
  const working = useMemo(() => {
    const map = new Map<string, Worker[]>();
    for (const p of s.presence) {
      if (p.kind !== "agent" || (p.file && s.file && p.file !== s.file)) continue;
      for (const id of p.working)
        map.set(id, [...(map.get(id) ?? []), { id: p.id, client: p.client }]);
    }
    return map;
  }, [s.presence, s.file]);
  const ringed = useLingering(working, RING_OUT_MS);

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

  /** Where each open thread's pin is on screen, for a camera. */
  const pinsAt = (c: Camera): PinAt[] =>
    threads.map((t) => ({
      id: t.id,
      ...pinPoint(t, t.artboardId ? byId.get(t.artboardId) : undefined, nodes[t.id] ?? null, c),
    }));

  /** Where a thread or a new comment's pin is on the page. */
  const pinWorld = (t: { artboardId?: string; x: number; y: number }) => {
    const box = boxOf(t.artboardId ?? null);
    return { box, x: (box?.x ?? 0) + t.x, y: (box?.y ?? 0) + t.y };
  };

  /**
   * The unsent comment whose pin is being moved: it holds still on screen, here, while the design
   * moves under it.
   */
  const [held, setHeld] = useState<{ key: string; x: number; y: number } | null>(null);
  /** The layer under the held pin, on the page: where it would land. */
  const [target, setTarget] = useState<Box | null>(null);

  /** Where each unsent comment's pin is on screen, for a camera, by its draft's key. */
  const unsentAt = (c: Camera): PinAt[] =>
    s.unsent.flatMap((u) => {
      if (u.key === held?.key) return [];
      const w = pinWorld(u);
      return [{ id: u.key, ...toScreen(c, w.x, w.y) }];
    });

  // Writing a comment, or reading a thread: its board comes up and its pin stays above the sheet.
  const openThread = s.thread ? doc?.threads.find((t) => t.id === s.thread) : undefined;
  const about = s.pending ?? openThread ?? null;
  // Keyed on the pin, not the thread: every op rebuilds the doc, and a new thread object would
  // pull the camera back while someone pans. A pin that moves still reframes.
  useEffect(() => {
    if (!about) return;
    const at = pinWorld(about);
    const held = Boolean(s.pending);
    if (!at.box) {
      animateTo(
        commentCamera(
          { x: at.x - 1, y: at.y - 1, w: 2, h: 2 },
          at,
          camRef.current,
          screen,
          s.sheet,
          held,
        ),
      );
      return;
    }
    const next = commentCamera(at.box, at, camRef.current, screen, s.sheet, held);
    const c = camRef.current;
    if (next.x !== c.x || next.y !== c.y || next.zoom !== c.zoom) animateTo(next);
  }, [s.pending, s.thread, about?.artboardId, about?.x, about?.y, s.sheet]);

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

  useEffect(() => {
    const key = s.moving;
    const at = key ? unsentAt(camRef.current).find((p) => p.id === key) : undefined;
    setHeld(key && at ? { key, x: at.x, y: at.y } : null);
  }, [s.moving]);

  // Moving, the layer under the pin is outlined as the design passes under it.
  useEffect(() => {
    if (!held) return setTarget(null);
    const aim = () => {
      const hit = hitTest(held);
      const ab = hit && boards.find((a) => a.id === hit.box.id);
      const node =
        ab && hit.nodeId && viewport.current ? nodeBox(viewport.current, ab, hit.nodeId) : null;
      const r = !hit
        ? null
        : node
          ? { x: hit.box.x + node.x, y: hit.box.y + node.y, w: node.w, h: node.h }
          : { x: hit.box.x, y: hit.box.y, w: hit.box.w, h: hit.box.h };
      setTarget((t) => (sameBox(t, r) ? t : r));
    };
    aim();
    return camera.subscribe(aim);
  }, [held, boxes]);

  // Done: the pin lands on the layer under it, and the app moves the draft there.
  const placed = useRef(s.place);
  useEffect(() => {
    if (s.place === placed.current) return;
    placed.current = s.place;
    if (!held || !page) return;
    // Still gliding, the design stops where it is: the pin lands where it was shown.
    stop();
    const hit = hitTest(held);
    const pin = {
      ...(hit ? { artboardId: hit.box.id } : { pageId: page.id }),
      ...threadPoint(camRef.current, held.x, held.y, hit?.box),
    };
    send({
      t: "moved",
      key: held.key,
      pageId: page.id,
      ...pin,
      ...(hit?.nodeId ? { nodeId: hit.nodeId } : {}),
    });
    placeUnsent(held.key, pin);
    setHeld(null);
  }, [s.place]);

  // Gestures read the latest render through a ref: one listener for the canvas's life.
  const latest = useRef({
    held,
    pinsAt,
    unsentAt,
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
    held,
    pinsAt,
    unsentAt,
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
    // The fingers move a target camera, at each touch's own time; each frame shows the track's
    // camera for that frame, a touch's interval behind (camera.ts, CameraTrack).
    const track = new CameraTrack();
    let target = camRef.current;
    /** The time of the touch being handled. */
    let at = 0;
    let follow = 0;
    /** The frame the track last showed. */
    let shownAt = 0;
    const frame = (now: number) => {
      follow = 0;
      const t = now - track.lag;
      const c = track.at(t);
      const cur = camRef.current;
      if (c && (c.x !== cur.x || c.y !== cur.y || c.zoom !== cur.zoom)) {
        setCam(c);
        shownAt = now;
      }
      if (track.newest > t) follow = requestAnimationFrame(frame);
    };
    const steer = (c: Camera) => {
      target = c;
      track.push(at, c);
      if (!follow) follow = requestAnimationFrame(frame);
    };
    const halt = () => {
      cancelAnimationFrame(follow);
      follow = 0;
      track.clear();
    };
    const g = new Gestures({
      down() {
        touched.current = true;
        told = false;
        latest.current.stop();
        halt();
        target = camRef.current;
        shownAt = 0;
        // Where the camera was when the finger landed, so the first move eases out of it.
        track.push(at, target);
      },
      pan(dx, dy) {
        moving();
        const { focused, boxes, screen } = latest.current;
        const c = target;
        let next = { ...c, x: c.x + dx, y: c.y + dy };
        const box = focused ? boxes.find((b) => b.id === focused) : undefined;
        if (box) {
          // Across a board at its focus, a drag shows the next one; otherwise it stays in bounds.
          const held = clampToBox(next, box, screen);
          next = { ...held, x: atFocus(c, box, screen) ? next.x : held.x };
        }
        steer(next);
      },
      pinchStart(center) {
        moving();
        pinchBase = { cam: target, center };
      },
      pinch(scale, center) {
        if (!pinchBase) return;
        const z = zoomAt(
          pinchBase.cam,
          pinchBase.cam.zoom * scale,
          pinchBase.center.x,
          pinchBase.center.y,
        );
        steer({
          ...z,
          x: z.x + center.x - pinchBase.center.x,
          y: z.y + center.y - pinchBase.center.y,
        });
      },
      release(v, moved) {
        pinchBase = null;
        // The camera goes on from where it's shown, a touch behind the finger: what's left of
        // the track is a few px a glide covers anyway.
        halt();
        const from = shownAt || performance.now();
        const { focused, boxes, screen, focus, unfocus, animateTo, coast } = latest.current;
        const box = focused ? boxes.find((b) => b.id === focused) : undefined;
        const c = camRef.current;
        if (!box) return coast(v, null, from);
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
        coast(v, box, from);
      },
      tap(p) {
        const { held, pinsAt, unsentAt } = latest.current;
        // Moving a pin, only the design moves.
        if (held) return;
        const unsentPins = unsentAt(camRef.current);
        const hit = nearestPin([...pinsAt(camRef.current), ...unsentPins], p);
        send(
          !hit
            ? { t: "tap" }
            : unsentPins.includes(hit)
              ? { t: "openUnsent", key: hit.id }
              : { t: "openThread", id: hit.id },
        );
      },
      doubleTap(p) {
        const { focused, hitTest, focus } = latest.current;
        const id = doubleTapFocus(focused, focused ? null : (hitTest(p)?.box.id ?? null));
        if (id) focus(id);
      },
      longPress(p) {
        const { held, hitTest, page, unsentAt } = latest.current;
        if (!page || held) return;
        // An unsent comment's pin: the app offers to open, move or discard it.
        const unsent = nearestPin(unsentAt(camRef.current), p);
        if (unsent) {
          send({ t: "holdUnsent", key: unsent.id });
          return;
        }
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
    /**
     * When a touch happened: WebKit stamps it with UIKit's own time, not when the page got to it,
     * so a busy page still reads a finger's speed (and a flick's glide) right. Else now.
     */
    const stamp = (e: Event) => {
      const now = performance.now();
      at = e.timeStamp > now - 1000 && e.timeStamp <= now + 1 ? e.timeStamp : now;
      return at;
    };
    const start = (e: TouchEvent) => {
      e.preventDefault();
      g.touchStart(points(e.changedTouches), stamp(e));
    };
    const move = (e: TouchEvent) => {
      e.preventDefault();
      g.touchMove(points(e.changedTouches), stamp(e));
    };
    const end = (e: TouchEvent) => {
      e.preventDefault();
      g.touchEnd(points(e.changedTouches), stamp(e));
    };
    // A mouse, in the dev harness on a desktop, is one finger.
    let mouse = false;
    const mdown = (e: MouseEvent) => {
      mouse = true;
      g.touchStart([{ id: -1, x: e.clientX, y: e.clientY }], stamp(e));
    };
    const mmove = (e: MouseEvent) =>
      mouse && g.touchMove([{ id: -1, x: e.clientX, y: e.clientY }], stamp(e));
    const mup = (e: MouseEvent) => {
      if (!mouse) return;
      mouse = false;
      g.touchEnd([{ id: -1 }], stamp(e));
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
      halt();
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
  const standby = s.standby;

  const scheme = (ab: Artboard) => (isThemed(doc.tokens, ab.root) ? s.theme : "light");

  return (
    <div ref={viewport} className={standby ? "viewport standby" : "viewport"}>
      <div
        ref={world}
        className="world"
        style={
          {
            transform: transformOf(onPixels(camRef.current, window.devicePixelRatio)),
            "--pz-board-radius": `${boardRadius(camRef.current.zoom)}px`,
          } as CSSProperties
        }
      >
        {boards.map((ab) => (
          <Board
            key={ab.id}
            artboard={ab}
            width={byId.get(ab.id)!.w}
            tokens={doc.tokens}
            assetBase={s.assetBase}
            colorScheme={scheme(ab)}
          />
        ))}
      </div>

      {/* On screen, so they stay crisp and a fixed size at any zoom. */}
      <Overlay
        layer={overlayEl}
        camera={camera}
        boards={boards}
        boxes={boxes}
        working={working}
        ringed={ringed}
        arrivals={arrivals}
        focused={focused}
        standby={standby}
        screen={screen}
        radius={s.radius}
        pinsAt={pinsAt}
        unsentAt={unsentAt}
        writing={s.writing}
        threads={doc.threads}
        open={s.thread}
        pending={s.pending ? pinWorld(s.pending) : null}
        target={target}
      />
      {held && (
        <span
          className="pin unsent held"
          role="img"
          aria-label="Moving comment"
          style={{ translate: `${held.x}px ${held.y}px` }}
        >
          <Pencil />
        </span>
      )}
    </div>
  );
}

/** One artboard on the page: rendered when it, the tokens or its theme change, never because the camera moved. */
const Board = memo(function Board({
  artboard: ab,
  width,
  tokens,
  assetBase,
  colorScheme,
}: {
  artboard: Artboard;
  width: number;
  tokens: string;
  assetBase?: string;
  colorScheme: "light" | "dark";
}) {
  return (
    <div
      ref={(el) => {
        // An agent's new board draws in from when it landed, as on desktop.
        const at = el ? arrivals.takeBoard(ab.id) : undefined;
        if (el && at !== undefined) arriveBoard(el, at);
      }}
      className="board"
      style={{ left: ab.x, top: ab.y, width, height: boardSize(ab.root).h ?? undefined }}
    >
      <ArtboardView
        artboard={ab}
        tokens={tokens}
        assetBase={assetBase}
        colorScheme={colorScheme}
        arrivals={arrivals}
        rounded
      />
    </div>
  );
});

/**
 * Labels, hairlines, rings, new boards' frames and pins: on screen above the boards, following
 * the camera. A pan slides the whole overlay as one layer; it's drawn again when the zoom
 * changes, when it has slid half a screen, and when the camera rests (`overlayCamera`).
 */
function Overlay({
  layer,
  camera,
  boards,
  boxes,
  working,
  ringed,
  arrivals,
  focused,
  standby,
  screen,
  radius,
  pinsAt,
  unsentAt,
  writing,
  threads,
  open,
  pending,
  target,
}: {
  layer: { current: HTMLDivElement | null };
  camera: CameraStore;
  boards: Artboard[];
  boxes: (Box & { id: string })[];
  working: Map<string, Worker[]>;
  ringed: Map<string, boolean>;
  arrivals: Arrivals;
  focused: string | null;
  standby: boolean;
  screen: Screen;
  radius: number;
  pinsAt: (c: Camera) => PinAt[];
  unsentAt: (c: Camera) => PinAt[];
  writing: string[];
  threads: { id: string; messages: unknown[] }[];
  open: string | null;
  pending: { x: number; y: number } | null;
  /** The layer under a pin being moved, on the page. */
  target: Box | null;
}) {
  const drift = { x: screen.w / 2, y: screen.h / 2 };
  const want = useRef<Camera | null>(null);
  // The camera it's drawn for: the same one, so no render, while a pan only slides it.
  const cam = useSyncExternalStore(camera.subscribe, () => {
    want.current = overlayCamera(want.current, camera.get(), drift, camera.resting);
    return want.current;
  });
  // Slid by however far the camera is from the one it was drawn for: each frame of a pan, and
  // again once it's drawn anew.
  const drawn = useRef(cam);
  const slide = () => {
    const el = layer.current;
    if (!el) return;
    const c = camera.get();
    const dx = c.x - drawn.current.x;
    const dy = c.y - drawn.current.y;
    el.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
  };
  useLayoutEffect(() => {
    drawn.current = cam;
    slide();
  });
  useLayoutEffect(() => camera.subscribe(slide), [camera]);
  const still = useWindowStill();
  const names = useMemo(() => new Map(boards.map((a) => [a.id, a.name])), [boards]);
  const counts = useMemo(() => new Map(threads.map((t) => [t.id, t.messages.length])), [threads]);
  return (
    <div ref={layer} className={still ? "overlay still" : "overlay"}>
      {boxes.map((b) => {
        const p = toScreen(cam, b.x, b.y);
        const w = b.w * cam.zoom;
        const h = b.h * cam.zoom;
        // Drawn as far past the screen as the overlay slides before it's drawn again.
        if (offscreen(p, w, h, screen, drift)) return null;
        const who = working.get(b.id);
        const showLabel = !!who || !labelCovers(b, boxes, cam.zoom);
        return (
          <BoardChrome
            key={b.id}
            name={names.get(b.id) ?? ""}
            x={p.x}
            y={p.y}
            w={w}
            h={h}
            who={who}
            ring={ringed.get(b.id)}
            arrivedAt={arrivals.boardAt(b.id)}
            label={showLabel && b.id !== focused && !standby}
            screen={screen}
            radius={radius}
          />
        );
      })}
      {target &&
        (() => {
          const p = toScreen(cam, target.x, target.y);
          return (
            <span
              className="target"
              style={{
                translate: `${p.x}px ${p.y}px`,
                width: target.w * cam.zoom,
                height: target.h * cam.zoom,
              }}
            />
          );
        })()}
      {!standby &&
        pinsAt(cam).map((p) => (
          <span
            key={p.id}
            className={`pin${p.id === open ? " open" : ""}`}
            style={{ translate: `${p.x}px ${p.y}px` }}
          >
            {writing.includes(p.id) ? <Pencil /> : (counts.get(p.id) ?? 0)}
          </span>
        ))}
      {!standby &&
        unsentAt(cam).map((p) => (
          <span
            key={p.id}
            className="pin unsent"
            role="img"
            aria-label="Unsent comment"
            style={{ translate: `${p.x}px ${p.y}px` }}
          >
            <Pencil />
          </span>
        ))}
      {pending &&
        (() => {
          const p = toScreen(cam, pending.x, pending.y);
          return (
            <span className="pin open" style={{ translate: `${p.x}px ${p.y}px` }}>
              <Pencil />
            </span>
          );
        })()}
    </div>
  );
}

/**
 * A board's hairline, its title above it (with yuzu rain on the right while an agent works on
 * it), and the ring: yuzu, a few px off its edge, breathing slowly, fading out once the agent
 * leaves. Where the board reaches the screen's edges, the ring follows them, inset so none of it
 * is lost, and rounds with the screen's corners where it reaches those (`ringAround`). A new board's
 * frame draws itself where the ring will be, and its name develops with it. As desktop's.
 */
function BoardChrome({
  name,
  x,
  y,
  w,
  h,
  who,
  ring,
  arrivedAt,
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
  /** Ringed: false while an agent works on it, true as the ring fades. */
  ring?: boolean;
  /** When the board landed, while it's still arriving. */
  arrivedAt?: number;
  label: boolean;
  screen: Screen;
  radius: number;
}) {
  const edge = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (edge.current && arrivedAt !== undefined) arriveBoard(edge.current, arrivedAt);
  }, [arrivedAt]);
  useLayoutEffect(() => {
    if (title.current && arrivedAt !== undefined) arriveName(title.current, arrivedAt);
  }, [arrivedAt, label]);
  const around = ringAround({ x, y, w, h }, screen, radius);
  // The rain takes at most half the board's width, so the name still reads on a narrow one; on
  // a board too narrow for a column, the ring alone says it's being worked on.
  const rain = Math.min(24, Math.floor(w / 2 / RAIN_PITCH));
  const ringBox = {
    transform: `translate(${around.x}px, ${around.y}px)`,
    width: around.w,
    height: around.h,
  };
  return (
    <>
      <div
        ref={edge}
        className="edge"
        style={{ transform: `translate(${x}px, ${y}px)`, width: w, height: h }}
      />
      {label && (
        <div
          className="label"
          style={{
            transform: `translate(${x}px, ${y - LABEL}px)`,
            // Spans the board so the rain can sit on the right.
            ...(who ? { width: Math.max(0, w) } : { maxWidth: Math.max(0, w) }),
          }}
        >
          <span ref={title} className="name">
            {name}
          </span>
          {who && rain > 0 && <Rain columns={rain} label="Working" />}
        </div>
      )}
      {ring !== undefined && (
        <Ring box={ringBox} corners={around.corners} leaving={ring} delay={ringDelay(arrivedAt)} />
      )}
      {arrivedAt !== undefined && (
        // An SVG rect has one radius: the tightest corner, so it hugs the board.
        <Frame box={ringBox} rx={Math.min(...around.corners)} at={arrivedAt} />
      )}
    </>
  );
}

/** The ring round a working board. It fades in after `delay` ms (a new board's frame is still drawing). */
function Ring({
  box,
  corners,
  leaving,
  delay,
}: {
  box: CSSProperties;
  /** Top left, top right, bottom right, bottom left. */
  corners: readonly number[];
  leaving: boolean;
  delay: number;
}) {
  // Fixed when it mounts: a running animation whose delay changed would jump.
  const [wait] = useState(delay);
  return (
    <div aria-hidden className="ring-box" style={{ ...box, opacity: leaving ? 0 : 1 }}>
      <div
        className="pz-ring"
        style={{
          borderRadius: corners.map((r) => `${r}px`).join(" "),
          animationDelay: `${wait}ms`,
        }}
      />
    </div>
  );
}

/** A new board's frame drawing itself round its bounds from when it landed, then fading as the ring takes over. */
function Frame({ box, rx, at }: { box: CSSProperties; rx: number; at: number }) {
  const rect = useRef<SVGRectElement>(null);
  useLayoutEffect(() => {
    if (rect.current) drawFrame(rect.current, at);
  }, [at]);
  return (
    <svg aria-hidden className="frame" style={box}>
      <rect
        ref={rect}
        x={1}
        y={1}
        style={{ width: "calc(100% - 2px)", height: "calc(100% - 2px)" }}
        rx={rx}
        pathLength={100}
        fill="none"
        stroke="var(--yuzu)"
        strokeWidth={2}
        strokeDasharray="100 100"
        strokeDashoffset={100}
      />
    </svg>
  );
}

/** Whether the camera shows a focused board at its focus width, where a drag across swipes. */
function atFocus(c: Camera, box: Box, screen: Screen) {
  const home = focusCamera(box, screen);
  return Math.abs(c.zoom - home.zoom) < home.zoom * 0.01;
}

function offscreen(
  p: Point,
  w: number,
  h: number,
  screen: Screen,
  past: { x: number; y: number } = { x: 0, y: 0 },
) {
  const mx = 40 + past.x;
  const my = 40 + past.y;
  return p.x > screen.w + mx || p.y > screen.h + my || p.x + w < -mx || p.y + h < -my;
}

/**
 * The pencil on a comment being written: an unsent comment's pin, and a thread's while a reply to
 * it is unsent. Hugeicons' Edit03, as desktop's (packages/react/src/icons.tsx, Pencil).
 */
function Pencil() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {Edit03Icon.map(([tag, a]) =>
        tag === "path" ? <path key={String(a.d)} d={String(a.d)} /> : null,
      )}
    </svg>
  );
}

function sameBox(a: Box | null, b: Box | null) {
  if (!a || !b) return a === b;
  const near = (m: number, n: number) => Math.abs(m - n) < 0.5;
  return near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
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
