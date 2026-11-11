import { ArtboardView } from "@ponzu/canvas";
import {
  type Artboard,
  type Doc,
  findArtboard,
  isThemed,
  pinOnNode,
  threadPage,
} from "@ponzu/core";
import { COMMENT_PICTURE } from "@ponzu/runner/protocol";
import { domToBlob } from "modern-screenshot";
import { type CSSProperties, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { distanceTo, OPEN_LIMIT, pictureArea, type Rect } from "./comment-area.ts";

/*
 * A comment's picture: the area of the page round its pin, as the canvas draws it (the boards
 * on their ground, each in the theme the canvas gives it, with its sheet's corners and shadow)
 * and the pin as the canvas marks it, yuzu with its number. `CommentScene` draws it in the
 * page's own engine from the document as it was when the comment was made; `drawCommentPicture`
 * turns it into the two WebP files the thread shows, light and dark, at twice their size.
 */

const { width: WIDTH, height: HEIGHT, scale: SCALE } = COMMENT_PICTURE;
/** Boards farther than this from the pin, in page px, are not drawn at all. */
const REACH = 2600;
/** The canvas's board corners, in screen px (Canvas.tsx `BOARD_RADIUS`). */
const BOARD_RADIUS = 4;
/** The pin, in the picture's px: the canvas's, a size down to sit in a thumbnail. */
const PIN = 18;

export type Theme = "light" | "dark";

/** An artboard's width, and its height where it says one (else it is as tall as its content). */
function declared(ab: Artboard): { w: number; h: number | null } {
  const w = Number.parseFloat(ab.root.style.width ?? "") || 1440;
  const raw = ab.root.style.height;
  const h = raw && /^\d+(\.\d+)?px$/.test(raw) ? Number.parseFloat(raw) : null;
  return { w, h };
}

/** The area framed round the pin, or null when there is nothing round it to show. */
type Framed = { area: Rect; pin: { x: number; y: number } } | null;

/** What a comment points at in a document: its thread, page and board, and the pin's number. */
export function commentIn(doc: Doc, threadId: string, messageId: string) {
  const thread = doc.threads.find((t) => t.id === threadId);
  const page = thread ? threadPage(doc, thread) : null;
  if (!thread || !page) return null;
  const board = thread.artboardId ? findArtboard(doc, thread.artboardId)?.artboard : undefined;
  // The pin's number is its thread's messages as this one left it.
  const index = thread.messages.findIndex((m) => m.id === messageId);
  const number = index >= 0 ? index + 1 : thread.messages.length;
  return { thread, page, board: board ?? null, number };
}

/**
 * Whether a comment can have a picture, before anything is drawn: one on a board always can; one
 * on the open canvas only with a board in reach (`OPEN_LIMIT`), taking a board that doesn't say
 * its height as reaching down without end, so this never says no where `pictureArea` would
 * find a board.
 */
export function hasPictureArea({
  doc,
  threadId,
  messageId,
}: {
  doc: Doc;
  threadId: string;
  messageId: string;
}): boolean {
  const comment = commentIn(doc, threadId, messageId);
  if (!comment) return false;
  if (comment.board) return true;
  const pin = { x: comment.thread.x, y: comment.thread.y };
  return comment.page.artboards.some((ab) => {
    const { w, h } = declared(ab);
    return distanceTo(pin, { x: ab.x, y: ab.y, w, h: h ?? Number.MAX_SAFE_INTEGER }) <= OPEN_LIMIT;
  });
}

/**
 * The area round a comment's pin, drawn at the picture's size. It lays the nearby boards out
 * unseen first, to know their heights and the node the pin is on, then frames the area
 * (`pictureArea`) and shows it; `onFramed` hears when it has, or `onEmpty` that there is nothing
 * round the pin to show (a pin on the open canvas far from every board), and it draws nothing.
 */
export function CommentScene({
  doc,
  threadId,
  messageId,
  theme,
  assetBase,
  onFramed,
  onEmpty,
}: {
  doc: Doc;
  threadId: string;
  messageId: string;
  theme: Theme;
  assetBase?: string | undefined;
  onFramed?: (scene: HTMLElement) => void;
  onEmpty?: () => void;
}) {
  const scene = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  // Undefined until framed.
  const [framed, setFramed] = useState<Framed | undefined>(undefined);
  const comment = useMemo(() => commentIn(doc, threadId, messageId), [doc, threadId, messageId]);
  // Measured from the pin's spot as it was saved, so the layer's px are page px less this.
  const origin = useMemo(
    () =>
      comment
        ? {
            x: Math.round((comment.board?.x ?? 0) + comment.thread.x),
            y: Math.round((comment.board?.y ?? 0) + comment.thread.y),
          }
        : { x: 0, y: 0 },
    [comment],
  );
  const near = useMemo(
    () =>
      (comment?.page.artboards ?? []).filter((ab) => {
        const { w, h } = declared(ab);
        const across = ab.x < origin.x + REACH && ab.x + w > origin.x - REACH;
        const down = ab.y < origin.y + REACH && (h === null || ab.y + h > origin.y - REACH);
        return across && down;
      }),
    [comment, origin],
  );

  // Before the first paint: lay out, measure, frame.
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el || !comment || framed !== undefined) return;
    const rects = new Map<string, Rect>();
    for (const ab of near) {
      const sheet = el.querySelector<HTMLElement>(`[data-scene-board="${CSS.escape(ab.id)}"]`);
      rects.set(ab.id, { x: ab.x, y: ab.y, w: declared(ab).w, h: sheet?.offsetHeight ?? 0 });
    }
    const { thread, board } = comment;
    const boardRect = board ? (rects.get(board.id) ?? null) : null;
    let node: Rect | null = null;
    let pin = origin;
    if (board && boardRect && thread.nodeId) {
      const sheet = el.querySelector(`[data-scene-board="${CSS.escape(board.id)}"]`);
      const host = sheet?.querySelector("[data-artboard-host]")?.shadowRoot;
      const target = host?.querySelector(`[data-id="${CSS.escape(thread.nodeId)}"]`);
      if (sheet && target) {
        const s = sheet.getBoundingClientRect();
        const r = target.getBoundingClientRect();
        const box = { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
        const on = pinOnNode(thread, box);
        pin = { x: board.x + on.x, y: board.y + on.y };
        node = { x: board.x + box.x, y: board.y + box.y, w: box.w, h: box.h };
      }
    }
    const area = pictureArea({
      pin,
      boards: [...rects.values()],
      board: boardRect,
      node,
      aspect: WIDTH / HEIGHT,
    });
    setFramed(area ? { area, pin } : null);
  }, [comment, near, framed, origin]);

  useLayoutEffect(() => {
    if (framed === null) onEmpty?.();
    else if (framed && scene.current) onFramed?.(scene.current);
  }, [framed, onFramed, onEmpty]);

  if (framed === null) return null;

  const k = framed ? WIDTH / framed.area.w : 1;
  const shown = framed
    ? near.filter((ab) => {
        const { w, h } = declared(ab);
        const { area } = framed;
        return (
          ab.x < area.x + area.w &&
          ab.x + w > area.x &&
          ab.y < area.y + area.h &&
          (h === null || ab.y + h > area.y)
        );
      })
    : near;
  return (
    <div
      ref={scene}
      aria-hidden
      className={`pz-root pz-${theme}`}
      style={{
        display: "block",
        position: "relative",
        width: WIDTH,
        height: HEIGHT,
        overflow: "hidden",
        background: "var(--pz-canvas)",
      }}
    >
      <div
        ref={layer}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "0 0",
          // Unseen while it is laid out to be measured.
          visibility: framed ? "visible" : "hidden",
          transform: framed
            ? `scale(${k}) translate(${origin.x - framed.area.x}px, ${origin.y - framed.area.y}px)`
            : undefined,
        }}
      >
        {shown.map((ab) => {
          const { w, h } = declared(ab);
          return (
            <div
              key={ab.id}
              data-scene-board={ab.id}
              style={
                {
                  position: "absolute",
                  left: ab.x - origin.x,
                  top: ab.y - origin.y,
                  width: w,
                  height: h ?? undefined,
                  borderRadius: BOARD_RADIUS / k,
                  boxShadow: "var(--pz-board-shadow)",
                  "--pz-board-radius": `${BOARD_RADIUS / k}px`,
                } as CSSProperties
              }
            >
              <ArtboardView
                artboard={ab}
                tokens={doc.tokens}
                {...(assetBase ? { assetBase } : {})}
                colorScheme={isThemed(doc.tokens, ab.root) ? theme : "light"}
                rounded
                hold
              />
            </div>
          );
        })}
      </div>
      {framed && comment ? (
        <span
          style={{
            position: "absolute",
            left: (framed.pin.x - framed.area.x) * k - PIN / 2,
            top: (framed.pin.y - framed.area.y) * k - PIN / 2,
            width: PIN,
            height: PIN,
            display: "grid",
            placeItems: "center",
            borderRadius: 999,
            background: "var(--pz-comment)",
            color: "var(--pz-comment-ink)",
            font: "600 10px/1 var(--pz-font)",
            fontVariantNumeric: "tabular-nums",
            boxShadow: "0 0 0 1px rgba(17,17,16,0.18), 0 1px 3px rgba(0,0,0,0.25)",
          }}
        >
          {comment.number}
        </span>
      ) : null}
    </div>
  );
}

