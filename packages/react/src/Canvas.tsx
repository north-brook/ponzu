import {
  type Artboard,
  type Author,
  findArtboard,
  locate,
  newId,
  type Thread,
  threadPage,
} from "@ponzu/core";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArtboardView } from "./Artboard.tsx";
import { Composer, ThreadCard, threadCard } from "./Comments.tsx";
import type { CanvasSource } from "./connection.ts";
import { AgentMark, Icon, Icons } from "./icons.tsx";
import { Button, cn, Tip, TipProvider, ToggleGroup } from "./ui.tsx";
import { isTyping, useCamera, useKeyHeld, useSource } from "./useCanvas.ts";
import { Juice, useDelayed } from "./working.tsx";

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
  className?: string;
}

interface Pending {
  /** Absent for a comment on the open canvas. */
  artboardId?: string;
  pageId: string;
  nodeId?: string;
  /** Offset inside the artboard in artboard px, or the page position without one. */
  x: number;
  y: number;
}

function size(ab: Artboard) {
  const w = Number.parseFloat(ab.root.style.width ?? "") || 1440;
  const hRaw = ab.root.style.height;
  const h = hRaw && hRaw.endsWith("px") ? Number.parseFloat(hRaw) : null;
  return { w, h };
}

/**
 * The Ponzu canvas: pages of artboards on an infinite plane, comments pinned
 * to nodes, and live presence. Read-only for layout (agents do the editing);
 * people select, comment, rename and arrange.
 */
