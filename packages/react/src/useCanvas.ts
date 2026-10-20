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
      if (rect.w <= 0 || rect.h <= 0) return;
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

export function isTyping(e: Event): boolean {
  const t = e.composedPath()[0] as HTMLElement | undefined;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
