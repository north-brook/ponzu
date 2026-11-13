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
import { domToForeignObjectSvg } from "modern-screenshot";
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

/** The boards of a page a comment's picture can show: those within `REACH` of its pin. */
function boardsNear(page: { artboards: Artboard[] }, origin: { x: number; y: number }): Artboard[] {
  return page.artboards.filter((ab) => {
    const { w, h } = declared(ab);
    const across = ab.x < origin.x + REACH && ab.x + w > origin.x - REACH;
    const down = ab.y < origin.y + REACH && (h === null || ab.y + h > origin.y - REACH);
    return across && down;
  });
}

/** Where a comment's pin was saved, in page px. */
function pinOrigin(comment: NonNullable<ReturnType<typeof commentIn>>): { x: number; y: number } {
  return {
    x: Math.round((comment.board?.x ?? 0) + comment.thread.x),
    y: Math.round((comment.board?.y ?? 0) + comment.thread.y),
  };
}

/**
 * A document cut down to what a comment's picture is drawn from: its thread, and its page with
 * only the boards in reach of the pin. `CommentScene` draws the same picture from it as from the
 * whole document; it is what goes to the desktop's picture window, a fraction of a big canvas.
 * Null when the comment isn't in the document.
 */
export function pictureDoc(doc: Doc, threadId: string, messageId: string): Doc | null {
  const comment = commentIn(doc, threadId, messageId);
  if (!comment) return null;
  const near = boardsNear(comment.page, pinOrigin(comment));
  // The pin's own board, wherever its pin is: the scene finds it by id.
  if (comment.board && !near.includes(comment.board)) near.push(comment.board);
  return {
    name: doc.name,
    pages: [{ ...comment.page, artboards: near }],
    tokens: doc.tokens,
    threads: [comment.thread],
    notes: {},
  };
}

/**
 * Whether a comment can have a picture, before anything is drawn: one on a board always can; one
 * on the ground only with a board in reach (`OPEN_LIMIT`), taking a board that doesn't say
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
 * round the pin to show (a pin on the ground far from every board), and it draws nothing.
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
  const origin = useMemo(() => (comment ? pinOrigin(comment) : { x: 0, y: 0 }), [comment]);
  const near = useMemo(() => (comment ? boardsNear(comment.page, origin) : []), [comment, origin]);

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
                  // The canvas's edge, one px in the picture whatever its scale (Canvas.tsx).
                  boxShadow: `0 0 0 ${1 / k}px var(--pz-board-edge), var(--pz-board-drop)`,
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
 * How a picture shares its renderer. `now`: it has one to itself (the desktop's picture window),
 * so it goes straight through. `idle`: it is drawn in the person's own window, so it starts when
 * the window is idle and lets the window answer between each of its steps: what a step takes is
 * still the window's, but a key or a click waits for one step, not the whole picture.
 */
export type Pace = "now" | "idle";