/** There is nothing round the comment's pin to show: it goes without a picture, by design. */
export class NoPicture extends Error {
  override name = "NoPicture";
  constructor() {
    super("There is nothing round the comment's pin to show.");
  }
}

/** How long a picture may take before the comment goes without one. */
const DRAW_MS = 15_000;

/**
 * The picture of where a comment was left, in both themes, as WebP at `COMMENT_PICTURE.scale`:
 * the scene drawn off screen, its fonts and images in, its animations at their ends, and then
 * turned into an image by modern-screenshot (the DOM, with its computed styles and the fonts and
 * images it uses, into an SVG and onto a canvas). Rejects when it can't be had.
 */
export async function drawCommentPicture(given: {
  doc: Doc;
  threadId: string;
  messageId: string;
  assetBase?: string | undefined;
}): Promise<Record<Theme, Blob>> {
  if (!commentIn(given.doc, given.threadId, given.messageId)) {
    throw new Error("The comment isn't in the document.");
  }
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.dataset.commentPicture = "";
  Object.assign(host.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${WIDTH}px`,
    height: `${HEIGHT}px`,
    pointerEvents: "none",
  });
  document.body.append(host);
  const root = createRoot(host);
  const deadline = Date.now() + DRAW_MS;
  try {
    const out: Partial<Record<Theme, Blob>> = {};
    for (const theme of ["light", "dark"] as const) {
      const scene = await new Promise<HTMLElement>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The picture took too long.")), DRAW_MS);
        root.render(
          <CommentScene
            key={theme}
            {...given}
            theme={theme}
            onFramed={(el) => {
              clearTimeout(timer);
              resolve(el);
            }}
            onEmpty={() => {
              clearTimeout(timer);
              reject(new NoPicture());
            }}
          />,
        );
      });
      await settle(scene, deadline);
      const blob = await domToBlob(scene, {
        scale: SCALE,
        type: "image/webp",
        quality: 0.9,
        width: WIDTH,
        height: HEIGHT,
        timeout: Math.max(1_000, deadline - Date.now()),
        fetchFn: (url) => crossOriginImage(url, given.assetBase),
      });
      if (blob.type !== "image/webp") throw new Error("This browser can't write WebP.");
      out[theme] = blob;
    }
    return out as Record<Theme, Blob>;
  } finally {
    root.unmount();
    host.remove();
  }
}

/**
 * A drawn scene ready to be taken: its fonts loaded, its boards' images decoded (or given up
 * on), and every animation at its end, or held where it is if it never ends, so nothing is
 * caught on its way in.
 */
async function settle(scene: HTMLElement, deadline: number): Promise<void> {
  const roots = [...scene.querySelectorAll("[data-artboard-host]")].flatMap((host) =>
    host.shadowRoot ? [host.shadowRoot] : [],
  );
  const images = roots.flatMap((root) => [...root.querySelectorAll("img")]);
  const wait = Math.max(0, Math.min(4_000, deadline - Date.now()));
  await Promise.race([
    Promise.all([
      document.fonts.ready,
      ...images.map((img) => {
        img.loading = "eager";
        return img.decode().catch(() => {});
      }),
    ]),
    new Promise((resolve) => setTimeout(resolve, wait)),
  ]);
  for (const root of roots) {
    for (const animation of root.getAnimations()) {
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === "number" && Number.isFinite(end)) animation.finish();
      else animation.pause();
    }
  }
  // A frame for what that changed to be laid out.
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

/**
 * An image from another site, as a data URL: loaded the way the canvas loads it, asking for
 * CORS, and drawn onto a canvas, which only an image its host lets be read can be. False for
 * the design's own files and anything else, which modern-screenshot fetches itself.
 */
async function crossOriginImage(url: string, assetBase?: string): Promise<string | false> {
  if (!/^https?:\/\//.test(url)) return false;
  const own = assetBase ? new URL(assetBase).origin : null;
  if (new URL(url).origin === own || new URL(url).origin === location.origin) return false;
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return false;
  }
}