export function Canvas({
  source,
  me = { kind: "user", name: "You" },
  theme = "light",
  footer = true,
  footerExtra,
  className,
}: CanvasProps) {
  const state = useSource(source);
  const doc = state.doc;
  const [pageId, setPageId] = useState<string | null>(null);
  const page = doc?.pages.find((p) => p.id === pageId) ?? doc?.pages[0];
  const [mode, setMode] = useState<Mode>("select");
  const space = useKeyHeld("Space");
  const panning = mode === "hand" || space;
  const { camera, zoomAt, panBy, fit } = useCamera();
  const viewport = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const fitted = useRef<string | null>(null);

  const selection = state.selection.ids;
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

  const boards = page?.artboards ?? [];
  const boardHeight = (ab: Artboard) => size(ab).h ?? measured[ab.id] ?? 900;

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

  const viewportSize = () => {
    const r = viewport.current?.getBoundingClientRect();
    return { w: r?.width ?? 1200, h: r?.height ?? 800 };
  };

  const fitPage = useCallback(() => {
    if (bounds) fit(bounds, viewportSize(), 72, 1);
  }, [bounds, fit]);

  // Fit when a page first shows.
  useEffect(() => {
    if (!page || !bounds || fitted.current === page.id) return;
    fitted.current = page.id;
    fitPage();
  }, [page, bounds, fitPage]);

  // Follow focus requests (agent created an artboard).
  useEffect(() => {
    const f = state.focus;
    if (!f || !doc) return;
    if (f.page !== page?.id) {
      fitted.current = f.page;
      setPageId(f.page);
    }
    const ab = findArtboard(doc, f.artboard)?.artboard;
    if (ab) {
      const { w } = size(ab);
      fit({ x: ab.x, y: ab.y, w, h: boardHeight(ab) }, viewportSize(), 96, 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.focus?.at]);

  // Measure artboards with fit-content height.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const next: Record<string, number> = {};
    for (const ab of boards) {
      if (size(ab).h !== null) continue;
      const host = el.querySelector(`[data-artboard-host="${ab.id}"]`) as HTMLElement | null;
      const inner = host?.shadowRoot?.querySelector("[data-artboard]") as HTMLElement | null;
      if (inner) next[ab.id] = inner.offsetHeight;
    }
    if (Object.keys(next).some((k) => next[k] !== measured[k]))
      setMeasured((m) => ({ ...m, ...next }));
  });

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
      if (e.composedPath().some((n) => n instanceof Element && n.hasAttribute("data-comment-open")))
        return;
      e.preventDefault();
      panBy(-e.deltaX, -e.deltaY);
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

  const goToPage = (id: string) => {
    setPageId(id);
    setPending(null);
    setOpenThread(null);
  };

  // Keyboard.
  useEffect(() => {
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
        e.shiftKey ? source.redo() : source.undo();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        const v = viewportSize();
        zoomAt(1.25, v.w / 2, v.h / 2);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        const v = viewportSize();
        zoomAt(0.8, v.w / 2, v.h / 2);
      } else if (e.shiftKey && e.key === "1") {
        fitPage();
      } else if (e.shiftKey && e.key === "2" && selection[0] && doc) {
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
      } else if (!mod && e.key === "v") setMode("select");
      else if (!mod && e.key === "h") setMode("hand");
      else if (!mod && e.key === "c") setMode("comment");
      else if (e.key === "Escape") {
        setPending(null);
        setOpenThread(null);
        source.select({ ids: [] });
        setMode("select");
      } else if ((e.key === "Backspace" || e.key === "Delete") && selection.length && doc) {
        // Only artboards are deleted from the canvas; node edits are for agents.
        const ids = selection.filter((id) => findArtboard(doc, id));
        if (ids.length)
          source.apply(
            ids.length === 1
              ? { op: "artboard.delete", id: ids[0]! }
              : { op: "batch", ops: ids.map((id) => ({ op: "artboard.delete" as const, id })) },
          );
        source.select({ ids: [] });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toWorld = (clientX: number, clientY: number) => {
    const r = viewport.current!.getBoundingClientRect();
    return {
      x: (clientX - r.left - camera.x) / camera.zoom,
      y: (clientY - r.top - camera.y) / camera.zoom,
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
    const els = host?.shadowRoot?.elementsFromPoint(e.clientX, e.clientY) ?? [];
    const el = els.find((x) => x.hasAttribute("data-id") && !x.hasAttribute("data-artboard"));
    return { artboard: ab, nodeId: el?.getAttribute("data-id") ?? undefined };
  };

  // Pointer: pan, select, drag artboards by their title, place comments.
  const drag = useRef<{
    kind: "pan" | "move";
    startX: number;
    startY: number;
    ids: string[];
    origin: { id: string; x: number; y: number }[];
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
    if (mode === "comment") {
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
      source.select({ ids: [], page: page?.id });
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
    const id = e.altKey || !hit.nodeId ? hit.artboard.id : hit.nodeId;
    const ids = e.shiftKey
      ? selection.includes(id)
        ? selection.filter((x) => x !== id)
        : [...selection, id]
      : [id];
    source.select({ ids, page: page?.id });
  };

  const startMove = (e: React.PointerEvent, ab: Artboard) => {
    if (e.button !== 0 || panning) return;
    e.stopPropagation();
    const ids = selection.includes(ab.id)
      ? selection.filter((id) => findArtboard(doc!, id))
      : [ab.id];
    if (!selection.includes(ab.id)) source.select({ ids: [ab.id], page: page?.id });
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

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    if (d.kind === "pan") {
      panBy(e.movementX, e.movementY);
    } else if (d.moved) {
      setGhost({ dx: dx / camera.zoom, dy: dy / camera.zoom });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "move" && d.moved && ghost) {
      const ops = d.origin.map((o) => ({
        op: "artboard.update" as const,
        id: o.id,
        x: Math.round(o.x + ghost.dx),
        y: Math.round(o.y + ghost.dy),
      }));
      source.apply(ops.length === 1 ? ops[0]! : { op: "batch", ops });
    }
    setGhost(null);
  };

  const createThread = (text: string) => {
    if (!pending) return;
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
    /** Pointer position in the viewport, and what it's over. */
    x: number;
    y: number;
    target?: string;
  } | null>(null);

  const pinDown = (e: React.PointerEvent, t: Thread) => {
    // Space or the hand tool pans right through pins.
    if (panning || e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const r = viewport.current!.getBoundingClientRect();
    setPinDrag({
      id: t.id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      x: e.clientX - r.left,
      y: e.clientY - r.top,
    });
  };

  const pinMove = (e: React.PointerEvent) => {
    if (!pinDrag) return;
    const moved =
      pinDrag.moved ||
      Math.abs(e.clientX - pinDrag.startX) + Math.abs(e.clientY - pinDrag.startY) > 3;
    if (!moved) return;
    const r = viewport.current!.getBoundingClientRect();
    const hit = hitTest(e);
    setPinDrag({
      ...pinDrag,
      moved,
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      target: hit ? (hit.nodeId ?? hit.artboard.id) : undefined,
    });
  };

  const pinUp = (e: React.PointerEvent, t: Thread) => {
    const d = pinDrag;
    setPinDrag(null);
    if (!d || d.id !== t.id || !page) return;
    if (!d.moved) {
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

  if (!doc || !page) {
    const offline = state.status === "offline";
    const name = state.path
      .split("/")
      .pop()
      ?.replace(/\.design$/, "");
    return (
      <div className={cn("pz-root", `pz-${theme}`, className)}>
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

  // Resolved threads leave the board.
  const pageThreads = doc.threads.filter(
    (t) => t.status === "open" && threadPage(doc, t)?.id === page.id,
  );
  const zoomPct = Math.round(camera.zoom * 100);
  const selectedRects = selectionRects(selection, viewport.current, camera);
  const ghostFor = (id: string) => (ghost && drag.current?.ids.includes(id) ? ghost : null);

  return (
    <div className={cn("pz-root", `pz-${theme}`, className)}>
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
        <div
          className="pz:absolute pz:top-0 pz:left-0 pz:origin-top-left pz:will-change-transform"
          style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
        >
          {boards.map((ab) => {
            const { w, h } = size(ab);
            const g = ghostFor(ab.id);
            const x = ab.x + (g?.dx ?? 0);
            const y = ab.y + (g?.dy ?? 0);
            const who = working.get(ab.id);
            return (
              <div
                key={ab.id}
                className="pz:absolute pz:shadow-board"
                style={{ left: x, top: y, width: w, height: h ?? undefined }}
              >
                <div
                  className={cn(
                    "pz:absolute pz:left-0 pz:flex pz:cursor-default pz:items-center pz:gap-[0.5em] pz:whitespace-nowrap pz:leading-[1.4]",
                    // Zoomed out, the title would run into the next board; clip it to this one.
                    renaming !== ab.id && "pz:max-w-full",
                    // Spans the board so an agent's status can sit on the right.
                    who && "pz:right-0",
                    selection.includes(ab.id)
                      ? "pz:text-select"
                      : "pz:text-muted-foreground pz:hover:text-foreground",
                  )}
                  style={{ fontSize: 12 / camera.zoom, top: -22 / camera.zoom }}
                  onPointerDown={(e) => startMove(e, ab)}
                  onDoubleClick={() => setRenaming(ab.id)}
                >
                  {renaming === ab.id ? (
                    <input
                      autoFocus
                      className="pz:rounded-[3px] pz:bg-card pz:px-[0.3em] pz:outline-1 pz:outline-select"
                      defaultValue={ab.name}
                      style={{ fontSize: 12 / camera.zoom }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== ab.name)
                          source.apply({ op: "artboard.update", id: ab.id, name: v });
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="pz:min-w-0 pz:truncate" title={ab.name}>
                      {ab.name}
                    </span>
                  )}
                  {who && <WorkingStatus who={who} zoom={camera.zoom} />}
                </div>
                <ArtboardView artboard={ab} tokens={doc.tokens} assetBase={source.assetBase} />
              </div>
            );
          })}
        </div>

        {/* Overlays in screen space so they stay crisp at any zoom. */}
        <div className="pz:pointer-events-none pz:absolute pz:inset-0">
          {boards.map((ab) => {
            if (!working.has(ab.id)) return null;
            const g = ghostFor(ab.id);
            const w = size(ab).w * camera.zoom;
            const h = boardHeight(ab) * camera.zoom;
            return (
              <Trace
                key={ab.id}
                x={(ab.x + (g?.dx ?? 0)) * camera.zoom + camera.x}
                y={(ab.y + (g?.dy ?? 0)) * camera.zoom + camera.y}
                w={w}
                h={h}
              />
            );
          })}
          {pinDrag?.moved &&
            pinDrag.target &&
            selectionRects([pinDrag.target], viewport.current, camera).map((r) => (
              <div
                key={r.id}
                className="pz:pointer-events-none pz:absolute pz:outline-[1.5px] pz:outline-select"
                style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
              />
            ))}
          {selectedRects.map((r) => (
            <div
              key={r.id}
              className={cn(
                "pz:pointer-events-none pz:absolute pz:outline-select",
                r.artboard ? "pz:outline-2" : "pz:outline-[1.5px]",
              )}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            />
          ))}
          {pageThreads.map((t) => {
            const ab = boards.find((b) => b.id === t.artboardId);
            const dragging = pinDrag?.id === t.id && pinDrag.moved ? pinDrag : null;
            const p = dragging ?? pinPoint(t, ab, viewport.current, camera);
            const open = openThread === t.id;
            return (
              <div
                key={t.id}
                className={pinWrap}
                style={{ left: p.x, top: p.y }}
                data-comment-open={open || undefined}
              >
                <button
                  type="button"
                  title="Drag to move"
                  className={cn(
                    pin,
                    "pz:bg-comment pz:text-comment-foreground",
                    panning ? "pz:cursor-grab" : "pz:cursor-pointer",
                    (open || dragging) && "pz:scale-112",
                    dragging && "pz:cursor-grabbing pz:shadow-[0_4px_12px_rgba(0,0,0,0.25)]",
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
                    onClose={() => setOpenThread(null)}
                  />
                )}
              </div>
            );
          })}
          {pending &&
            (() => {
              const ab = boards.find((b) => b.id === pending.artboardId);
              const x = ((ab?.x ?? 0) + pending.x) * camera.zoom + camera.x;
              const y = ((ab?.y ?? 0) + pending.y) * camera.zoom + camera.y;
              return (
                <div className={pinWrap} style={{ left: x, top: y }} data-comment-open>
                  <span
                    className={cn(pin, "pz:scale-112 pz:bg-comment pz:text-comment-foreground")}
                  >
                    +
                  </span>
                  <div className={threadCard}>
                    <Composer onSubmit={createThread} onCancel={() => setPending(null)} />
                  </div>
                </div>
              );
            })()}
        </div>
      </div>

      {footer && (
        <TipProvider>
          {/*
           * The bars float over the canvas, which runs to the container's edges beneath them.
           * Pointer and wheel events stop here, so pressing a bar never pans or zooms.
           */}
          <Bar name="Pages" className="pz:left-2.5 pz:max-w-[calc(100%-20px)]">
            <div className="pz:flex pz:min-w-0 pz:items-center pz:gap-0.5 pz:overflow-x-auto pz:[scrollbar-width:none]">
              {doc.pages.map((p, i) => (
                <PageTab
                  key={p.id}
                  name={p.name}
                  shortcut={i < 8 ? i + 1 : i === doc.pages.length - 1 ? 9 : undefined}
                  icon={p.icon}
                  active={p.id === page.id}
                  working={busyPages.has(p.id)}
                  onClick={() => goToPage(p.id)}
                  onRename={(name) => source.apply({ op: "page.update", id: p.id, name })}
                />
              ))}
            </div>
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
          </Bar>
          <Bar name="Controls" className="pz:right-2.5">
            {footerExtra}
            <ToggleGroup
              variant="raised"
              value={panning ? "hand" : mode}
              onValueChange={setMode}
              items={MODES.map((m) => ({
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
                className="pz:h-7 pz:min-w-11 pz:rounded-lg pz:px-0 pz:text-foreground pz:tabular-nums"
                aria-label="Zoom to fit"
                onClick={fitPage}
              >
                {zoomPct}%
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

/** A frosted bar pinned to a bottom corner of the canvas. */
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
        "pz:absolute pz:bottom-2.5 pz:z-[3] pz:flex pz:items-center pz:gap-0.5 pz:rounded-xl pz:bg-bar pz:p-1 pz:shadow-bar pz:backdrop-blur-[18px] pz:backdrop-saturate-[1.6]",
        className,
      )}
      onPointerDown={(e) => e.stopPropagation()}
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
 * The right side of a working artboard's header: what the agent says it's
 * doing, in shimmering ink, and its mark in color. Several agents show the
 * first one's status and all their marks.
 */
function WorkingStatus({ who, zoom }: { who: Worker[]; zoom: number }) {
  const status = who.find((a) => a.status)?.status ?? "Working";
  return (
    <span
      className="pz:ml-auto pz:inline-flex pz:min-w-0 pz:max-w-[60%] pz:items-center pz:text-muted-foreground"
      style={{ gap: 6 / zoom }}
      title={who.map((a) => `${a.name}: ${a.status ?? "working"}`).join("\n")}
    >
      <span className="pz-shimmer pz:min-w-0 pz:truncate">{status}</span>
      <span className="pz:inline-flex pz:shrink-0" style={{ gap: 3 / zoom }}>
        {who.map((a) => (
          <span key={a.id} className="pz:inline-grid pz:place-items-center pz:text-foreground">
            <AgentMark client={a.client} size={12 / zoom} />
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * A stroke tracing a working artboard's outline, over a faint full outline.
 * Drawn in the screen-space overlay so it's 1.5px at any zoom, and never part
 * of the design: screenshots and exports don't see it.
 */
function Trace({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <svg
      className="pz:pointer-events-none pz:absolute pz:overflow-visible pz:text-foreground"
      style={{ left: x, top: y, width: w, height: h }}
      aria-hidden
    >
      <rect
        width={w}
        height={h}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.14}
        strokeWidth={1}
      />
      <rect
        className="pz-trace"
        width={w}
        height={h}
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}

const pinWrap = "pz:pointer-events-auto pz:absolute pz:z-[2] pz:size-0";
/** A circle centred on the comment's spot, holding its message count. */
const pin =
  "pz:absolute pz:top-0 pz:left-0 pz:grid pz:size-6 pz:-translate-1/2 pz:place-items-center pz:rounded-full pz:font-semibold pz:text-[11px] pz:tabular-nums pz:shadow-[0_1px_3px_rgba(0,0,0,0.25)] pz:transition-transform pz:duration-[120ms] pz:hover:scale-112";

function PageTab({
  name,
  shortcut,
  icon,
  active,
  working,
  onClick,
  onRename,
}: {
  name: string;
  shortcut?: number;
  icon?: string;
  active: boolean;
  /** An agent is working on an artboard on this page. */
  working: boolean;
  onClick: () => void;
  onRename: (n: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const tab = (
    <button
      type="button"
      className={cn(
        "pz:inline-flex pz:h-7 pz:shrink-0 pz:items-center pz:gap-1.5 pz:whitespace-nowrap pz:rounded-lg pz:px-2.5",
        active
          ? "pz:bg-raised pz:text-foreground pz:shadow-raised"
          : "pz:text-muted-foreground pz:hover:bg-accent pz:hover:text-foreground",
      )}
      onClick={onClick}
      onDoubleClick={() => setEditing(true)}
    >
      <Icon name={icon && icon in Icons ? icon : "board"} size={14} />
      {editing ? (
        <input
          autoFocus
          className="pz:w-[9em] pz:bg-transparent pz:outline-0"
          defaultValue={name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== name) onRename(v);
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
  // While renaming, a tip would sit over the field.
  if (editing) return tab;
  return (
    <Tip label={name} keys={shortcut ? ["⌥", String(shortcut)] : undefined}>
      {tab}
    </Tip>
  );
}

function pinPoint(
  t: Thread,
  ab: Artboard | undefined,
  vp: HTMLElement | null,
  cam: { x: number; y: number; zoom: number },
) {
  let { x, y } = t;
  // Pins were placed in artboard coordinates; keep them on their node as it moves or resizes.
  const box = ab && t.nodeId && vp ? nodeBox(vp, ab, t.nodeId) : null;
  if (box) {
    x = Math.min(Math.max(x, box.x), box.x + box.w);
    y = Math.min(Math.max(y, box.y), box.y + box.h);
  }
  // On the open canvas, x and y are already page coordinates.
  return { x: ((ab?.x ?? 0) + x) * cam.zoom + cam.x, y: ((ab?.y ?? 0) + y) * cam.zoom + cam.y };
}

/**
 * A node's box in its artboard's pixels. Measured against the artboard rather
 * than the viewport: the DOM still shows the last frame's camera while a pan
 * renders, so mixing it with the new camera makes pins jump.
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

function selectionRects(
  ids: string[],
  vp: HTMLElement | null,
  _cam: { x: number; y: number; zoom: number },
) {
  if (!vp) return [];
  const v = vp.getBoundingClientRect();
  const out: { id: string; x: number; y: number; w: number; h: number; artboard: boolean }[] = [];
  for (const id of ids) {
    const board = vp.querySelector(`[data-artboard-host="${CSS.escape(id)}"]`)?.parentElement;
    if (board) {
      const r = board.getBoundingClientRect();
      out.push({
        id,
        x: r.left - v.left,
        y: r.top - v.top,
        w: r.width,
        h: r.height,
        artboard: true,
      });
      continue;
    }
    for (const host of vp.querySelectorAll("[data-artboard-host]")) {
      const el = (host as HTMLElement).shadowRoot?.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        out.push({
          id,
          x: r.left - v.left,
          y: r.top - v.top,
          w: r.width,
          h: r.height,
          artboard: false,
        });
        break;
      }
    }
  }
  return out;
}
