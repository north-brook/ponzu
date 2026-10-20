import { type Artboard, type Author, findArtboard, locate, newId, type Thread } from "@ponzu/core";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArtboardView } from "./Artboard.tsx";
import { CommentsPanel, Composer, ThreadCard } from "./Comments.tsx";
import type { CanvasSource } from "./connection.ts";
import { AgentMark, Icon } from "./icons.tsx";
import { isTyping, useCamera, useKeyHeld, useSource } from "./useCanvas.ts";

export type Mode = "select" | "hand" | "comment";

export interface CanvasProps {
  source: CanvasSource;
  /** Who's using the canvas, for comments. */
  me?: Author;
  theme?: "light" | "dark";
  /** Render a footer with page tabs and controls. Default true. */
  footer?: boolean;
  /** Extra content on the right of the footer, before the modes. */
  footerExtra?: ReactNode;
  className?: string;
}

interface Pending {
  artboardId: string;
  nodeId?: string;
  /** Offset inside the artboard, in artboard px. */
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
  const [panel, setPanel] = useState(false);
  const [showResolved] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const fitted = useRef<string | null>(null);

  const selection = state.selection.ids;
  const working = useMemo(() => {
    const map = new Map<string, { name: string; client?: string }[]>();
    for (const p of state.presence)
      for (const id of p.working)
        map.set(id, [...(map.get(id) ?? []), { name: p.name, client: p.client }]);
    return map;
  }, [state.presence]);

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

