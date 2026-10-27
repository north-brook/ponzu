import {
  type Artboard,
  type Author,
  findArtboard,
  isThemed,
  locate,
  newId,
  serializeArtboardElement,
  type Thread,
  threadPage,
} from "@ponzu/core";
import {
  type CSSProperties,
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArtboardView } from "./Artboard.tsx";
import { Arrivals, arriveBoard, arriveName, drawFrame, RING_OUT_MS, ringDelay } from "./arrive.ts";
import { Composer, ThreadCard, threadCard } from "./Comments.tsx";
import { boardCost, coldLive, coldSkeleton, placeholderFill } from "./coldopen.ts";
import { type CanvasSource, viewOnly } from "./connection.ts";
import { type DraftPin, draftKey, unsent, useDrafts } from "./drafts.ts";
import { Icon, Icons } from "./icons.tsx";
import { centreDistance, detailScale, onScreen, visibleBand } from "./lod.ts";
import { playing } from "./loops.tsx";
import { Pacer } from "./pacer.tsx";
import { TieredBoard, thawed, versionOf } from "./snapshot.tsx";
import { useWindowStill } from "./still.ts";
import { Button, cn, ShortcutHint, Tip, TipProvider, ToggleGroup } from "./ui.tsx";
import {
  type CameraStore,
  isTyping,
  PLANE,
  useCameraLayers,
  useCameraStore,
  useCameraView,
  useKeyHeld,
  useModifierHint,
  useSource,
  useZoomPercent,
} from "./useCanvas.ts";
import { Juice, Rain, useDelayed, useLingering } from "./working.tsx";

export type Mode = "select" | "hand" | "comment";

export interface CanvasProps {
  source: CanvasSource;
  /** Who's using the canvas, for comments. */
  me?: Author;
  theme?: "light" | "dark";
  /** Float page tabs (bottom left) and tools (bottom right) over the canvas. Default true. */
  footer?: boolean;
  /** Extra content at the start of the tools bar, before the modes. */
  footerExtra?: ReactNode;
  /**
   * Look, don't touch: pan, zoom, switch pages, select and read comment
   * threads, but never send an edit. For showing a design you can't save,
   * like one on GitHub. Default false.
   */
  readOnly?: boolean;
  /**
   * The page shown, for a host that picks pages itself (with `footer` off, say). Without it the
   * canvas keeps its own, starting on the first.
   */
  page?: string;
  /** Called whenever the canvas changes page: a tab, a shortcut, an agent's focus. */
  onPageChange?: (id: string) => void;
  /**
   * How a page is framed when it shows. "page" fits every board (the default); "first" fits the
   * top-left board to the width, from its top, for a narrow screen to scroll down from.
   */
  initialFit?: "page" | "first";
  /** An artboard to open on, from a link: its page shows with the board framed. */
  artboard?: string;
  className?: string;
}

/** Where a new comment is being written: an offset inside the artboard in its px, or a page position. */
type Pending = DraftPin;

/**
 * Whether a board follows the theme. isThemed stringifies the whole board,
 * which on a 2 MB board costs more than a frame: once per board object (an
 * edit makes a new one) and tokens.
 */
const themedCache = new WeakMap<Artboard, { tokens: string; themed: boolean }>();
function themed(tokens: string, ab: Artboard): boolean {
  const hit = themedCache.get(ab);
  if (hit && hit.tokens === tokens) return hit.themed;
  const t = isThemed(tokens, ab.root);
  themedCache.set(ab, { tokens, themed: t });
  return t;
}

/** "first" framing: px either side of the board, and above it, under its label. */
const FIRST_SIDE = 16;
const FIRST_TOP = 16 + 22;
/** A board's title sits this many screen px above it (the label's `top`). */
const LABEL = 22;
/** Boards are ever so slightly rounded: screen px, at any zoom. */
const BOARD_RADIUS = 4;
/** The ring round a working board sits this many screen px off its edge. */
const RING_GAP = 4;

/**
 * Whether a board's title, a fixed size on screen above it, would lie over another board: zoomed
 * out, or with boards close together, it would read as that board's. Then it's hidden.
 */
export function labelCovers(
  ab: { id: string; x: number; y: number; w: number },
  others: { id: string; x: number; y: number; w: number; h: number }[],
  zoom: number,
): boolean {
  const top = ab.y - LABEL / zoom;
  return others.some(
    (o) => o.id !== ab.id && o.x < ab.x + ab.w && o.x + o.w > ab.x && o.y < ab.y && o.y + o.h > top,
  );
}

/** Below this many screen px on its longer side, a board is a thumbnail: its loops hold. */
export const TINY_BOARD = 160;

/**
 * Whether a board is out of sight or too small on screen to watch, so its loops can hold. A page
 * of looping boards zoomed out to fit drew as much as one at full size, for nothing anyone sees.
 */
export function outOfSight(
  box: { x: number; y: number; w: number; h: number },
  camera: { x: number; y: number; zoom: number },
  viewport: { w: number; h: number },
): boolean {
  const x = box.x * camera.zoom + camera.x;
  const y = box.y * camera.zoom + camera.y;
  const w = box.w * camera.zoom;
  const h = box.h * camera.zoom;
  if (x + w <= 0 || y + h <= 0 || x >= viewport.w || y >= viewport.h) return true;
  return Math.max(w, h) < TINY_BOARD;
}

/**
 * More boards in view than this and the view is crowded: while the camera moves over it, loops
 * hold. Over a few boards, everything keeps moving.
 */
export const CROWD = 4;

/**
 * A board is in view with at least this share of it on screen. Zoomed in on one board, the
 * edges of its neighbours peeking in don't count.
 */
export const IN_VIEW = 0.25;

/**
 * Whether more than {@link CROWD} boards are in view (a quarter of each on screen, and bigger
 * than a thumbnail), so loops hold while the camera moves.
 */
export function crowded(
  boxes: Iterable<{ x: number; y: number; w: number; h: number }>,
  camera: { x: number; y: number; zoom: number },
  viewport: { w: number; h: number },
): boolean {
  let n = 0;
  for (const b of boxes) {
    if (outOfSight(b, camera, viewport)) continue;
    const x = b.x * camera.zoom + camera.x;
    const y = b.y * camera.zoom + camera.y;
    const w = b.w * camera.zoom;
    const h = b.h * camera.zoom;
    const seen =
      (Math.min(x + w, viewport.w) - Math.max(x, 0)) *
      (Math.min(y + h, viewport.h) - Math.max(y, 0));
    if (seen >= w * h * IN_VIEW && ++n > CROWD) return true;
  }
  return false;
}

/** The boards a selection box drawn from one corner to the other touches, in page order. */
export function boardsIn(
  a: { x: number; y: number },
  b: { x: number; y: number },
  boxes: { id: string; x: number; y: number; w: number; h: number }[],
): string[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return boxes
    .filter((o) => o.x <= x1 && o.x + o.w >= x0 && o.y <= y1 && o.y + o.h >= y0)
    .map((o) => o.id);
}

/** An artboard's size; h is null when it isn't a px length, so the canvas measures it. */
export function size(ab: Artboard) {
  const w = Number.parseFloat(ab.root.style.width ?? "") || 1440;
  const hRaw = ab.root.style.height;
  // Not just /px$/: "fit-contentpx" ends in px and parses to NaN, which poisons the camera.
  const h = hRaw && /^\d+(\.\d+)?px$/.test(hRaw) ? Number.parseFloat(hRaw) : null;
  return { w, h };
}

/**
 * The Ponzu canvas: pages of artboards on an infinite plane, comments pinned
 * to nodes, and live presence. Read-only for layout (agents do the editing);
 * people select, comment, rename and arrange. With `readOnly`, they only look.
 */
