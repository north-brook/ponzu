import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CanvasSource, CanvasState } from "./connection.ts";

export function useSource(source: CanvasSource): CanvasState {
  return useSyncExternalStore(
    useCallback((cb) => source.subscribe(cb), [source]),
    () => source.getState(),
    () => source.getState(),
  );
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;

/**
 * The camera lives outside React: a gesture fires dozens of wheel events a
 * second, and re-rendering the canvas for each one re-laid out every board
 * title and re-measured every pin. Changes are coalesced to one per animation
 * frame and handed to subscribers, which write them straight to the DOM.
 */
export interface CameraStore {
  get(): Camera;
  /** Applied on the next animation frame, or right away with `now`. */
  set(next: Camera | ((c: Camera) => Camera), now?: boolean): void;
  subscribe(fn: (c: Camera) => void): () => void;
}

export function cameraStore(initial: Camera): CameraStore {
  let camera = initial;
  let frame = 0;
  const subs = new Set<(c: Camera) => void>();
  const flush = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const fn of subs) fn(camera);
  };
  return {
    get: () => camera,
    set(next, now = false) {
      camera = typeof next === "function" ? next(camera) : next;
      if (now) flush();
      else if (!frame) frame = requestAnimationFrame(flush);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Infinite-canvas camera: wheel to pan, pinch or ⌘/Ctrl-wheel to zoom, space-drag to pan. */
export function useCameraStore(initial: Camera = { x: 80, y: 80, zoom: 0.5 }) {
  const [store] = useState(() => cameraStore(initial));

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      store.set((c) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * factor));
        const k = zoom / c.zoom;
        return { zoom, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k };
      });
    },
    [store],
  );

  const panBy = useCallback(
    (dx: number, dy: number) => store.set((c) => ({ ...c, x: c.x + dx, y: c.y + dy })),
    [store],
  );

  /** Fit a world-space rectangle into a viewport. */
  const fit = useCallback(
    (
      rect: { x: number; y: number; w: number; h: number },
      viewport: { w: number; h: number },
      padding = 64,
      maxZoom = 1,
    ) => {
      // A NaN camera never recovers: every pan and zoom after it is NaN too.
      if (!(rect.w > 0 && rect.h > 0 && Number.isFinite(rect.x + rect.y + rect.w + rect.h))) return;
      const zoom = Math.min(
        maxZoom,
        (viewport.w - padding * 2) / rect.w,
        (viewport.h - padding * 2) / rect.h,
      );
      const z = Math.max(MIN_ZOOM, zoom);
      store.set(
        {
          zoom: z,
          x: (viewport.w - rect.w * z) / 2 - rect.x * z,
          y: (viewport.h - rect.h * z) / 2 - rect.y * z,
        },
        true,
      );
    },
    [store],
  );

  return { camera: store, zoomAt, panBy, fit };
}

/**
 * The camera as React state, for a host drawing its own canvas: it renders on
 * every change. The Ponzu canvas uses useCameraStore, which doesn't.
 */
export function useCamera(initial: Camera = { x: 80, y: 80, zoom: 0.5 }) {
  const { camera: store, zoomAt, panBy, fit } = useCameraStore(initial);
  const camera = useSyncExternalStore(store.subscribe, store.get, store.get);
  const ref = useRef(camera);
  ref.current = camera;
  const setCamera = useCallback(
    (next: Camera | ((c: Camera) => Camera)) => store.set(next, true),
    [store],
  );
  return { camera, setCamera, zoomAt, panBy, fit, cameraRef: ref };
}

/** The camera's zoom as a whole percentage; renders only when that number changes. */
export function useZoomPercent(camera: CameraStore): number {
  return useSyncExternalStore(
    useCallback((cb) => camera.subscribe(cb), [camera]),
    () => Math.round(camera.get().zoom * 100),
    () => Math.round(camera.get().zoom * 100),
  );
}

/**
 * A view of the camera that changes only in steps: boards and their detail
 * re-render when it changes, not on every frame of a gesture. `moving` flips
 * on the first frame of a gesture and off once it has rested `settle` ms (as
 * useCameraLayers does); `x`, `y` and `zoom` are the camera when the view
 * last changed, which is current at rest.
 */