/** Lets the window answer what is waiting, then goes on. */
function yieldToWindow(pace: Pace): Promise<void> {
  if (pace === "now") return Promise.resolve();
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits until the window has nothing else to do, for a second at most. */
function whenIdle(pace: Pace): Promise<void> {
  if (pace === "now") return Promise.resolve();
  if (typeof requestIdleCallback !== "function") return yieldToWindow(pace);
  return new Promise((resolve) => requestIdleCallback(() => resolve(), { timeout: 1_000 }));
}

/**
 * The picture of where a comment was left, in both themes, as WebP at `COMMENT_PICTURE.scale`:
 * the scene drawn off screen, its fonts and images in, its animations at their ends, and then
 * turned into an image (`rasterise`: what of the DOM shows in the picture, with its computed
 * styles and the fonts and images it uses, into an SVG and onto a <canvas>). Rejects when it
 * can't be had. In the person's own window, `pace: "idle"` (see `Pace`).
 */
export async function drawCommentPicture(given: {
  doc: Doc;
  threadId: string;
  messageId: string;
  assetBase?: string | undefined;
  pace?: Pace;
}): Promise<Record<Theme, Blob>> {
  const { pace = "now", ...comment } = given;
  if (!commentIn(comment.doc, comment.threadId, comment.messageId)) {
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
      await whenIdle(pace);
      const scene = await new Promise<HTMLElement>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The picture took too long.")), DRAW_MS);
        root.render(
          <CommentScene
            key={theme}
            {...comment}
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
      await yieldToWindow(pace);
      await settle(scene, deadline);
      out[theme] = await rasterise(scene, deadline, comment.assetBase, pace);
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
  // A frame for what that changed to be laid out; or, in a window that draws no frames (the
  // desktop's hidden picture window may not), a moment: what is read next is laid out anyway.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * How far past the picture's edge, in its own px, a part of a board still counts as in it: room
 * for what a layout box doesn't say. What an element's own shadows, filters and outlines paint
 * outside its box is added to the box itself (`paintReach`). Half the picture's width.
 */
const MARGIN = WIDTH / 2;

/** Every length in a computed value, in px, added up regardless of sign. */
function pxSum(value: string): number {
  let sum = 0;
  for (const match of value.matchAll(/(-?[\d.]+)px/g)) sum += Math.abs(Number(match[1]));
  return sum;
}

/**
 * How far, in the element's own CSS px, what it paints may reach past its box: its box and text
 * shadows (offsets, blur and spread together), its filter (a blur reaches about three times its
 * radius) and its outline. Overstated on purpose: too much only copies a little more.
 */
function paintReach(style: CSSStyleDeclaration): number {
  const outline =
    style.outlineStyle !== "none" ? pxSum(style.outlineWidth) + pxSum(style.outlineOffset) : 0;
  const filter = style.filter !== "none" ? 3 * pxSum(style.filter) : 0;
  const shadow = style.boxShadow !== "none" ? pxSum(style.boxShadow) : 0;
  const text = style.textShadow !== "none" ? pxSum(style.textShadow) : 0;
  return Math.max(outline, shadow, text) + filter;
}

/**
 * A drawn scene as a WebP file, by modern-screenshot: the scene copied with its computed styles
 * into an SVG, which is drawn onto a <canvas>.
 *
 * Only what can show is copied. A board is far bigger than the picture's area round its pin, and
 * copying every element of it with its whole computed style is what used to take seconds and
 * build an SVG of tens of millions of characters. So an element that lies wholly outside the
 * picture, with everything under it, is copied as an empty box of its own size (`outsideOf`),
 * which keeps the layout of what is in the picture as it was. Of each element's computed style
 * only the properties that can change how it looks are copied (`drawnProperties`): every element
 * inherits the canvas's and its tokens' custom properties, hundreds of them, which the values
 * of the others already have in them. And of the fonts, only the faces whose characters the
 * picture has (`keepUsedFaces`).
 *
 * The SVG has to reach the image as a data: URL (one from a blob: URL, with a foreignObject in
 * it, taints the canvas), and Chromium keeps the address of each image it has loaded for the
 * life of the window. So the smaller the SVG, the less each picture leaves behind. And the image
 * is read with `decode()`, never a load handler: Chromium also keeps a long-running handler's
 * element, named by its src, in its long-animation-frame entries.
 */
async function rasterise(
  scene: HTMLElement,
  deadline: number,
  assetBase: string | undefined,
  pace: Pace,
): Promise<Blob> {
  const outside = outsideOf(scene);
  await yieldToWindow(pace);
  const svg = await domToForeignObjectSvg(scene, {
    width: WIDTH,
    height: HEIGHT,
    timeout: Math.max(1_000, deadline - Date.now()),
    fetchFn: (url) => crossOriginImage(url, assetBase),
    includeStyleProperties: drawnProperties(),
    filter: (node) => {
      const parent = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
      return !(parent instanceof Element && outside.has(parent));
    },
    onCreateForeignObjectSvg: keepUsedFaces,
  });
  await yieldToWindow(pace);
  const xml = new XMLSerializer()
    .serializeToString(svg)
    // Characters XML doesn't allow, which would leave the SVG unreadable (as modern-screenshot).
    .replace(/[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, "");
  const image = new Image();
  try {
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await image.decode();
    await yieldToWindow(pace);
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH * SCALE;
    canvas.height = HEIGHT * SCALE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("There is no canvas to draw the picture on.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.9),
    );
    if (!blob) throw new Error("The picture couldn't be written.");
    if (blob.type !== "image/webp") throw new Error("This browser can't write WebP.");
    return blob;
  } finally {
    image.removeAttribute("src");
  }
}

/**
 * Properties that never change a still picture: how an element answers a pointer, a caret, a
 * selection or a scroll, and how it would move from one style to the next. `will-change` is not
 * one of them: `will-change: transform` (or opacity, filter) makes a stacking context and a
 * containing block, so a fixed or absolute descendant is laid out against it.
 */
const UNDRAWN =
  /^(cursor|caret-color|pointer-events|touch-action|user-select|-webkit-user-select|-webkit-user-drag|-webkit-user-modify|-webkit-tap-highlight-color|interpolate-size|transition(-.*)?|scroll-.*|overscroll-.*)$/;

let drawn: string[] | undefined;
/**
 * The CSS properties an element's computed style has that a still copy of it needs: not custom
 * properties (`--*`), since a computed value has its var()s already put in, nor `UNDRAWN`.
 */
function drawnProperties(): string[] {
  if (!drawn) {
    const all = getComputedStyle(document.documentElement);
    drawn = Array.from({ length: all.length }, (_, i) => all.item(i)).filter(
      (name) => !name.startsWith("--") && !UNDRAWN.test(name),
    );
  }
  return drawn;
}

/**
 * Takes out of a picture's SVG the font faces none of its characters are in, by their
 * `unicode-range`: a typeface comes as a face per script (Latin, Cyrillic, Greek, ...), each
 * embedded whole, and a picture mostly needs one. A face without a range is kept.
 */
function keepUsedFaces(svg: SVGElement): void {
  const style = svg.querySelector("style");
  if (!style?.textContent) return;
  const used = new Set<number>();
  for (const node of svg.querySelectorAll("foreignObject *")) {
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      for (const char of child.textContent ?? "") used.add(char.codePointAt(0)!);
    }
    // A field's words are in its attributes.
    for (const name of ["value", "placeholder"]) {
      for (const char of node.getAttribute(name) ?? "") used.add(char.codePointAt(0)!);
    }
  }
  // The pseudo-elements' text is in the style's own rules, as their `content`.
  for (const match of style.textContent.matchAll(/content: '([^']*)'/g)) {
    for (const char of match[1]!) used.add(char.codePointAt(0)!);
  }
  style.textContent = style.textContent.replace(/@font-face\s*{[^}]*}/g, (face) => {
    const range = /unicode-range:\s*([^;}]+)/.exec(face)?.[1];
    if (!range) return face;
    const spans = range.split(",").map((part) => {
      const [from, to = from] = part.trim().replace(/^U\+/i, "").split("-");
      const wild = from!.includes("?");
      return wild
        ? [
            Number.parseInt(from!.replace(/\?/g, "0"), 16),
            Number.parseInt(from!.replace(/\?/g, "F"), 16),
          ]
        : [Number.parseInt(from!, 16), Number.parseInt(to!, 16)];
    });
    for (const point of used) {
      if (spans.some(([lo, hi]) => point >= lo! && point <= hi!)) return face;
    }
    return "";
  });
}

/**
 * Whether an element of this display, copied with its computed size but not its children, takes
 * the same room: not an inline one or `display: contents`, whose size is their content's, nor a
 * table's rows and cells, whose content sizes the columns of the rows beside them.
 */
function keepsItsSize(display: string): boolean {
  return display !== "inline" && display !== "contents" && !/^table-/.test(display);
}

/**
 * The elements of a drawn scene that lie wholly outside the picture, with all under them (the
 * boxes of everything below, as laid out and widened by what each paints past its box
 * (`paintReach`), `MARGIN` round the picture), and whose own size holds
 * without them (`keepsItsSize`): copied without their children, they take the same room. The
 * parts of any other element outside are looked at in turn.
 */
function outsideOf(scene: Element): Set<Element> {
  const frame = scene.getBoundingClientRect();
  const left = frame.left - MARGIN;
  const top = frame.top - MARGIN;
  const right = frame.right + MARGIN;
  const bottom = frame.bottom + MARGIN;
  const outside = new Set<Element>();
  type Box = { l: number; t: number; r: number; b: number };
  // The scale an element without a width of its own is drawn at: its parent's.
  let inherited = 1;
  // Every element's box joined with all under it: what it and its descendants cover.
  const covered = (el: Element): Box | null => {
    const own = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // The element's own paint past its box, in screen px: its CSS px times the scale it is drawn
    // at (the scene's, and any transform of its own), or that of its parent when it has no width.
    const width = el instanceof HTMLElement ? el.offsetWidth : 0;
    const scale = width > 0 ? own.width / width : inherited;
    const reach = paintReach(style) * scale;
    let box: Box | null =
      own.width > 0 || own.height > 0
        ? { l: own.left - reach, t: own.top - reach, r: own.right + reach, b: own.bottom + reach }
        : null;
    const outer = inherited;
    inherited = scale;
    // The children modern-screenshot copies: a shadow root's in place of the element's own.
    for (const child of (el.shadowRoot ?? el).children) {
      const under = covered(child);
      if (!under) continue;
      box = box
        ? {
            l: Math.min(box.l, under.l),
            t: Math.min(box.t, under.t),
            r: Math.max(box.r, under.r),
            b: Math.max(box.b, under.b),
          }
        : under;
    }
    inherited = outer;
    const shows = box !== null && box.l < right && box.r > left && box.t < bottom && box.b > top;
    if (!shows && el !== scene && (el.shadowRoot ?? el).firstChild !== null) {
      if (keepsItsSize(style.display)) outside.add(el);
    }
    return box;
  };
  covered(scene);
  return outside;
}

/**
 * An image from another site, as a data URL: loaded the way the canvas loads it, asking for
 * CORS, and drawn onto a <canvas>, which only an image its host lets be read can be. False for
 * the canvas's own files and anything else, which modern-screenshot fetches itself.
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
    const bitmap = document.createElement("canvas");
    bitmap.width = img.naturalWidth;
    bitmap.height = img.naturalHeight;
    bitmap.getContext("2d")?.drawImage(img, 0, 0);
    return bitmap.toDataURL("image/png");
  } catch {
    return false;
  }
}
