import type { Doc } from "./doc.ts";
import type { Artboard, PElement } from "./types.ts";

/**
 * The picture of a design the home screen and Finder show: its first page
 * laid out like the canvas. The server draws it to a PNG; a live card on the
 * home screen renders the same artboard in place while an agent works.
 */
export type PreviewTheme = "light" | "dark";

/** The long side of the preview in CSS px. */
const SIZE = 512;
/** The canvas in each theme (packages/react/src/styles.css), so the preview reads as it. */
const CANVAS = { light: "#f3f3f1", dark: "#121212" };
/** The artboard edge on each canvas, at 1 preview px. */
const EDGE = {
  light: (u: number) => `0 0 0 ${u}px rgba(0,0,0,0.08), 0 ${2 * u}px ${6 * u}px rgba(0,0,0,0.08)`,
  dark: (u: number) => `0 0 0 ${u}px rgba(255,255,255,0.08)`,
};

const px = (v: string | undefined, fallback: number) =>
  v && /px$/.test(v) ? Number.parseFloat(v) || fallback : fallback;

/**
 * The first page laid out like the canvas, scaled to fit, as one artboard a
 * Renderer can shoot. Null when the page has nothing on it.
 */
export function previewArtboard(doc: Doc, theme: PreviewTheme = "light"): Artboard | null {
  const boards = doc.pages[0]?.artboards ?? [];
  if (!boards.length) return null;
  const rects = boards.map((ab) => ({
    ab,
    x: ab.x,
    y: ab.y,
    w: px(ab.root.style.width, 1440),
    h: px(ab.root.style.height, 900),
  }));
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  // A margin of canvas around the artboards, and an icon-friendly shape:
  // no wider than 16:10 and no taller than 3:4.
  const pad = Math.max(right - left, bottom - top) * 0.06;
  let w = right - left + pad * 2;
  let h = bottom - top + pad * 2;
  if (w / h > 1.6) h = w / 1.6;
  if (h / w > 4 / 3) w = h * 0.75;
  const fit = SIZE / Math.max(w, h);
  const offsetX = (w - (right - left)) / 2 - left;
  const offsetY = (h - (bottom - top)) / 2 - top;

  const children: PElement[] = rects.map(({ ab, x, y }) => ({
    ...ab.root,
    attrs: { "data-artboard": "", ...ab.root.attrs },
    name: ab.name,
    style: {
      ...ab.root.style,
      position: "absolute",
      left: `${x + offsetX}px`,
      top: `${y + offsetY}px`,
      margin: "0",
      "box-shadow": EDGE[theme](1 / fit),
    },
  }));
  const root: PElement = {
    kind: "el",
    id: "preview_canvas",
    tag: "div",
    attrs: {},
    style: {
      width: `${Math.round(w * fit)}px`,
      height: `${Math.round(h * fit)}px`,
      background: CANVAS[theme],
    },
    children: [
      {
        kind: "el",
        id: "preview_boards",
        tag: "div",
        attrs: {},
        style: {
          position: "absolute",
          left: "0",
          top: "0",
          width: `${w}px`,
          height: `${h}px`,
          transform: `scale(${fit})`,
          "transform-origin": "0 0",
        },
        children,
      },
    ],
  };
  return { id: "preview_canvas", name: doc.name, x: 0, y: 0, root };
}