export interface CameraView extends Camera {
  moving: boolean;
}

/**
 * Follow the camera in steps. `key` turns a camera into what matters (the
 * board tiers' quantized view): the view updates when the key changes or
 * when the camera starts or stops moving.
 */
export function useCameraView(
  camera: CameraStore,
  key: (c: Camera) => string,
  settle = 150,
): CameraView {
  const keyRef = useRef(key);
  keyRef.current = key;
  const [view, setView] = useState<CameraView>(() => ({ ...camera.get(), moving: false }));
  useEffect(() => followView(camera, (c) => keyRef.current(c), setView, settle), [camera, settle]);
  return view;
}

/** useCameraView without React: calls `show` with each new view. Returns a stop. */
export function followView(
  camera: CameraStore,
  key: (c: Camera) => string,
  show: (v: CameraView) => void,
  settle = 150,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let moving = false;
  let last = key(camera.get());
  const send = (c: Camera) => show({ ...c, moving });
  send(camera.get());
  const off = camera.subscribe((c) => {
    const k = key(c);
    if (!moving || k !== last) {
      moving = true;
      last = k;
      send(c);
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      moving = false;
      last = key(camera.get());
      send(camera.get());
    }, settle);
  });
  return () => {
    off();
    clearTimeout(timer);
  };
}

/** The scroll plane's size: the camera pans by scrolling across it. */
export const PLANE = 2 ** 18;
const MID = PLANE / 2;

/**
 * Keep the canvas on the camera without React.
 *
 * - A pan is a scroll. The boards' layer and the overlay layer sit on a large
 *   scroll plane, and panning only moves its scroll offset, which Chromium
 *   moves on the compositor without repainting or re-layerizing.
 * - A zoom writes the boards' layer's transform, once a frame. Not a Web
 *   Animation with a held raster scale: that doubles GPU memory mid-zoom,
 *   keeps it for seconds after, and is no faster.
 *
 * While the camera moves at all, the boards' layer has `will-change:
 * transform`, so it's a bitmap drawn at the zoom the gesture started at,
 * stretched (fast, but blurry once zoomed in). It's dropped once the camera
 * rests, so the boards and their animations redraw sharp.
 *
 * The overlay layer never scales: it carries the zoom as --z, which its
 * overlays (placed in page coordinates with `calc(var(--z) * Npx)`) turn into
 * screen pixels, so titles and pins keep their screen size at any zoom, mid-
 * zoom too. `onSettle` runs once the camera has rested for `settle` ms.
 */
