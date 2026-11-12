import type { Doc, Op } from "./doc.ts";
import type { Capture, ColorScheme, Origin, Presence } from "./protocol.ts";

/*
 * What a canvas reads its document from and sends its edits to. The interfaces live here, in
 * core, so a source can be written and type-checked without the canvas's React code: the
 * phone runs `CloudSource` in Hermes and must never pull `@ponzu/canvas` into its typecheck.
 * `@ponzu/canvas` re-exports both, so the studio's imports are unchanged.
 */

/**
 * Where the canvas gets its document and sends edits. The studio's sources are a WebSocket to
 * a local server and `CloudSource` on Ponzu Cloud; a host app can implement this over anything.
 */
export interface CanvasSource {
  subscribe(listener: (state: CanvasState) => void): () => void;
  getState(): CanvasState;
  apply(op: Op): void;
  undo(): void;
  redo(): void;
  /** Base URL for this canvas's assets. */
  assetBase?: string;
  /**
   * The host makes smaller copies of images (`?w=` on an asset, /api/image for a
   * remote one): a Ponzu server does, a plain file host doesn't.
   */
  renditions?: boolean;
  /** Upload a file into the canvas's assets, returning its relative path. */
  upload?(file: File): Promise<string>;
  /** Tell the host how the canvas looks, so agents can see artboards that way. */
  setTheme?(theme: ColorScheme): void;
  /** Tell the host which threads have an unsent reply here, so agents leave them open. */
  setWriting?(threads: string[]): void;
  /**
   * Where to get a picture of an artboard at `scale` device px per CSS px, in
   * a color scheme. `version` names its content. Without it, boards on
   * screen are always live DOM.
   */
  snapshotUrl?(artboardId: string, scale: number, version: string, scheme: ColorScheme): string;
  /** Where to get a board's motion loops (videos of its looping parts), by content version. */
  loopsUrl?(artboardId: string, version: string, scheme: ColorScheme): string;
  /** Each change as it lands, with who made it and the doc after it: for motion. */
  onOp?(listener: (op: Op, origin: Origin, doc: Doc) => void): () => void;
  /** Each screenshot or recording an agent takes of an artboard: the canvas flashes on it. */
  onCapture?(listener: (capture: Capture) => void): () => void;
}

export interface CanvasState {
  status: "connecting" | "ready" | "offline" | "error";
  doc: Doc | null;
  path: string;
  presence: Presence[];
  canUndo: boolean;
  canRedo: boolean;
  /** Artboard the server asked us to show (after an agent created it). */
  focus?: { artboard: string; page: string; at: number };
  /** Last change and who made it, for the activity indicator. */
  lastOrigin?: Origin;
  error?: string;
}
