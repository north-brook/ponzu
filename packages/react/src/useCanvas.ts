import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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

/** Infinite-canvas camera: wheel to pan, pinch or ⌘/Ctrl-wheel to zoom, space-drag to pan. */
export function useCamera(initial: Camera = { x: 80, y: 80, zoom: 0.5 }) {
  const [camera, setCamera] = useState(initial);
  const ref = useRef(camera);
  ref.current = camera;

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setCamera((c) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * factor));
      const k = zoom / c.zoom;
      return { zoom, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k };
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    setCamera((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
  }, []);

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
      setCamera({
        zoom: z,
        x: (viewport.w - rect.w * z) / 2 - rect.x * z,
        y: (viewport.h - rect.h * z) / 2 - rect.y * z,
      });
    },
    [],
  );

  return { camera, setCamera, zoomAt, panBy, fit, cameraRef: ref };
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
        if (!(on && alone && /^Digit[1-9]$/.test(e.code))) hide();
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
