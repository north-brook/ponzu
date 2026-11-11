import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { AgentActivity, OlderItems, ThreadItem } from "../model.ts";
import { useNow } from "../time.ts";
import { SCROLL_FADE } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { TurnFoldLine } from "./fold.tsx";
import { atFoot, FOLLOWING, follow, type ScrollMetrics } from "./follow.ts";
import { type LineHandlers, SandboxLine, ThreadLine, WorkingLine } from "./lines.tsx";
import { isFold, type Row, SENT_GRACE_MS, sandboxLine, threadRows, workingLine } from "./thread.ts";

/** Rows drawn at first, and how many more each time the person reads up past them. */
const WINDOW = 80;
const PAGE = 40;
/** How near the top reading up reveals more, or asks for older items. */
const NEAR_TOP = 320;

/** A row's key: its item's id, or its fold's. */
const rowKey = (row: Row) => (isFold(row) ? `fold:${row.fold.id}` : row.item.id);

const metricsOf = (el: HTMLElement): ScrollMetrics => ({
  scrollTop: el.scrollTop,
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
});

/**
 * The thread, newest at the foot. It follows the foot as lines arrive and text streams in, and
 * stops following once the person scrolls up to read; a quiet pill counts what arrived since and
 * takes them back. Only the newest rows are drawn: reading up reveals more, a page at a time,
 * without moving what is on screen, and asks for older items once every loaded one is drawn.
 */
