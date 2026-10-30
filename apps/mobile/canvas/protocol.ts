/*
 * The canvas web view and the app talk in these messages, as JSON strings. The app owns the
 * network: it holds the design's socket and the doc, and tells the web view what to draw. The web
 * view draws and reports gestures; it never talks to the Mac except to load a design's images and
 * fonts. Types only, so the app can import this without pulling in the web view's code.
 */
import type { Doc, Op, Origin, Presence } from "@ponzu/core";

export type Theme = "light" | "dark";

/** What the app's chrome covers, in px from each edge: the canvas frames work in the rest. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Where a new comment's "+" pin sits, as a Thread has it: on an artboard, in its own px; on the
 * open canvas, at a position on the page.
 */
export interface PendingPin {
  artboardId?: string;
  pageId?: string;
  x: number;
  y: number;
}

/**
 * One gesture, measured by the page (canvas/probe.ts) from its first touch until the camera came
 * to rest, as the harness measures them (apps/mobile/perf): rAF frames and camera moves. A type,
 * not an interface, so it goes to telemetry as event properties as it is.
 */
export type GesturePerf = {
  /** One finger dragged, two pinched, or neither: the camera moved after a tap (a double-tap's focus). */
  kind: "pan" | "pinch" | "focus";
  /** From the first touch to the camera's last move. */
  ms: number;
  /** rAF frames a second, the 95th percentile and longest frame (ms), and frames over 33 ms. */
  fps: number;
  p95: number;
  max: number;
  jank: number;
  /** Frames in which the camera moved, per second of moving, and the longest wait between two. */
  moves: number;
  movesPerS: number;
  maxGapMs: number;
  /** Main-thread tasks over 50 ms and the longest, where WebKit reports them. */
  longTasks?: number;
  longestTaskMs?: number;
  /** Boards on the page. */
  boards: number;
};

/** App → web view. */
export type ToCanvas =
  /**
   * The whole design, on open and after a reconnect. `assetBase` is the design's
   * `http://<mac>:7777/files/<key>`; `file` is its key, so presence from other designs is ignored.
   */
  | { t: "doc"; doc: Doc; assetBase: string; theme: Theme; page?: string; file?: string }
  /** One change from the socket, applied on echo. With an agent's or a disk save's `origin`, it develops in. */
  | { t: "op"; op: Op; origin?: Origin }
  /** Who's here: agents' `working` artboards get the yuzu ring and rain in their label. */
  | { t: "presence"; presence: Presence[] }
  /** The "+" pin of a comment being written, or none. Its board comes into view. */
  | { t: "pending"; pin: PendingPin | null }
  /**
   * New comments left unsent, by their draft's key: each keeps a pin, to tap and go on. `threads`
   * have a reply left unsent: their pins are ringed, dashed.
   */
  | { t: "unsent"; pins: (PendingPin & { key: string })[]; threads: string[] }
  /** The thread whose sheet is open: its pin stands out, and its board comes into view. */
  | { t: "thread"; id: string | null }
  /** Focus an artboard at 1:1, or go back to where the canvas was. */
  | { t: "focus"; artboardId: string | null }
  /**
   * Standby (iPhone Duo set down while an agent works): the page alone on black, no labels or
   * pins, rings kept. Off, the canvas is as it was.
   */
  | { t: "standby"; on: boolean }
  /**
   * Ease the camera to frame an artboard, as standby follows an agent: `ms` long on the slow
   * ease (cubic-bezier(.45,0,.2,1)), or a cut with `ms` 0 (Reduce Motion). Not a focus.
   */
  | { t: "follow"; artboardId: string; ms: number }
  | { t: "theme"; theme: Theme }
  | { t: "page"; pageId: string }
  /**
   * What the chrome covers. `sheet` is how far a comment or thread sheet rises from the bottom:
   * the pin it's about stays above it. `radius` is the screen's corner, which a focused board's
   * ring follows.
   */
  | { t: "insets"; insets: Insets; sheet?: number; radius?: number }
  /**
   * Measure this share of gestures, 0 (none, as it starts) to 1 (every one): each measured one
   * comes back as `perf`.
   */
  | { t: "probe"; rate: number };

/** Web view → app. */
export type FromCanvas =
  /** Listening: send the doc. */
  | { t: "ready" }
  /**
   * A finger held still on the canvas for half a second: start a comment there. Coordinates are a
   * Thread's: artboard px with `artboardId`, page px without.
   */
  | { t: "longpress"; pageId: string; artboardId?: string; nodeId?: string; x: number; y: number }
  /** A pin was tapped. */
  | { t: "openThread"; id: string }
  /** An unsent comment's pin was tapped: its sheet comes back, with its words. */
  | { t: "openUnsent"; key: string }
  /** A tap that wasn't on a pin: the app puts its keyboard down, if it's up. */
  | { t: "tap" }
  /**
   * An artboard is focused, or none is: by a double-tap, a pinch away or a `focus` message. Sent
   * again with the same board when a pan or pinch on it settles and it's still focused.
   */
  | { t: "focused"; artboardId: string | null }
  /** A pan or pinch began on the focused board: the app shows its chrome while it lasts. */
  | { t: "gesture" }
  /** The first page is drawn and framed: the app's loading placeholder can give way to it. */
  | { t: "drawn" }
  /** Where the zoom settled after a gesture. */
  | { t: "camera"; zoom: number }
  /** The canvas changed page itself, to focus an artboard on another one. */
  | { t: "page"; pageId: string }
  /** A gesture measured, when the app asked for it (`probe`). */
  | { t: "perf"; gesture: GesturePerf }
  | { t: "error"; message: string };

/** The web view's entry point on `window`, for `injectJavaScript`. */
export const CANVAS_BRIDGE = "__ponzuCanvas";

/**
 * A message as a script for `WebView.injectJavaScript`, the quickest way in. `postMessage` with
 * `JSON.stringify(msg)` works too.
 */
export function toCanvasScript(msg: ToCanvas): string {
  return `window.${CANVAS_BRIDGE}&&window.${CANVAS_BRIDGE}.receive(${JSON.stringify(msg)});true;`;
}

/** A web view message, or null when it isn't one of ours. */
export function parseFromCanvas(data: string): FromCanvas | null {
  try {
    const msg = JSON.parse(data) as FromCanvas;
    return msg && typeof msg === "object" && typeof msg.t === "string" ? msg : null;
  } catch {
    return null;
  }
}