export function Canvas({
  source: given,
  me = { kind: "user", name: "You" },
  theme = "light",
  footer = true,
  footerExtra,
  readOnly = false,
  page: pageProp,
  onPageChange,
  initialFit = "page",
  artboard: linked,
  className,
}: CanvasProps) {
  // Read-only hides the controls that edit; this catches anything they missed.
  const source = useMemo(() => (readOnly ? viewOnly(given) : given), [given, readOnly]);
  const state = useSource(source);
  const doc = state.doc;
  const [ownPageId, setOwnPageId] = useState<string | null>(null);
  const pageId = pageProp ?? ownPageId;
  const setPageId = (id: string) => {
    setOwnPageId(id);
    onPageChange?.(id);
  };
  const page = doc?.pages.find((p) => p.id === pageId) ?? doc?.pages[0];
  const [mode, setMode] = useState<Mode>("select");
  const space = useKeyHeld("Space");
  const panning = mode === "hand" || space;
  const { camera, zoomAt, panBy, fit } = useCameraStore();
  const still = useWindowStill();
  const viewport = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** Artboard and node ids, for this canvas only: agents point with comments instead. */
  const [selection, setSelection] = useState<string[]>([]);
  const fitted = useRef<string | null>(null);

  const working = useMemo(() => {
    const map = new Map<string, Worker[]>();
    for (const p of state.presence) {
      if (p.file && p.file !== state.path) continue;
      for (const id of p.working)
        map.set(id, [
          ...(map.get(id) ?? []),
          { id: p.id, name: p.name, client: p.client, status: p.status },
        ]);
    }
    return map;
  }, [state.presence, state.path]);
  const busyPages = useMemo(
    () =>
      new Set(
        doc?.pages.filter((p) => p.artboards.some((ab) => working.has(ab.id))).map((p) => p.id),
      ),
    [doc, working],
  );
  const opening = useDelayed(!doc || !page);

  // Agents' screenshots default to how this canvas shows artboards.
  useEffect(() => source.setTheme?.(theme), [source, theme]);

  // An agent's work, and files saved straight into the design, develop onto the canvas; the
  // person's own edits here just appear. Only what's new arrives: a save that rewrote a whole board
  // brings in just the pieces it added. One per source: what's arriving in one document never
  // arrives in another.
  const arrivals = useMemo(() => new Arrivals(), [source]);
  // A board with pieces arriving is live for them (see `attention`): once they've landed, it
  // may go back to its picture.
  const [, settled] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = source.onOp?.((op, origin, next) => {
      // Listeners hear an op before the state takes it: the doc there is the one before.
      if (origin.kind !== "agent" && origin.kind !== "disk") return;
      arrivals.add(op, next, undefined, source.getState().doc);
      clearTimeout(timer);
      timer = setTimeout(() => settled((n) => n + 1), arrivals.until());
    });
    return () => {
      off?.();
      clearTimeout(timer);
    };
  }, [source, arrivals]);
  // A board stays ringed a moment after its agent leaves, so the ring can fade.
  const ringed = useLingering(working, RING_OUT_MS);

  const boards = page?.artboards ?? [];
  // On a cold open, boards cheap enough to show live while their picture is made, and
  // boards that show as a skeleton meanwhile (see coldopen.ts).
  const cold = useMemo(() => coldLive(boards), [boards]);
  const skeletons = useMemo(() => coldSkeleton(boards), [boards]);
  const boardHeight = (ab: Artboard) => size(ab).h ?? measured[ab.id] ?? 900;

  // Resolved threads leave the board, but not from under the person reading one.
  const pageThreads = useMemo(
    () =>
      doc && page
        ? doc.threads.filter(
            (t) =>
              (t.status === "open" || t.id === openThread) && threadPage(doc, t)?.id === page.id,
          )
        : [],
    [doc, page, openThread],
  );

  // New comments left unsent keep their "+" pin, to open again.
  const drafts = useDrafts();
  const unsentPins = useMemo(
    () =>
      readOnly || !page
        ? []
        : drafts.flatMap((d) =>
            d.file === state.path &&
            d.pin &&
            unsent(d) &&
            (d.pin.artboardId
              ? boards.some((b) => b.id === d.pin!.artboardId)
              : d.pin.pageId === page.id)
              ? [d.pin]
              : [],
          ),
    [drafts, state.path, readOnly, page, boards],
  );
  // While a thread has unsent words in it, agents can't resolve it.
  const writing = useMemo(
    () =>
      readOnly
        ? []
        : [
            ...new Set(
              drafts.flatMap((d) =>
                d.file === state.path && d.thread && unsent(d) ? [d.thread] : [],
              ),
            ),
          ],
    [drafts, state.path, readOnly],
  );
  const writingKey = writing.join(" ");
  useEffect(() => {
    source.setWriting?.(writingKey ? writingKey.split(" ") : []);
  }, [source, writingKey]);

  const bounds = useMemo(() => {
    if (!boards.length) return null;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const ab of boards) {
      const { w } = size(ab);
      x0 = Math.min(x0, ab.x);
      y0 = Math.min(y0, ab.y);
      x1 = Math.max(x1, ab.x + w);
      y1 = Math.max(y1, ab.y + boardHeight(ab));
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards, measured]);

  /** Every board's box, in page px: for labels to keep off one another, and the selection box. */
  const boardBoxes = useMemo(
    () => boards.map((ab) => ({ id: ab.id, x: ab.x, y: ab.y, w: size(ab).w, h: boardHeight(ab) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boards, measured],
  );

  const viewportSize = () => {
    const r = viewport.current?.getBoundingClientRect();
    return { w: r?.width ?? 1200, h: r?.height ?? 800 };
  };

  const fitPage = useCallback(() => {
    if (bounds) fit(bounds, viewportSize(), 72, 1);
  }, [bounds, fit]);

  /** The top-left board across the width, its label just in view: where a narrow screen starts. */
  const fitFirst = useCallback(() => {
    const first = [...boards].sort((a, b) => a.y - b.y || a.x - b.x)[0];
    if (!first) return;
    const v = viewportSize();
    const zoom = Math.min(1, (v.w - FIRST_SIDE * 2) / size(first).w);
    if (!(zoom > 0)) return;
    camera.set(
      {
        zoom,
        x: (v.w - size(first).w * zoom) / 2 - first.x * zoom,
        y: FIRST_TOP - first.y * zoom,
      },
      true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards, camera]);

  // Fit when a page first shows, before it paints: after, its first frame is at the old page's
  // camera. A change of framing (a window crossing a host's breakpoint) frames it again.
  useLayoutEffect(() => {
    if (!page || !bounds) return;
    const key = `${page.id}:${initialFit}`;
    if (fitted.current === key) return;
    fitted.current = key;
    if (initialFit === "first") fitFirst();
    else fitPage();
  }, [page, bounds, fitPage, fitFirst, initialFit]);

  /** Show a board's page with the board framed, in place of the page's own fit. */
  const showBoard = (pageId: string, ab: Artboard | undefined) => {
    if (pageId !== page?.id) {
      fitted.current = `${pageId}:${initialFit}`;
      setPageId(pageId);
    }
    if (ab) fit({ x: ab.x, y: ab.y, w: size(ab).w, h: boardHeight(ab) }, viewportSize(), 96, 1);
  };

  // Open on the board a link named, once the document is in. After the page's own fit, so the
  // first frame painted is the board's. A fit-content board is framed again once it's measured,
  // still before paint; after that the camera is the person's.
  const shownLink = useRef<{ id: string; sized: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!linked || !doc) return;
    const hit = findArtboard(doc, linked);
    const sized = !!hit && (size(hit.artboard).h !== null || measured[linked] !== undefined);
    const shown = shownLink.current;
    if (shown?.id === linked && (shown.sized || !sized)) return;
    shownLink.current = { id: linked, sized };
    if (hit) showBoard(hit.page.id, hit.artboard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, doc, measured]);

  // Follow focus requests (agent created an artboard).
  useEffect(() => {
    const f = state.focus;
    if (!f || !doc) return;
    showBoard(f.page, findArtboard(doc, f.artboard)?.artboard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.focus?.at]);

  // Measure artboards with fit-content height when the boards change, and
  // whenever one resizes on its own (a font or image arriving). Not on every
  // render: reading offsetHeight forces a layout that playing videos have
  // dirtied, every frame.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const roots = new Map<string, ShadowRoot>();
    for (const ab of boards) {
      if (size(ab).h !== null) continue;
      const host = el.querySelector(`[data-artboard-host="${ab.id}"]`) as HTMLElement | null;
      if (host?.shadowRoot) roots.set(ab.id, host.shadowRoot);
    }
    if (!roots.size) return;
    // A board's content is replaced whole (an edit, a theme): its section is found
    // again each time, and watched once it's new.
    const watched = new Map<string, Element>();
    const ro = new ResizeObserver(() => measure());
    const measure = () => {
      const next: Record<string, number> = {};
      for (const [id, root] of roots) {
        const inner = root.querySelector("[data-artboard]") as HTMLElement | null;
        if (!inner) continue;
        if (watched.get(id) !== inner) {
          const old = watched.get(id);
          if (old) ro.unobserve(old);
          ro.observe(inner);
          watched.set(id, inner);
        }
        next[id] = inner.offsetHeight;
      }
      setMeasured((m) => (Object.keys(next).some((k) => next[k] !== m[k]) ? { ...m, ...next } : m));
    };
    measure();
    // A board drawn as a picture skips layout (content-visibility: hidden), so
    // no resize is observed when its images or fonts arrive: it would keep the
    // height it had at mount, its picture squashed into it, and jump when it
    // goes live. Measure again when they arrive, or its content is replaced;
    // layout still answers.
    let frame = 0;
    const again = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    const replaced = new MutationObserver(again);
    for (const r of roots.values()) {
      r.addEventListener("load", again, true);
      r.addEventListener("error", again, true);
      replaced.observe(r, { childList: true });
    }
    document.fonts?.addEventListener("loadingdone", again);
    return () => {
      ro.disconnect();
      replaced.disconnect();
      cancelAnimationFrame(frame);
      for (const r of roots.values()) {
        r.removeEventListener("load", again, true);
        r.removeEventListener("error", again, true);
      }
      document.fonts?.removeEventListener("loadingdone", again);
    };
    // Content is replaced per artboard object and tokens; new boards mean new hosts.
  }, [boards, doc?.tokens]);

  // Wheel: pan; pinch or modifier: zoom. The viewport only mounts once the doc
  // arrives, so attach again then.
  const mounted = !!(doc && page);
  useEffect(() => {
    if (!mounted) return;
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
        return;
      }
      // An open thread scrolls its own messages; the canvas stays put under it.
      const path = e.composedPath();
      const card = path.findIndex(
        (n) => n instanceof Element && n.hasAttribute("data-comment-open"),
      );
      // The canvas is a scroller too, so a wheel that nothing in the card can
      // take would chain to it and pan: stop it.
      if (card >= 0 && path.slice(0, card).some((n) => n instanceof HTMLElement && canScroll(n, e)))
        return;
      e.preventDefault();
      if (card < 0) panBy(-e.deltaX, -e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mounted, zoomAt, panBy]);

  // An open thread or composer closes on any click outside it, footer included.
  useEffect(() => {
    if (!openThread && !pending) return;
    const onDown = (e: PointerEvent) => {
      const inside = e
        .composedPath()
        .some((n) => n instanceof Element && n.hasAttribute("data-comment-open"));
      if (inside) return;
      setOpenThread(null);
      setPending(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [openThread, pending]);

  // Holding ⌥ turns the page tabs' icons into the numbers that jump to them.
  const pageHint = useModifierHint("Alt");

  // Whatever changes the page (a tab, New page, an agent's focus), Delete
  // would otherwise reach boards on a page you can't see.
  const pageKey = page?.id;
  useEffect(() => {
    if (pageKey) setSelection([]);
  }, [pageKey]);

  const goToPage = (id: string) => {
    setPageId(id);
    setPending(null);
    setOpenThread(null);
  };

  // Keyboard.
  useEffect(() => {
    // A tool focused from the keyboard would keep its ring after a shortcut picks another.
    const switchMode = (next: Mode) => {
      setMode(next);
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('[data-slot="canvas-bar"]'))
        active.blur();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      // ⌥1–9: pages, by e.code since ⌥ changes e.key on a Mac. 9 is the last.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (e.altKey && !mod && !e.shiftKey && digit && doc) {
        e.preventDefault();
        const p = digit === "9" ? doc.pages.at(-1) : doc.pages[Number(digit) - 1];
        if (p) goToPage(p.id);
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (!readOnly) e.shiftKey ? source.redo() : source.undo();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        const v = viewportSize();
        zoomAt(1.25, v.w / 2, v.h / 2);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        const v = viewportSize();
        zoomAt(0.8, v.w / 2, v.h / 2);
      } else if (e.shiftKey && !mod && !e.altKey && digit === "1") {
        // ⇧1 and ⇧2 by e.code too: ⇧ turns e.key into "!" and "@".
        fitPage();
      } else if (e.shiftKey && !mod && !e.altKey && digit === "2" && selection[0] && doc) {
        const hit = locate(doc, selection[0]);
        if (hit) {
          const { w } = size(hit.artboard);
          fit(
            { x: hit.artboard.x, y: hit.artboard.y, w, h: boardHeight(hit.artboard) },
            viewportSize(),
            96,
            2,
          );
        }
      } else if (!mod && e.key === "v") switchMode("select");
      else if (!mod && e.key === "h") switchMode("hand");
      else if (!mod && e.key === "c" && !readOnly) switchMode("comment");
      else if (e.key === "Escape") {
        setPending(null);
        setOpenThread(null);
        setSelection([]);
        // A selection box being drawn is dropped too, or the next move would select again.
        if (drag.current?.kind === "marquee") drag.current = null;
        setMarquee(null);
        switchMode("select");
      } else if (
        (e.key === "Backspace" || e.key === "Delete") &&
        !readOnly &&
        selection.length &&
        doc
      ) {
        // Only artboards are deleted from the canvas; node edits are for agents.
        const ids = selection.filter((id) => findArtboard(doc, id));
        if (ids.length)
          source.apply(
            ids.length === 1
              ? { op: "artboard.delete", id: ids[0]! }
              : { op: "batch", ops: ids.map((id) => ({ op: "artboard.delete" as const, id })) },
          );
        setSelection([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toWorld = (clientX: number, clientY: number) => {
    const r = viewport.current!.getBoundingClientRect();
    const cam = camera.get();
    return {
      x: (clientX - r.left - cam.x) / cam.zoom,
      y: (clientY - r.top - cam.y) / cam.zoom,
    };
  };

  /** Find the artboard and deepest node under a pointer, looking inside shadow roots. */
  const hitTest = (e: {
    clientX: number;
    clientY: number;
  }): { artboard: Artboard; nodeId?: string } | null => {
    const w = toWorld(e.clientX, e.clientY);
    const ab = [...boards]
      .reverse()
      .find(
        (a) => w.x >= a.x && w.x <= a.x + size(a).w && w.y >= a.y && w.y <= a.y + boardHeight(a),
      );
    if (!ab) return null;
    const host = viewport.current!.querySelector(
      `[data-artboard-host="${ab.id}"]`,
    ) as HTMLElement | null;
    const els = thawed(host?.parentElement, () =>
      host?.shadowRoot ? host.shadowRoot.elementsFromPoint(e.clientX, e.clientY) : [],
    );
    const el = els.find((x) => x.hasAttribute("data-id") && !x.hasAttribute("data-artboard"));
    return { artboard: ab, nodeId: el?.getAttribute("data-id") ?? undefined };
  };

  // Pointer: pan, select, drag artboards by their title, place comments.
  const drag = useRef<{
    kind: "pan" | "move" | "marquee";
    startX: number;
    startY: number;
    ids: string[];
    origin: { id: string; x: number; y: number }[];
    /** Where a selection box started, in page coordinates. */
    anchor?: { x: number; y: number };
    /** The pointer's last position on screen, for the box to follow when the page scrolls. */
    pointer?: { x: number; y: number };
    moved: boolean;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || panning) {
      drag.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        ids: [],
        origin: [],
        moved: false,
      };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (e.button !== 0 || !doc) return;
    const hit = hitTest(e);
    if (mode === "comment" && !readOnly) {
      if (!page) return;
      const w = toWorld(e.clientX, e.clientY);
      setOpenThread(null);
      setPending(
        hit
          ? {
              artboardId: hit.artboard.id,
              pageId: page.id,
              nodeId: hit.nodeId,
              x: w.x - hit.artboard.x,
              y: w.y - hit.artboard.y,
            }
          : { pageId: page.id, x: w.x, y: w.y },
      );
      return;
    }
    setPending(null);
    setOpenThread(null);
    if (!hit) {
      // A finger on the open canvas pans, as it always has; a mouse draws a selection box.
      const box = e.pointerType !== "touch";
      const keep = box && e.shiftKey ? selection : [];
      setSelection(keep);
      drag.current = {
        kind: box ? "marquee" : "pan",
        startX: e.clientX,
        startY: e.clientY,
        ids: keep,
        origin: [],
        anchor: toWorld(e.clientX, e.clientY),
        moved: false,
      };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    const id = e.altKey || !hit.nodeId ? hit.artboard.id : hit.nodeId;
    const ids = e.shiftKey
      ? selection.includes(id)
        ? selection.filter((x) => x !== id)
        : [...selection, id]
      : [id];
    setSelection(ids);
  };

  const startMove = (e: React.PointerEvent, ab: Artboard) => {
    if (e.button !== 0 || panning) return;
    e.stopPropagation();
    // Read-only, a title selects its board and stays put.
    if (readOnly) {
      setPending(null);
      setOpenThread(null);
      setSelection([ab.id]);
      return;
    }
    const ids = selection.includes(ab.id)
      ? selection.filter((id) => findArtboard(doc!, id))
      : [ab.id];
    if (!selection.includes(ab.id)) setSelection([ab.id]);
    drag.current = {
      kind: "move",
      startX: e.clientX,
      startY: e.clientY,
      ids,
      origin: ids.map((id) => {
        const a = findArtboard(doc!, id)!.artboard;
        return { id, x: a.x, y: a.y };
      }),
      moved: false,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const [ghost, setGhost] = useState<{ dx: number; dy: number } | null>(null);
  /** The selection box's corners in page coordinates, so it holds its place if the camera moves. */
  const [marquee, setMarquee] = useState<{
    a: { x: number; y: number };
    b: { x: number; y: number };
  } | null>(null);

  /** Draws the selection box from its anchor to the pointer and selects the boards it touches. */
  const boxTo = (d: NonNullable<typeof drag.current>) => {
    if (!d.anchor || !d.pointer) return;
    const b = toWorld(d.pointer.x, d.pointer.y);
    setMarquee({ a: d.anchor, b });
    // Board boxes from layout, not the DOM: a board drawn as a picture is selected the same.
    const inside = boardsIn(d.anchor, b, boardBoxes);
    setSelection([...d.ids, ...inside.filter((id) => !d.ids.includes(id))]);
  };

  // Scrolling mid-box moves the page under a pointer that stayed put; the box's corner follows it.
  const boxToRef = useRef(boxTo);
  boxToRef.current = boxTo;
  useEffect(
    () =>
      camera.subscribe(() => {
        const d = drag.current;
        if (d?.kind === "marquee" && d.moved) boxToRef.current(d);
      }),
    [camera],
  );

  // Titles are memoized; their handlers stay the same object and call the latest closures.
  const rename = (id: string | null) => {
    if (!readOnly || id === null) setRenaming(id);
  };
  const titleHandlers = useRef({ startMove, setRenaming: rename, apply: source.apply });
  titleHandlers.current = { startMove, setRenaming: rename, apply: (op) => source.apply(op) };
  const titleEvents = useMemo<TitleEvents>(
    () => ({
      down: (e, ab) => titleHandlers.current.startMove(e, ab),
      rename: (id) => titleHandlers.current.setRenaming(id),
      apply: (op) => titleHandlers.current.apply(op),
    }),
    [],
  );

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    if (d.kind === "pan") {
      panBy(e.movementX, e.movementY);
    } else if (d.kind === "marquee") {
      if (!d.moved) return;
      d.pointer = { x: e.clientX, y: e.clientY };
      boxTo(d);
    } else if (d.moved) {
      const { zoom } = camera.get();
      setGhost({ dx: dx / zoom, dy: dy / zoom });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "move" && d.moved && ghost && !readOnly) {
      const ops = d.origin.map((o) => ({
        op: "artboard.update" as const,
        id: o.id,
        x: Math.round(o.x + ghost.dx),
        y: Math.round(o.y + ghost.dy),
      }));
      source.apply(ops.length === 1 ? ops[0]! : { op: "batch", ops });
    }
    setGhost(null);
    setMarquee(null);
  };

  const createThread = (text: string) => {
    if (!pending || readOnly) return;
    const now = Date.now();
    const thread: Thread = {
      id: newId("th"),
      ...(pending.artboardId ? { artboardId: pending.artboardId } : { pageId: pending.pageId }),
      ...(pending.nodeId ? { nodeId: pending.nodeId } : {}),
      x: Math.round(pending.x),
      y: Math.round(pending.y),
      status: "open",
      createdAt: now,
      updatedAt: now,
      messages: [{ id: newId("m"), author: me, text, createdAt: now }],
    };
    source.apply({ op: "thread.create", thread });
    // Stay in comment mode: the next click starts another. Esc or V leaves it.
    setPending(null);
  };

  // Pins drag to a new spot; a press that doesn't move opens the thread.
  const [pinDrag, setPinDrag] = useState<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    /** Pointer position on the page, and what it's over. */
    x: number;
    y: number;
    target?: string;
  } | null>(null);

  const pinDown = (e: React.PointerEvent, t: Thread) => {
    // Space or the hand tool pans right through pins.
    if (panning || e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setPinDrag({
      id: t.id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      ...toWorld(e.clientX, e.clientY),
    });
  };

  const pinMove = (e: React.PointerEvent) => {
    // Read-only pins never leave their spot, so every press opens the thread.
    if (!pinDrag || readOnly) return;
    const moved =
      pinDrag.moved ||
      Math.abs(e.clientX - pinDrag.startX) + Math.abs(e.clientY - pinDrag.startY) > 3;
    if (!moved) return;
    const hit = hitTest(e);
    setPinDrag({
      ...pinDrag,
      moved,
      ...toWorld(e.clientX, e.clientY),
      target: hit ? (hit.nodeId ?? hit.artboard.id) : undefined,
    });
  };

  const pinUp = (e: React.PointerEvent, t: Thread) => {
    const d = pinDrag;
    setPinDrag(null);
    if (!d || d.id !== t.id || !page) return;
    if (!d.moved || readOnly) {
      setPending(null);
      setOpenThread(openThread === t.id ? null : t.id);
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    const hit = hitTest(e);
    source.apply(
      hit
        ? {
            op: "thread.update",
            id: t.id,
            artboardId: hit.artboard.id,
            pageId: null,
            nodeId: hit.nodeId ?? null,
            x: Math.round(w.x - hit.artboard.x),
            y: Math.round(w.y - hit.artboard.y),
          }
        : {
            op: "thread.update",
            id: t.id,
            artboardId: null,
            pageId: page.id,
            nodeId: null,
            x: Math.round(w.x),
            y: Math.round(w.y),
          },
    );
  };

  // Boxes of the nodes that pins and outlines sit on, in artboard px. Measured
  // when what they depend on changes and when the camera settles, never per
  // frame: measuring forces style and layout across every board.
  const [boxes, setBoxes] = useState<Record<string, NodeBox>>({});
  const measureBoxes = useRef(() => {});
  measureBoxes.current = () => {
    const vp = viewport.current;
    if (!vp) return;
    const next: Record<string, NodeBox> = {};
    const want = (id: string, ab?: Artboard) => {
      if (next[id] || boards.some((b) => b.id === id)) return;
      for (const b of ab ? [ab] : boards) {
        const box = nodeBox(vp, b, id);
        if (box) {
          next[id] = { ...box, artboardId: b.id };
          return;
        }
      }
    };
    for (const id of selection) want(id);
    if (pinDrag?.moved && pinDrag.target) want(pinDrag.target);
    for (const t of pageThreads) {
      const ab = boards.find((b) => b.id === t.artboardId);
      if (ab && t.nodeId) want(t.nodeId, ab);
    }
    setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
  };
  const pinTarget = pinDrag?.moved ? pinDrag.target : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- what the boxes depend on
  useLayoutEffect(() => measureBoxes.current(), [doc, page, selection, measured, pinTarget]);

  // The camera moves the layers directly, once a frame, without rendering.
  useCameraLayers(camera, scroller, layer, overlay, mounted, () => measureBoxes.current());

  // What the boards' tiers and detail go by changes in steps (a quarter octave of zoom, a
  // board coming on or off screen, a tall board's band, a gesture starting or stopping):
  // the canvas renders only then, and each board only when its own inputs change.
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  // Boards go live nearest the middle of the view first. Asked only when one
  // queues to, so it reads the camera then; stable, so boards don't re-render.
  const rankRef = useRef<(id: string) => number>(() => 0);
  rankRef.current = (id: string) => {
    const ab = boards.find((b) => b.id === id);
    if (!ab) return 0;
    return centreDistance(
      { x: ab.x, y: ab.y, w: size(ab).w, h: boardHeight(ab) },
      camera.get(),
      viewportSize(),
    );
  };
  const rankOf = useCallback((id: string) => rankRef.current(id), []);
  const view = useCameraView(camera, (c) => {
    const vp = viewportSize();
    let k = String(detailScale(c.zoom, dpr));
    for (const ab of boards) {
      const r = { x: ab.x, y: ab.y, w: size(ab).w, h: boardHeight(ab) };
      const band = visibleBand(r, c, vp);
      k += onScreen(r, c, vp) ? `+${band ? `${band.y0}:${band.y1}` : ""}` : "-";
    }
    return k;
  });
  // A pan or zoom over a crowded view: every board's loops hold until the camera stops, as do
  // videos over pictures. A loop under a blur redraws it every frame of the gesture.
  const crowd = view.moving && crowded(boardBoxes, view, viewportSize());
  // Videos over pictures also hold while nobody can be watching the window, as boards' loops do.
  useEffect(() => playing.hold(crowd || still), [crowd, still]);

  if (!doc || !page) {
    const offline = state.status === "offline";
    const name = state.path
      .split("/")
      .pop()
      ?.replace(/\.design$/, "");
    return (
      <div className={cn("pz-root", `pz-${theme}`, still && "pz-still", className)}>
        {opening && (
          <div className="pz-appear pz:pointer-events-none pz:absolute pz:inset-0 pz:flex pz:flex-col pz:items-center pz:justify-center pz:gap-3 pz:text-muted-foreground">
            <Juice size={44} dark={theme === "dark"} dry={offline} />
            <span>
              {state.error
                ? state.error
                : offline
                  ? "Reconnecting to Ponzu"
                  : name
                    ? `Opening ${name}`
                    : "Opening"}
            </span>
          </div>
        )}
      </div>
    );
  }

  const ghostFor = (id: string) => (ghost && drag.current?.ids.includes(id) ? ghost : null);
  const rectsFor = (ids: string[]) => selectionRects(ids, boards, boardHeight, ghostFor, boxes);
  const selectedRects = rectsFor(selection);
  const vpSize = viewportSize();
  const scale = detailScale(view.zoom, dpr);
  const arriving = arrivals.boardsArriving(boards);

  return (
    <div className={cn("pz-root", `pz-${theme}`, still && "pz-still", className)}>
      <Pacer />
      <div
        ref={viewport}
        className={cn(
          "pz:relative pz:min-h-0 pz:flex-1 pz:touch-none pz:overflow-hidden",
          panning
            ? "pz:cursor-grab pz:active:cursor-grabbing"
            : mode === "comment"
              ? "pz:cursor-crosshair"
              : "pz:cursor-default",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDragOver={(e) => e.preventDefault()}
      >
        {/*
         * The scroll plane: the camera pans by scrolling it and zooms by
         * scaling the layer, both written by useCameraLayers.
         */}
        <div
          ref={scroller}
          className="pz:absolute pz:inset-0 pz:touch-none pz:overflow-scroll pz:overscroll-none pz:outline-none pz:[overflow-anchor:none] pz:[scrollbar-width:none]"
          // Not a tab stop: Chromium makes scrollers focusable, and Space would scroll it.
          // Still focusable by a click, so no ring: Chromium's would frame the whole canvas.
          tabIndex={-1}
          // A middle press pans the canvas, not the browser's autoscroll.
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        >
          <div aria-hidden style={{ width: PLANE, height: PLANE }} />
          <div ref={layer} className="pz:absolute pz:top-0 pz:left-0 pz:origin-top-left">
            {boards.map((ab) => {
              const g = ghostFor(ab.id);
              const r = { x: ab.x, y: ab.y, w: size(ab).w, h: boardHeight(ab) };
              const band = visibleBand(r, view, vpSize);
              return (
                <Board
                  key={ab.id}
                  artboard={ab}
                  dx={g?.dx ?? 0}
                  dy={g?.dy ?? 0}
                  h={r.h}
                  tokens={doc.tokens}
                  source={source}
                  colorScheme={themed(doc.tokens, ab) ? theme : "light"}
                  zoom={view.zoom * dpr}
                  scale={scale}
                  onScreen={onScreen(r, view, vpSize)}
                  moving={view.moving}
                  y0={band?.y0}
                  y1={band?.y1}
                  // Dragged, selected, renamed, worked on or an agent's work arriving: live,
                  // wherever it is.
                  attention={
                    !!g ||
                    selection.includes(ab.id) ||
                    working.has(ab.id) ||
                    renaming === ab.id ||
                    arriving.has(ab.id)
                  }
                  cheap={cold.has(ab.id)}
                  skeleton={skeletons.has(ab.id)}
                  rankOf={rankOf}
                  arrivals={arrivals}
                  // Slightly rounded, the same few px on screen at any zoom (to a quarter octave).
                  radius={(BOARD_RADIUS * dpr) / scale}
                  hold={
                    crowd ||
                    outOfSight({ ...r, x: r.x + (g?.dx ?? 0), y: r.y + (g?.dy ?? 0) }, view, vpSize)
                  }
                />
              );
            })}
          </div>

          {/*
           * Overlays in screen space so they stay crisp at any zoom. The layer
           * scrolls with the plane but never scales; each overlay sits at page
           * coordinates times --z, so a pan restyles nothing.
           */}
          <div
            ref={overlay}
            className="pz:pointer-events-none pz:absolute pz:top-0 pz:left-0 pz:origin-top-left"
          >
            {boards.map((ab) => {
              const g = ghostFor(ab.id);
              return (
                <BoardTitle
                  key={ab.id}
                  artboard={ab}
                  dx={g?.dx ?? 0}
                  dy={g?.dy ?? 0}
                  who={working.get(ab.id)}
                  selected={selection.includes(ab.id)}
                  renaming={renaming === ab.id}
                  covered={labelCovers(
                    { id: ab.id, x: ab.x + (g?.dx ?? 0), y: ab.y + (g?.dy ?? 0), w: size(ab).w },
                    boardBoxes,
                    view.zoom,
                  )}
                  events={titleEvents}
                  arrivedAt={arrivals.boardAt(ab.id)}
                />
              );
            })}
            {boards.map((ab) => {
              const drawn = arrivals.boardAt(ab.id);
              const ring = ringed.get(ab.id);
              if (drawn === undefined && ring === undefined) return null;
              const g = ghostFor(ab.id);
              const box = {
                x: ab.x + (g?.dx ?? 0),
                y: ab.y + (g?.dy ?? 0),
                w: size(ab).w,
                h: boardHeight(ab),
              };
              return (
                <Fragment key={ab.id}>
                  {ring !== undefined && <Ring {...box} leaving={ring} delay={ringDelay(drawn)} />}
                  {drawn !== undefined && <Frame {...box} at={drawn} />}
                </Fragment>
              );
            })}
            {pinDrag?.moved &&
              pinDrag.target &&
              rectsFor([pinDrag.target]).map((r) => (
                <div
                  key={r.id}
                  className="pz:pointer-events-none pz:absolute pz:outline-[1.5px] pz:outline-select"
                  style={worldRect(r)}
                />
              ))}
            {selectedRects.map((r) => (
              <div
                key={r.id}
                className={cn(
                  "pz:pointer-events-none pz:absolute pz:outline-select",
                  r.artboard ? "pz:outline-2" : "pz:outline-[1.5px]",
                )}
                style={worldRect(r)}
              />
            ))}
            {marquee && (
              <div
                className="pz:pointer-events-none pz:absolute pz:bg-select/8 pz:outline-1 pz:outline-select"
                style={worldRect({
                  x: Math.min(marquee.a.x, marquee.b.x),
                  y: Math.min(marquee.a.y, marquee.b.y),
                  w: Math.abs(marquee.b.x - marquee.a.x),
                  h: Math.abs(marquee.b.y - marquee.a.y),
                })}
              />
            )}
            {pageThreads.map((t) => {
              const ab = boards.find((b) => b.id === t.artboardId);
              const dragging = pinDrag?.id === t.id && pinDrag.moved ? pinDrag : null;
              const open = openThread === t.id;
              const p = dragging ?? pinPoint(t, ab, boxes);
              return (
                <div
                  key={t.id}
                  className={cn(pinWrap, open ? "pz:z-[3]" : "pz:z-[2]")}
                  style={{ left: wpx(p.x), top: wpx(p.y) }}
                  data-comment-open={open || undefined}
                >
                  <button
                    type="button"
                    title={
                      readOnly
                        ? "Open thread"
                        : writing.includes(t.id)
                          ? "Unsent reply · Drag to move"
                          : "Drag to move"
                    }
                    className={cn(
                      pin,
                      "pz:bg-comment pz:text-comment-foreground",
                      // A reply left unsent, dashed as an unsent comment's pin is.
                      writing.includes(t.id) &&
                        "pz:outline-[1.5px] pz:outline-dashed pz:outline-offset-2 pz:outline-comment",
                      panning ? "pz:cursor-grab" : "pz:cursor-pointer",
                      (open || dragging) && "pz:scale-112",
                      dragging &&
                        "pz:cursor-grabbing pz:shadow-[0_0_0_1px_rgba(17,17,16,0.18),0_4px_12px_rgba(0,0,0,0.25)]",
                    )}
                    onPointerDown={(e) => pinDown(e, t)}
                    onPointerMove={pinMove}
                    onPointerUp={(e) => pinUp(e, t)}
                    onPointerCancel={() => setPinDrag(null)}
                    // A press opens the thread in pinUp; this is for the keyboard.
                    onClick={(e) => e.detail === 0 && setOpenThread(open ? null : t.id)}
                  >
                    {t.messages.length}
                  </button>
                  {open && (
                    <ThreadCard
                      thread={t}
                      source={source}
                      me={me}
                      file={state.path}
                      readOnly={readOnly}
                      onClose={() => setOpenThread(null)}
                    />
                  )}
                </div>
              );
            })}
            {unsentPins.map((p) => {
              const key = draftKey.comment(state.path, p);
              if (pending && key === draftKey.comment(state.path, pending)) return null;
              const ab = boards.find((b) => b.id === p.artboardId);
              return (
                <div
                  key={key}
                  className={cn(pinWrap, "pz:z-[2]")}
                  style={{ left: wpx((ab?.x ?? 0) + p.x), top: wpx((ab?.y ?? 0) + p.y) }}
                >
                  <button
                    type="button"
                    title="Unsent comment"
                    className={cn(
                      pin,
                      "pz:cursor-pointer pz:bg-card pz:text-foreground pz:outline-[1.5px] pz:outline-dashed pz:outline-comment",
                    )}
                    onPointerDown={(e) => {
                      if (panning || e.button !== 0) return;
                      e.stopPropagation();
                      setOpenThread(null);
                      setPending(p);
                    }}
                    onClick={(e) => {
                      if (e.detail !== 0) return;
                      setOpenThread(null);
                      setPending(p);
                    }}
                  >
                    +
                  </button>
                </div>
              );
            })}
            {pending &&
              (() => {
                const ab = boards.find((b) => b.id === pending.artboardId);
                return (
                  <div
                    className={cn(pinWrap, "pz:z-[3]")}
                    style={{
                      left: wpx((ab?.x ?? 0) + pending.x),
                      top: wpx((ab?.y ?? 0) + pending.y),
                    }}
                    data-comment-open
                  >
                    <span
                      className={cn(pin, "pz:scale-112 pz:bg-comment pz:text-comment-foreground")}
                    >
                      +
                    </span>
                    <div className={threadCard}>
                      <Composer
                        key={draftKey.comment(state.path, pending)}
                        onSubmit={createThread}
                        onCancel={() => setPending(null)}
                        draft={{
                          key: draftKey.comment(state.path, pending),
                          file: state.path,
                          pin: pending,
                        }}
                      />
                    </div>
                  </div>
                );
              })()}
          </div>
        </div>
      </div>

      {footer && (
        <TipProvider>
          {/*
           * The bars float over the canvas, which runs to the container's edges beneath them.
           * They share one row that lets clicks through between them: Pages takes what Controls
           * leaves and scrolls its tabs, so the two never overlap. Pointer and wheel events stop
           * at a bar, so pressing one never pans or zooms.
           */}
          <div className="pz:pointer-events-none pz:absolute pz:inset-x-2.5 pz:bottom-2.5 pz:z-[3] pz:flex pz:items-end pz:justify-between pz:gap-2.5">
            <Bar name="Pages" className="pz:min-w-0 pz:shrink">
              <div className="pz:flex pz:min-w-0 pz:items-center pz:gap-0.5 pz:overflow-x-auto pz:[scrollbar-width:none]">
                {doc.pages.map((p, i) => (
                  <PageTab
                    key={p.id}
                    name={p.name}
                    shortcut={i < 8 ? i + 1 : i === doc.pages.length - 1 ? 9 : undefined}
                    showShortcut={pageHint}
                    icon={p.icon}
                    active={p.id === page.id}
                    working={busyPages.has(p.id)}
                    onClick={() => goToPage(p.id)}
                    onRename={
                      readOnly
                        ? undefined
                        : (name) => source.apply({ op: "page.update", id: p.id, name })
                    }
                  />
                ))}
              </div>
              {!readOnly && (
                <Tip label="New page">
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    aria-label="New page"
                    onClick={() => {
                      const id = newId("pg");
                      source.apply({
                        op: "page.create",
                        index: doc.pages.length,
                        page: { id, name: `Page ${doc.pages.length + 1}` },
                      });
                      setPageId(id);
                    }}
                  >
                    <Icon name="add" size={15} />
                  </Button>
                </Tip>
              )}
            </Bar>
            <Bar name="Controls" className="pz:shrink-0">
              {footerExtra}
              <ToggleGroup
                variant="raised"
                value={panning ? "hand" : mode}
                onValueChange={setMode}
                items={MODES.filter((m) => !readOnly || m.value !== "comment").map((m) => ({
                  value: m.value,
                  title: m.label,
                  keys: [m.key],
                  label: <Icon name={m.value} size={16} />,
                }))}
              />
              <span aria-hidden className="pz:mx-1.5 pz:h-4 pz:w-px pz:bg-foreground/10" />
              <Tip label="Zoom out" keys={["⌘", "−"]}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Zoom out"
                  onClick={() => zoomAt(0.8, viewportSize().w / 2, viewportSize().h / 2)}
                >
                  <Icon name="minus" size={14} />
                </Button>
              </Tip>
              <Tip label="Zoom to fit" keys={["⇧", "1"]}>
                <Button
                  variant="ghost"
                  className="pz:h-7 pz:min-w-9 pz:rounded-lg pz:px-0.5 pz:text-foreground pz:tabular-nums"
                  aria-label="Zoom to fit"
                  onClick={fitPage}
                >
                  <ZoomPercent camera={camera} />
                </Button>
              </Tip>
              <Tip label="Zoom in" keys={["⌘", "+"]}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Zoom in"
                  onClick={() => zoomAt(1.25, viewportSize().w / 2, viewportSize().h / 2)}
                >
                  <Icon name="plus" size={14} />
                </Button>
              </Tip>
            </Bar>
          </div>
        </TipProvider>
      )}
    </div>
  );
}

const MODES = [
  { value: "select", label: "Select", key: "V" },
  { value: "hand", label: "Hand", key: "H" },
  { value: "comment", label: "Comment", key: "C" },
] as const;

/** A frosted bar in the canvas's bottom row. */
function Bar({
  name,
  className,
  children,
}: {
  name: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="toolbar"
      aria-label={name}
      data-slot="canvas-bar"
      className={cn(
        "pz:pointer-events-auto pz:flex pz:items-center pz:gap-0.5 pz:rounded-xl pz:bg-bar pz:p-1 pz:shadow-bar pz:backdrop-blur-[18px] pz:backdrop-saturate-[1.6]",
        className,
      )}
      onPointerDown={(e) => e.stopPropagation()}
      // A clicked control doesn't keep focus, as in a native toolbar: a focused one
      // showed a stale ring once a shortcut changed the mode, and Space clicked it.
      onMouseDown={(e) => {
        if (!(e.target instanceof Element && e.target.closest("input, textarea"))) {
          e.preventDefault();
        }
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

interface Worker {
  /** Presence id: two sessions of one agent share a name. */
  id: string;
  name: string;
  client?: string;
  status?: string;
}

/**
 * The right side of a working artboard's header: yuzu rain, columns of dots falling at their own
 * pace, Paper's way of saying "at work here" without anyone's face on the board. The columns come
 * in left to right. Sized in em, so it's the label's size at any zoom. Who's working and what they
 * say they're doing is in the tooltip; written out, one pass repeated the same status over every
 * board it touched.
 */
function WorkingStatus({ who }: { who: Worker[]; zoom?: number }) {
  return (
    <Rain
      className="pz:ml-auto"
      label="Working"
      title={who.map((a) => `${a.name}: ${a.status ?? "working"}`).join("\n")}
    />
  );
}

/**
 * A yuzu ring round a working artboard, a few px off its edge so it never touches the design,
 * breathing slowly in width and glow so it reads on a light canvas as well as a dark one. It
 * fades in after `delay` ms (a new board's frame is still drawing) and fades out when `leaving`.
 * Drawn in the screen-space overlay so it's the same on screen at any zoom, and never part of the
 * design: screenshots and exports don't see it.
 */
function Ring({
  x,
  y,
  w,
  h,
  leaving = false,
  delay = 0,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  leaving?: boolean;
  delay?: number;
}) {
  // Fixed when it mounts: a running animation whose delay changed would jump.
  const [wait] = useState(delay);
  return (
    <div
      className="pz:pointer-events-none pz:absolute pz:transition-opacity pz:duration-500"
      style={{ ...ringBox({ x, y, w, h }), opacity: leaving ? 0 : 1 }}
      aria-hidden
    >
      <div
        className="pz-ring pz:absolute pz:inset-0"
        style={{ borderRadius: BOARD_RADIUS + RING_GAP, animationDelay: `${wait}ms` }}
      />
    </div>
  );
}

/**
 * A new artboard's frame drawing itself round its final bounds where the ring will be, from when
 * the board landed, then fading as the ring takes over.
 */
function Frame({ x, y, w, h, at }: { x: number; y: number; w: number; h: number; at: number }) {
  const rect = useRef<SVGRectElement>(null);
  useLayoutEffect(() => {
    if (rect.current) drawFrame(rect.current, at);
  }, [at]);
  return (
    <svg
      className="pz:pointer-events-none pz:absolute pz:overflow-visible pz:text-[var(--pz-rind)]"
      style={ringBox({ x, y, w, h })}
      aria-hidden
    >
      <rect
        ref={rect}
        x={1}
        y={1}
        style={{ width: "calc(100% - 2px)", height: "calc(100% - 2px)" }}
        rx={BOARD_RADIUS + RING_GAP}
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeDasharray="100 100"
        strokeDashoffset={100}
      />
    </svg>
  );
}

/** Open pins sit a level above the rest, so another pin never covers their card. */
const pinWrap = "pz:pointer-events-auto pz:absolute pz:size-0";
/**
 * A circle centred on the comment's spot, holding its message count. The hairline keeps a yuzu pin
 * visible on a yellow design.
 */
const pin =
  "pz:absolute pz:top-0 pz:left-0 pz:grid pz:size-6 pz:-translate-1/2 pz:place-items-center pz:rounded-full pz:font-semibold pz:text-[11px] pz:tabular-nums pz:shadow-[0_0_0_1px_rgba(17,17,16,0.18),0_1px_3px_rgba(0,0,0,0.25)] pz:transition-transform pz:duration-[120ms] pz:hover:scale-112";

function PageTab({
  name,
  shortcut,
  showShortcut,
  icon,
  active,
  working,
  onClick,
  onRename,
}: {
  name: string;
  shortcut?: number;
  /** ⌥ is held: the shortcut eases in over the icon. */
  showShortcut: boolean;
  icon?: string;
  active: boolean;
  /** An agent is working on an artboard on this page. */
  working: boolean;
  onClick: () => void;
  /** Absent on a read-only canvas, where a double click doesn't rename. */
  onRename?: (n: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <button
      type="button"
      className={cn(
        "pz:inline-flex pz:h-7 pz:shrink-0 pz:items-center pz:gap-1.5 pz:whitespace-nowrap pz:rounded-lg pz:px-2.5",
        active
          ? "pz:bg-raised pz:text-foreground pz:shadow-raised"
          : "pz:text-muted-foreground pz:hover:bg-accent pz:hover:text-foreground",
      )}
      onClick={onClick}
      onDoubleClick={() => onRename && setEditing(true)}
    >
      <ShortcutHint modifier="⌥" n={shortcut} shown={showShortcut} index={shortcut}>
        <Icon name={icon && icon in Icons ? icon : "board"} size={14} />
      </ShortcutHint>
      {editing ? (
        <input
          autoFocus
          className="pz:w-[9em] pz:bg-transparent pz:outline-0"
          defaultValue={name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== name) onRename?.(v);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <span className={cn(working && "pz-shimmer")}>{name}</span>
      )}
    </button>
  );
}

/**
 * One artboard on the plane, in its tier (see snapshot.tsx). Renders only when
 * its own inputs change: the camera reaches it in steps (useCameraView).
 */
const Board = memo(function Board({
  artboard: ab,
  dx,
  dy,
  h,
  tokens,
  source,
  colorScheme,
  zoom,
  scale,
  onScreen,
  moving,
  y0,
  y1,
  attention,
  cheap,
  skeleton,
  rankOf,
  arrivals,
  radius,
  hold,
}: {
  artboard: Artboard;
  dx: number;
  dy: number;
  /** Its height, measured when it's fit-content. */
  h: number;
  tokens: string;
  source: CanvasSource;
  colorScheme: "light" | "dark";
  /** Device px per artboard px. */
  zoom: number;
  /** The same in quarter octaves, for detail inside the board. */
  scale: number;
  onScreen: boolean;
  moving: boolean;
  /** The part of a tall board in view (see visibleBand). */
  y0?: number;
  y1?: number;
  attention: boolean;
  /** On a cold open: live while its picture is made, or a skeleton of it. */
  cheap: boolean;
  skeleton: boolean;
  /** Its distance from the middle of the view, for which board goes live first. */
  rankOf: (id: string) => number;
  /** An agent's new pieces, which arrive as they render. */
  arrivals: Arrivals;
  /** Its corners' radius, in its own px. */
  radius: number;
  /** Nobody can see it move, or the camera moves over a crowded view: its loops hold. */
  hold: boolean;
}) {
  const { w, h: fixed } = size(ab);
  const rank = useCallback(() => rankOf(ab.id), [rankOf, ab.id]);
  // Its picture and loops, named by its content and theme.
  const version = versionOf(ab, tokens, () => serializeArtboardElement(ab));
  const snapshotUrl = useMemo(
    () =>
      source.snapshotUrl &&
      ((id: string, s: number) => source.snapshotUrl!(id, s, version, colorScheme)),
    [source, version, colorScheme],
  );
  const loopsUrl = useMemo(
    () => source.loopsUrl && ((id: string) => source.loopsUrl!(id, version, colorScheme)),
    [source, version, colorScheme],
  );
  const visible = y0 === undefined || y1 === undefined ? undefined : { y0, y1 };
  return (
    <div
      ref={(el) => {
        const at = el ? arrivals.takeBoard(ab.id) : undefined;
        if (el && at !== undefined) arriveBoard(el, at);
      }}
      className="pz:absolute pz:shadow-board"
      style={
        {
          left: ab.x + dx,
          top: ab.y + dy,
          width: w,
          height: fixed ?? undefined,
          borderRadius: radius,
          "--pz-board-radius": `${radius}px`,
        } as CSSProperties
      }
    >
      <TieredBoard
        id={ab.id}
        w={w}
        h={h}
        scale={zoom}
        onScreen={onScreen}
        moving={moving}
        attention={attention}
        snapshotUrl={snapshotUrl}
        loopsUrl={loopsUrl}
        cheap={cheap}
        rank={rank}
        cost={boardCost(ab).elements}
        skeleton={skeleton}
        fill={placeholderFill(ab)}
      >
        {(hidden) => (
          <ArtboardView
            artboard={ab}
            tokens={tokens}
            assetBase={source.assetBase}
            renditions={source.renditions}
            colorScheme={colorScheme}
            detail={{ hidden, scale, moving, visible }}
            arrivals={arrivals}
            rounded
            hold={hold}
          />
        )}
      </TieredBoard>
    </div>
  );
});

interface TitleEvents {
  down: (e: React.PointerEvent, ab: Artboard) => void;
  /** Start renaming an artboard, or stop with null. */
  rename: (id: string | null) => void;
  apply: CanvasSource["apply"];
}

/**
 * An artboard's name above its top-left corner, at 12 screen px whatever the
 * zoom: it sits in the overlay layer, placed in page px times --z.
 */
const BoardTitle = memo(function BoardTitle({
  artboard: ab,
  dx,
  dy,
  who,
  selected,
  renaming,
  covered,
  events,
  arrivedAt,
}: {
  artboard: Artboard;
  dx: number;
  dy: number;
  who?: Worker[];
  selected: boolean;
  renaming: boolean;
  /** It would lie over another board (see labelCovers): hidden, unless it's needed. */
  covered: boolean;
  events: TitleEvents;
  /** When its board landed, while it's still arriving: the name develops with it. */
  arrivedAt?: number;
}) {
  // Kept while it's named, worked on, renamed or selected: those need it in view.
  const hide = covered && !who && !renaming && !selected;
  const name = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (name.current && arrivedAt !== undefined) arriveName(name.current, arrivedAt);
  }, [arrivedAt]);
  return (
    <div
      className="pz:absolute pz:h-0"
      style={{
        left: wpx(ab.x + dx),
        top: wpx(ab.y + dy),
        width: wpx(size(ab).w),
        visibility: hide ? "hidden" : undefined,
      }}
    >
      <div
        className={cn(
          "pz:pointer-events-auto pz:absolute pz:top-[-22px] pz:left-0 pz:flex pz:cursor-default pz:items-center pz:gap-[0.5em] pz:whitespace-nowrap pz:text-[12px] pz:leading-[1.4]",
          // Zoomed out, the title would run into the next board; clip it to this one.
          !renaming && "pz:max-w-full",
          // Spans the board so an agent's status can sit on the right.
          who && "pz:right-0",
          selected ? "pz:text-select" : "pz:text-muted-foreground pz:hover:text-foreground",
        )}
        onPointerDown={(e) => events.down(e, ab)}
        onDoubleClick={() => events.rename(ab.id)}
      >
        {renaming ? (
          <input
            autoFocus
            className="pz:rounded-[3px] pz:bg-card pz:px-[0.3em] pz:text-[12px] pz:outline-1 pz:outline-select"
            defaultValue={ab.name}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== ab.name) events.apply({ op: "artboard.update", id: ab.id, name: v });
              events.rename(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") events.rename(null);
            }}
          />
        ) : (
          <span ref={name} data-board-name className="pz:min-w-0 pz:truncate" title={ab.name}>
            {ab.name}
          </span>
        )}
        {who && <WorkingStatus who={who} />}
      </div>
    </div>
  );
});

/** Whether a wheel would scroll this element. */
function canScroll(el: HTMLElement, e: WheelEvent) {
  const s = getComputedStyle(el);
  const y =
    /auto|scroll/.test(s.overflowY) &&
    ((e.deltaY > 0 && el.scrollTop + el.clientHeight < el.scrollHeight) ||
      (e.deltaY < 0 && el.scrollTop > 0));
  const x =
    /auto|scroll/.test(s.overflowX) &&
    ((e.deltaX > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth) ||
      (e.deltaX < 0 && el.scrollLeft > 0));
  return y || x;
}

/**
 * A length in page px as screen px, for the overlay layer: it follows the
 * camera's translation and carries its zoom as --z (see useCameraLayers).
 */
function wpx(n: number) {
  return `calc(var(--z) * ${n}px)`;
}

function worldRect(r: { x: number; y: number; w: number; h: number }) {
  return { left: wpx(r.x), top: wpx(r.y), width: wpx(r.w), height: wpx(r.h) };
}

/** A board's box in page px, grown by the ring's gap in screen px, for the overlay layer. */
function ringBox(r: { x: number; y: number; w: number; h: number }) {
  return {
    left: `calc(var(--z) * ${r.x}px - ${RING_GAP}px)`,
    top: `calc(var(--z) * ${r.y}px - ${RING_GAP}px)`,
    width: `calc(var(--z) * ${r.w}px + ${2 * RING_GAP}px)`,
    height: `calc(var(--z) * ${r.h}px + ${2 * RING_GAP}px)`,
  };
}

/** The zoom label, the only text that changes with the camera; it renders on its own. */
function ZoomPercent({ camera }: { camera: CameraStore }) {
  return <>{useZoomPercent(camera)}%</>;
}

/** A node's box in its artboard's px, and which artboard it was found in. */
interface NodeBox {
  artboardId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function sameBoxes(a: Record<string, NodeBox>, b: Record<string, NodeBox>) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const p = a[k]!;
    const q = b[k];
    return (
      !!q &&
      p.artboardId === q.artboardId &&
      Math.abs(p.x - q.x) < 0.5 &&
      Math.abs(p.y - q.y) < 0.5 &&
      Math.abs(p.w - q.w) < 0.5 &&
      Math.abs(p.h - q.h) < 0.5
    );
  });
}

/** Where a pin sits, in page px. */
function pinPoint(t: Thread, ab: Artboard | undefined, boxes: Record<string, NodeBox>) {
  let { x, y } = t;
  // Pins were placed in artboard coordinates; keep them on their node as it moves or resizes.
  const box = ab && t.nodeId ? boxes[t.nodeId] : undefined;
  if (box && box.artboardId === ab?.id) {
    x = Math.min(Math.max(x, box.x), box.x + box.w);
    y = Math.min(Math.max(y, box.y), box.y + box.h);
  }
  // On the open canvas, x and y are already page coordinates.
  return { x: (ab?.x ?? 0) + x, y: (ab?.y ?? 0) + y };
}

/**
 * A node's box in its artboard's pixels. Measured against the artboard rather
 * than the viewport, so it holds whatever the camera does next.
 */
function nodeBox(vp: HTMLElement, ab: Artboard, nodeId: string) {
  const host = vp.querySelector(`[data-artboard-host="${CSS.escape(ab.id)}"]`);
  const board = host?.parentElement;
  const el = host?.shadowRoot?.querySelector(`[data-id="${CSS.escape(nodeId)}"]`);
  if (!board || !el) return null;
  const b = board.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const k = b.width / size(ab).w;
  if (!k) return null;
  return { x: (r.left - b.left) / k, y: (r.top - b.top) / k, w: r.width / k, h: r.height / k };
}

/**
 * Outlines for selected artboards and nodes, in page px. Placed from the model
 * and the measured node boxes: the DOM may still show the last frame, so after
 * a move it would put the outline where the board used to be.
 */
function selectionRects(
  ids: string[],
  boards: Artboard[],
  boardHeight: (ab: Artboard) => number,
  offset: (id: string) => { dx: number; dy: number } | null,
  boxes: Record<string, NodeBox>,
) {
  const out: { id: string; x: number; y: number; w: number; h: number; artboard: boolean }[] = [];
  for (const id of ids) {
    let ab = boards.find((b) => b.id === id);
    let box: { x: number; y: number; w: number; h: number } | undefined = ab
      ? { x: 0, y: 0, w: size(ab).w, h: boardHeight(ab) }
      : undefined;
    if (!box) {
      const nb = boxes[id];
      ab = nb && boards.find((b) => b.id === nb.artboardId);
      box = nb;
    }
    if (!ab || !box) continue;
    const g = offset(ab.id);
    out.push({
      id,
      x: ab.x + (g?.dx ?? 0) + box.x,
      y: ab.y + (g?.dy ?? 0) + box.y,
      w: box.w,
      h: box.h,
      artboard: ab.id === id,
    });
  }
  return out;
}