export function useCameraLayers(
  camera: CameraStore,
  scroller: RefObject<HTMLElement | null>,
  layer: RefObject<HTMLElement | null>,
  overlay: RefObject<HTMLElement | null>,
  mounted: boolean,
  onSettle?: () => void,
  settle = 150,
) {
  const settled = useRef(onSettle);
  settled.current = onSettle;
  useLayoutEffect(() => {
    const s = scroller.current;
    if (!mounted || !s) return;
    let moving: ReturnType<typeof setTimeout> | undefined;
    let zoom = Number.NaN;
    // The layers' translation on the plane, and the scroll we last wrote. A
    // point at page p shows at tx + p * zoom - sx.
    let tx = 0;
    let ty = 0;
    let sx = MID;
    let sy = MID;

    const place = () => {
      const at = `translate(${tx}px, ${ty}px)`;
      if (layer.current) layer.current.style.transform = `${at} scale(${zoom})`;
      const o = overlay.current;
      if (!o) return;
      o.style.transform = at;
      // A few dozen absolutely placed boxes: laid out again at every zoom, cheap next to the frame.
      o.style.setProperty("--z", String(zoom));
    };
    const scrollTo = (x: number, y: number) => {
      sx = x;
      sy = y;
      if (s.scrollLeft !== x) s.scrollLeft = x;
      if (s.scrollTop !== y) s.scrollTop = y;
    };
    const apply = (c: Camera) => {
      if (c.zoom !== zoom) {
        // Zoom: the scroll stays, the layers' transform moves.
        zoom = c.zoom;
        tx = c.x + sx;
        ty = c.y + sy;
        place();
        return;
      }
      // Pan: the transform stays, the scroll moves. Rebase before it runs off the plane.
      const x = Math.round(tx - c.x);
      const y = Math.round(ty - c.y);
      if (Math.abs(x - MID) < MID / 2 && Math.abs(y - MID) < MID / 2) return scrollTo(x, y);
      tx = c.x + MID;
      ty = c.y + MID;
      place();
      scrollTo(MID, MID);
    };
    // Anything else that scrolls the plane (focusing an input near the edge,
    // arrow keys, a wheel the canvas let through) pans the camera with it. Not
    // a jump of more than a screen: Home, End or Page Down would throw the
    // camera across the whole plane, so that's put back.
    const onScroll = () => {
      if (s.scrollLeft === sx && s.scrollTop === sy) return;
      if (
        Math.abs(s.scrollLeft - sx) > s.clientWidth ||
        Math.abs(s.scrollTop - sy) > s.clientHeight
      ) {
        s.scrollLeft = sx;
        s.scrollTop = sy;
        return;
      }
      sx = s.scrollLeft;
      sy = s.scrollTop;
      const x = tx - sx;
      const y = ty - sy;
      camera.set((c) => ({ ...c, x, y }));
    };
    // The window grows or shrinks: what's on screen changes with the camera still.
    let size = `${s.clientWidth}x${s.clientHeight}`;
    const ro = new ResizeObserver(() => {
      const now = `${s.clientWidth}x${s.clientHeight}`;
      if (now === size) return;
      size = now;
      camera.set((c) => ({ ...c }));
    });
    ro.observe(s);
    // Promote the boards' layer for the whole gesture, pan or zoom: without
    // it, Chromium re-rasters its tiles (and re-decodes their images) as they
    // scroll into view or change scale.
    const endMove = () => {
      clearTimeout(moving);
      moving = undefined;
      layer.current?.style.removeProperty("will-change");
    };
    scrollTo(MID, MID);
    apply(camera.get());
    s.addEventListener("scroll", onScroll, { passive: true });
    const off = camera.subscribe((c) => {
      if (moving === undefined) layer.current?.style.setProperty("will-change", "transform");
      apply(c);
      clearTimeout(moving);
      moving = setTimeout(() => {
        endMove();
        settled.current?.();
      }, settle);
    });
    return () => {
      off();
      ro.disconnect();
      s.removeEventListener("scroll", onScroll);
      endMove();
    };
  }, [camera, scroller, layer, overlay, mounted, settle]);
}

/** Track a key held down (for space-to-pan). */
export function useKeyHeld(code: string): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === code && !isTyping(e)) {
        setHeld(true);
        if (code === "Space") e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => e.code === code && setHeld(false);
    const blur = () => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [code]);
  return held;
}

/**
 * Whether a modifier has been held on its own for a moment, so the 1–9 it jumps with
 * can show. It waits because ⌘ is down for ⌘Z too. Another key, a click or a scroll
 * hides it, except the digits it shows, so you can keep jumping while you hold it.
 */
export function useModifierHint(key: "Meta" | "Control" | "Alt", delay = 250): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let on = false;
    const show = (next: boolean) => {
      on = next;
      setShown(next);
    };
    const hide = () => {
      clearTimeout(timer);
      show(false);
    };
    const down = (e: KeyboardEvent) => {
      const alone =
        e.metaKey === (key === "Meta") &&
        e.ctrlKey === (key === "Control") &&
        e.altKey === (key === "Alt") &&
        !e.shiftKey;
      if (e.key !== key) {
        if (!(on && alone && /^Digit[0-9]$/.test(e.code))) hide();
        return;
      }
      // Windows repeats a held Ctrl; that's still the same hold.
      if (e.repeat) return;
      hide();
      if (alone && !isTyping(e)) timer = setTimeout(() => show(true), delay);
    };
    const up = (e: KeyboardEvent) => e.key === key && hide();
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("wheel", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [key, delay]);
  return shown;
}

export function isTyping(e: Event): boolean {
  const t = e.composedPath()[0] as HTMLElement | undefined;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