export function ThreadView({
  items,
  older,
  onLoadOlder,
  agent,
  meId,
  handlers,
}: {
  items: ThreadItem[];
  older: OlderItems;
  onLoadOlder: () => void;
  agent: AgentActivity;
  meId: string;
  handlers: LineHandlers;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [state, dispatch] = useReducer(follow, FOLLOWING);
  const following = useRef(state.following);
  following.current = state.following;

  // Only the agent's state decides whether its last turn folds: not each change of its status.
  const agentState = agent.state;
  const rows = useMemo(
    () => threadRows(items, { state: agentState, status: null }),
    [items, agentState],
  );
  const waiting = sandboxLine(agent);
  const now = useNow();
  const working = waiting ? null : workingLine(items, agent, now);
  // A send's "Thinking" before the agent has said anything lasts only so long: look again then.
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!working || agentState !== "idle") return;
    const timer = setTimeout(recheck, SENT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [working, agentState]);

  // The window: from `firstId` to the end. Null, while following, is the newest WINDOW rows.
  const [firstId, setFirstId] = useState<string | null>(null);
  const found = firstId ? rows.findIndex((r) => rowKey(r) === firstId) : -1;
  const start = found >= 0 ? found : Math.max(0, rows.length - WINDOW);
  const shown = rows.slice(start);

  /** Where the rail last put the scroll itself, to tell its own scrolls from the person's. */
  const ours = useRef(-1);
  const jumping = useRef(false);
  const toFoot = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    ours.current = el.scrollTop;
  }, []);

  // New rows at the foot: follow them, or count them for the pill.
  const lastId = useRef(items.at(-1)?.id);
  useEffect(() => {
    const at = items.findIndex((item) => item.id === lastId.current);
    const fresh = at < 0 ? [] : items.slice(at + 1);
    lastId.current = items.at(-1)?.id;
    if (!fresh.length) return;
    const mine = fresh.some((item) => item.kind === "message" && item.payload.from.id === meId);
    dispatch({ type: "arrived", count: fresh.length, mine });
  }, [items, meId]);

  /*
   * While the person reads, the line at the top of the view stays put whatever changes around
   * it: rows revealed above, a picture loading above, the rail resizing. The browser's own scroll
   * anchoring is off, since it fights following the foot, so the rail anchors by hand: it notes
   * where the first line in view sits, and after a change scrolls by however far it moved.
   */
  const anchor = useRef<{ el: Element; top: number } | null>(null);
  const noteAnchor = useCallback(() => {
    const el = scroller.current;
    const top = el?.getBoundingClientRect().top ?? 0;
    const line = [...(content.current?.children ?? [])].find(
      (child) => child.getBoundingClientRect().bottom > top,
    );
    anchor.current = line ? { el: line, top: line.getBoundingClientRect().top } : null;
  }, []);
  const holdAnchor = useCallback(() => {
    const el = scroller.current;
    const held = anchor.current;
    if (!el || !held?.el.isConnected) return;
    const moved = held.el.getBoundingClientRect().top - held.top;
    if (Math.abs(moved) < 0.5) return;
    el.scrollTop += moved;
    ours.current = el.scrollTop;
  }, []);

  /*
   * A fold opening or closing holds its own line where it is, whether the person was at the
   * foot or reading: what it opens on grows below it, never pushing it out from under the
   * pointer. Once it has settled, the rail follows again if it ends at the foot.
   */
  const pinned = useRef<{ el: Element; top: number } | null>(null);
  const pinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdPinned = useCallback(() => {
    const el = scroller.current;
    const held = pinned.current;
    if (!el || !held?.el.isConnected) return false;
    const moved = held.el.getBoundingClientRect().top - held.top;
    if (Math.abs(moved) >= 0.5) el.scrollTop += moved;
    ours.current = el.scrollTop;
    return true;
  }, []);
  const onToggleFold = useCallback((trigger: HTMLElement) => {
    pinned.current = { el: trigger, top: trigger.getBoundingClientRect().top };
    // A thread shorter than the rail sits at its foot, with room above: kept as room at the
    // top, what opens grows down from the line rather than lifting everything into that room.
    const box = content.current;
    const first = box?.firstElementChild;
    if (box && first && !box.style.paddingTop) {
      const room = first.getBoundingClientRect().top - box.getBoundingClientRect().top;
      if (room > 1) box.style.paddingTop = `${room}px`;
    }
    if (pinTimer.current) clearTimeout(pinTimer.current);
    pinTimer.current = setTimeout(() => {
      pinned.current = null;
      const el = scroller.current;
      if (el) dispatch({ type: "scrolled", metrics: metricsOf(el) });
    }, 400);
  }, []);
  useEffect(
    () => () => {
      if (pinTimer.current) clearTimeout(pinTimer.current);
    },
    [],
  );

  // The room kept for an opened fold goes once the thread itself changes.
  useLayoutEffect(() => {
    if (items && content.current) content.current.style.paddingTop = "";
  }, [items]);

  useLayoutEffect(() => {
    if (holdPinned()) return;
    if (following.current) toFoot();
    else holdAnchor();
    noteAnchor();
  });

  // Text streaming in, a picture loading, the rail resizing: still at the foot if following,
  // still on the same line if reading.
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (jumping.current || holdPinned()) return;
      if (following.current) toFoot();
      else holdAnchor();
      noteAnchor();
    });
    if (content.current) observer.observe(content.current);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [toFoot, holdAnchor, noteAnchor, holdPinned]);

  // Back at the foot with a long window drawn: let the oldest go again.
  useEffect(() => {
    if (state.following && rows.length - start > WINDOW * 2) setFirstId(null);
  }, [state.following, rows.length, start]);

  const [edges, setEdges] = useState({ top: false, bottom: false });
  // Older items are asked for once each time there are more to ask for.
  const asked = useRef(false);
  useEffect(() => {
    if (older !== "more") asked.current = false;
  }, [older]);

  const readUp = useCallback(() => {
    const el = scroller.current;
    if (!el || el.scrollTop > NEAR_TOP) return;
    if (start > 0) setFirstId(rowKey(rows[Math.max(0, start - PAGE)]!));
    else if (older === "more" && !asked.current) {
      asked.current = true;
      onLoadOlder();
    }
  }, [start, rows, older, onLoadOlder]);

  // Older items that arrive while the person is up there are revealed without another scroll.
  useEffect(() => {
    if (!following.current) readUp();
  }, [readUp]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const m = metricsOf(el);
    noteAnchor();
    setEdges((prev) => {
      const next = { top: m.scrollTop > 1, bottom: !atFoot(m) };
      return prev.top === next.top && prev.bottom === next.bottom ? prev : next;
    });
    if (jumping.current || Math.abs(m.scrollTop - ours.current) < 2) return;
    dispatch({ type: "scrolled", metrics: m });
    // Reading, the window holds its first row: what arrives at the foot no longer pushes the
    // oldest out from above what the person is reading.
    if (!atFoot(m) && firstId === null && rows[start]) setFirstId(rowKey(rows[start]));
    readUp();
  };

  const onScrollEnd = () => {
    const el = scroller.current;
    if (!el || !jumping.current) return;
    jumping.current = false;
    ours.current = el.scrollTop;
    dispatch({ type: "scrolled", metrics: metricsOf(el) });
  };

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    dispatch({ type: "jumped" });
    jumping.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const fade = edges.top || edges.bottom;
  const mask = fade
    ? `linear-gradient(to bottom, ${edges.top ? "transparent" : "black"}, black ${SCROLL_FADE}px, black calc(100% - ${SCROLL_FADE}px), ${edges.bottom ? "transparent" : "black"})`
    : undefined;
  const maskStyle: CSSProperties = { maskImage: mask, WebkitMaskImage: mask };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        onScrollEnd={onScrollEnd}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [overflow-anchor:none] [scrollbar-color:var(--c-dry)_transparent] [scrollbar-width:thin]"
        style={maskStyle}
      >
        <div
          ref={content}
          role="log"
          aria-label="Thread"
          aria-busy={older === "loading" || undefined}
          className="flex min-h-full flex-col justify-end gap-[14px] px-1 py-2"
        >
          {older === "loading" && start === 0 ? (
            <div className="breathe self-center py-1 text-12 text-faint">Loading earlier…</div>
          ) : null}
          {shown.map((row) =>
            isFold(row) ? (
              <TurnFoldLine
                key={rowKey(row)}
                fold={row.fold}
                handlers={handlers}
                onToggle={onToggleFold}
              />
            ) : (
              <ThreadLine key={row.item.id} {...row} meId={meId} handlers={handlers} />
            ),
          )}
          {working ? <WorkingLine label={working} /> : null}
          {waiting ? <SandboxLine {...waiting} /> : null}
        </div>
      </div>
      {!state.following && state.unseen > 0 ? (
        <button
          type="button"
          onClick={jump}
          aria-label={`Jump to ${state.unseen} new in the thread`}
          className="rise absolute bottom-2.5 left-1/2 flex h-7 -translate-x-1/2 cursor-default items-center gap-1 rounded-pill bg-surface pr-2.5 pl-2 font-medium text-12 text-muted shadow-bar outline-none transition-colors duration-(--dur-hover) focus-ring hover:text-ink active:bg-selected"
        >
          <Icon icon={ArrowDown01Icon} size={12} stroke={2.2} />
          {state.unseen} new
        </button>
      ) : null}
    </div>
  );
}

/** The thread on its way: a few lines breathing, shaped like a conversation. */
export function ThreadSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the thread"
      className="flex min-h-0 flex-1 flex-col justify-end gap-[14px] px-1 py-2"
    >
      {[
        { side: "end", width: 180 },
        { side: "start", width: 290 },
        { side: "start", width: 210 },
        { side: "end", width: 140 },
        { side: "start", width: 260 },
      ].map(({ side, width }, i) =>
        side === "end" ? (
          <Skeleton
            key={`${side}-${width}`}
            className="h-[38px] self-end rounded-14"
            style={{ width, animationDelay: `${i * 120}ms` }}
          />
        ) : (
          <Skeleton
            key={`${side}-${width}`}
            className="h-3 rounded-3"
            style={{ width, animationDelay: `${i * 120}ms` }}
          />
        ),
      )}
    </div>
  );
}