  // Wheel: pan; pinch or modifier: zoom.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey)
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else panBy(-e.deltaX, -e.deltaY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, panBy]);

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
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
  const hitTest = (e: React.PointerEvent): { artboard: Artboard; nodeId?: string } | null => {
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
      if (!hit) return;
      const w = toWorld(e.clientX, e.clientY);
      setOpenThread(null);
      setPending({
        artboardId: hit.artboard.id,
        nodeId: hit.nodeId,
        x: w.x - hit.artboard.x,
        y: w.y - hit.artboard.y,
      });
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
      artboardId: pending.artboardId,
      ...(pending.nodeId ? { nodeId: pending.nodeId } : {}),
      x: Math.round(pending.x),
      y: Math.round(pending.y),
      status: "open",
      createdAt: now,
      updatedAt: now,
      messages: [{ id: newId("m"), author: me, text, createdAt: now }],
    };
    source.apply({ op: "thread.create", thread });
    setPending(null);
    setOpenThread(thread.id);
    setMode("select");
  };

  if (!doc || !page) {
    return (
      <div className={`pz-root pz-${theme} ${className ?? ""}`}>
        <div className="pz-loading">
          {state.status === "offline" ? "Reconnecting to Ponzu…" : "Opening…"}
        </div>
      </div>
    );
  }

  const pageThreads = doc.threads.filter(
    (t) =>
      (showResolved || t.status === "open" || t.id === openThread) &&
      boards.some((b) => b.id === t.artboardId),
  );
  const openCount = doc.threads.filter((t) => t.status === "open").length;
  const zoomPct = Math.round(camera.zoom * 100);
  const selectedRects = selectionRects(selection, viewport.current, camera);
  const ghostFor = (id: string) => (ghost && drag.current?.ids.includes(id) ? ghost : null);

  return (
    <div className={`pz-root pz-${theme} ${className ?? ""}`}>
      <div
        ref={viewport}
        className={`pz-viewport pz-mode-${panning ? "hand" : mode}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDragOver={(e) => e.preventDefault()}
      >
        <div
          className="pz-world"
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
                className={`pz-board ${selection.includes(ab.id) ? "pz-selected" : ""}`}
                style={{ left: x, top: y, width: w, height: h ?? undefined }}
              >
                <div
                  className="pz-board-title"
                  style={{ fontSize: 12 / camera.zoom, top: -22 / camera.zoom }}
                  onPointerDown={(e) => startMove(e, ab)}
                  onDoubleClick={() => setRenaming(ab.id)}
                >
                  {renaming === ab.id ? (
                    <input
                      autoFocus
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
                    <span>{ab.name}</span>
                  )}
                  {who && (
                    <span className="pz-board-agents" style={{ gap: 4 / camera.zoom }}>
                      {who.map((a) => (
                        <span
                          key={a.name}
                          className="pz-agent-chip"
                          title={`${a.name} is working here`}
                        >
                          <AgentMark client={a.client} size={12 / camera.zoom} />
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <ArtboardView artboard={ab} tokens={doc.tokens} assetBase={source.assetBase} />
              </div>
            );
          })}
        </div>

        {/* Overlays in screen space so they stay crisp at any zoom. */}
        <div className="pz-overlay">
          {selectedRects.map((r) => (
            <div
              key={r.id}
              className={`pz-sel ${r.artboard ? "pz-sel-board" : ""}`}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            />
          ))}
          {pageThreads.map((t) => {
            const ab = boards.find((b) => b.id === t.artboardId);
            if (!ab) return null;
            const p = pinPoint(t, ab, viewport.current, camera);
            const open = openThread === t.id;
            return (
              <div key={t.id} className="pz-pin-wrap" style={{ left: p.x, top: p.y }}>
                <button
                  type="button"
                  className={`pz-pin ${t.status === "resolved" ? "pz-pin-resolved" : ""} ${open ? "pz-pin-open" : ""}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setOpenThread(open ? null : t.id)}
                >
                  {t.messages.length}
                </button>
                {open && (
                  <ThreadCard
                    thread={t}
                    doc={doc}
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
              const ab = boards.find((b) => b.id === pending.artboardId)!;
              const x = (ab.x + pending.x) * camera.zoom + camera.x;
              const y = (ab.y + pending.y) * camera.zoom + camera.y;
              return (
                <div className="pz-pin-wrap" style={{ left: x, top: y }}>
                  <span className="pz-pin pz-pin-open">+</span>
                  <div className="pz-thread">
                    <Composer onSubmit={createThread} onCancel={() => setPending(null)} />
                  </div>
                </div>
              );
            })()}
        </div>

        {!boards.length && (
          <div className="pz-empty-page">
            <p>This page is empty.</p>
            <p className="pz-muted">
              Ask your agent to design something. It will appear here as it works.
            </p>
          </div>
        )}
        {panel && (
          <CommentsPanel
            doc={doc}
            onClose={() => setPanel(false)}
            onOpen={(t) => {
              const pg = doc.pages.find((p) => p.artboards.some((a) => a.id === t.artboardId));
              if (pg && pg.id !== page.id) {
                fitted.current = pg.id;
                setPageId(pg.id);
              }
              const ab = findArtboard(doc, t.artboardId)?.artboard;
              if (ab)
                fit(
                  { x: ab.x, y: ab.y, w: size(ab).w, h: boardHeight(ab) },
                  viewportSize(),
                  120,
                  1,
                );
              setOpenThread(t.id);
            }}
          />
        )}
      </div>

      {footer && (
        <div className="pz-footer">
          <div className="pz-pages">
            {doc.pages.map((p) => (
              <PageTab
                key={p.id}
                name={p.name}
                icon={p.icon}
                active={p.id === page.id}
                onClick={() => {
                  setPageId(p.id);
                  setPending(null);
                  setOpenThread(null);
                }}
                onRename={(name) => source.apply({ op: "page.update", id: p.id, name })}
              />
            ))}
            <button
              type="button"
              className="pz-icon-btn"
              title="New page"
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
            </button>
          </div>
          <div className="pz-controls">
            {footerExtra}
            <button
              type="button"
              className={`pz-comments-btn ${panel ? "on" : ""}`}
              onClick={() => setPanel((v) => !v)}
            >
              {openCount > 0 && <span className="pz-badge">{openCount}</span>}
              Comments
            </button>
            <div className="pz-modes">
              {(["select", "hand", "comment"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={(panning ? "hand" : mode) === m ? "on" : ""}
                  title={`${m[0]!.toUpperCase()}${m.slice(1)} (${m === "select" ? "V" : m === "hand" ? "H" : "C"})`}
                  onClick={() => setMode(m)}
                >
                  <Icon name={m} size={16} />
                </button>
              ))}
            </div>
            <div className="pz-zoom">
              <button
                type="button"
                className="pz-icon-btn"
                onClick={() => zoomAt(0.8, viewportSize().w / 2, viewportSize().h / 2)}
                title="Zoom out (⌘−)"
              >
                <Icon name="minus" size={14} />
              </button>
              <button
                type="button"
                className="pz-zoom-value"
                onClick={fitPage}
                title="Zoom to fit (⇧1)"
              >
                {zoomPct}%
              </button>
              <button
                type="button"
                className="pz-icon-btn"
                onClick={() => zoomAt(1.25, viewportSize().w / 2, viewportSize().h / 2)}
                title="Zoom in (⌘+)"
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PageTab({
  name,
  icon,
  active,
  onClick,
  onRename,
}: {
  name: string;
  icon?: string;
  active: boolean;
  onClick: () => void;
  onRename: (n: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <button
      type="button"
      className={`pz-page ${active ? "on" : ""}`}
      onClick={onClick}
      onDoubleClick={() => setEditing(true)}
    >
      <Icon name={icon ?? "file"} size={14} />
      {editing ? (
        <input
          autoFocus
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
        <span>{name}</span>
      )}
    </button>
  );
}

function pinPoint(
  t: Thread,
  ab: Artboard,
  vp: HTMLElement | null,
  cam: { x: number; y: number; zoom: number },
) {
  // Prefer the node's live position: top-right corner of the node.
  if (t.nodeId && vp) {
    const host = vp.querySelector(`[data-artboard-host="${ab.id}"]`) as HTMLElement | null;
    const el = host?.shadowRoot?.querySelector(
      `[data-id="${CSS.escape(t.nodeId)}"]`,
    ) as HTMLElement | null;
    if (el) {
      const r = el.getBoundingClientRect();
      const v = vp.getBoundingClientRect();
      const ox = Math.min(t.x * cam.zoom, r.width);
      const oy = Math.min(t.y * cam.zoom, r.height);
      const nodeOrigin = { x: r.left - v.left, y: r.top - v.top };
      // Pins were placed in artboard coordinates; keep them inside the node.
      const abOrigin = { x: ab.x * cam.zoom + cam.x, y: ab.y * cam.zoom + cam.y };
      const want = { x: abOrigin.x + t.x * cam.zoom, y: abOrigin.y + t.y * cam.zoom };
      const inside =
        want.x >= nodeOrigin.x &&
        want.x <= nodeOrigin.x + r.width &&
        want.y >= nodeOrigin.y &&
        want.y <= nodeOrigin.y + r.height;
      return inside ? want : { x: nodeOrigin.x + ox, y: nodeOrigin.y + oy };
    }
  }
  return { x: (ab.x + t.x) * cam.zoom + cam.x, y: (ab.y + t.y) * cam.zoom + cam.y };
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
