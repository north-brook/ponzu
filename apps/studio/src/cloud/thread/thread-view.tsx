import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import {
  type CSSProperties,
  type ReactNode,
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
import { atFoot, FOLLOWING, follow, type ScrollMetrics } from "./follow.ts";
import {
  BillingLine,
  type BillingWait,
  type LineHandlers,
  SandboxLine,
  ThreadLine,
  WorkingLine,
} from "./lines.tsx";
import { SENT_GRACE_MS, sandboxLine, type ThreadRow, threadRows, workingLine } from "./thread.ts";

/** Rows drawn at first, and how many more each time the person reads up past them. */
const WINDOW = 80;
const PAGE = 40;
/** How near the top reading up reveals more, or asks for older items. */
const NEAR_TOP = 320;
/** The gap between the thread's lines (`gap-[14px]`). */
const LINE_GAP = 14;

const rowKey = (row: ThreadRow) => row.item.id;

/**
 * Where a line that can leave sits, from its last frame: the room it takes in the thread (from
 * the bottom of the line above to its own bottom) and how much of that is the space above it.
 */
interface Place {
  room: number;
  above: number;
  /** It has a line above it, so the thread's gap comes before it. */
  after: boolean;
}

/** A line on its way out: drawn as it was, in the room it held, while that room closes. */
interface Leaving {
  /** An aside of a turn that has ended; or null, the working line (with its `label`). */
  row: ThreadRow | null;
  label: string;
  /** The row an aside follows, so it leaves from where it was; null, the thread's first. */
  follows: string | null;
  place: Place;
}

/** The working line's key among the places of what can leave. */
const WORKING = "working-line";

/**
 * A line to bring into view and mark: by its id, or, when the thread no longer shows it, the
 * first line shown from its seq on (the oldest held, when it is older than all of them). `at` is
 * when it was asked: each ask is shown once.
 */
export interface Reveal {
  id: string;
  seq: number;
  at: number;
}

/** Rows drawn above a line brought into view: what led up to it. */
const REVEAL_ABOVE = 10;

const stillMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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
 * A line asked for (`reveal`) is drawn, scrolled to the middle and washed in pith a moment;
 * with reduced motion it is only scrolled to.
 */
export function ThreadView({
  items,
  older,
  onLoadOlder,
  reveal = null,
  onRevealed,
  agent,
  meId,
  handlers,
  billing = null,
}: {
  items: ThreadItem[];
  older: OlderItems;
  onLoadOlder: () => void;
  reveal?: Reveal | null;
  /** The line `reveal` asked for at `at` has been shown: it needn't be asked for again. */
  onRevealed?: (at: number) => void;
  agent: AgentActivity;
  meId: string;
  handlers: LineHandlers;
  /**
   * The canvas waits on its workspace's billing (only ever while billing is on): its line at the
   * foot, after a turn that is still finishing.
   */
  billing?: BillingWait | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [state, dispatch] = useReducer(follow, FOLLOWING);
  const following = useRef(state.following);
  following.current = state.following;

  // Only the agent's state decides whether its last turn has ended: not each change of status.
  const agentState = agent.state;
  const rows = useMemo(
    () => threadRows(items, { state: agentState, status: null }),
    [items, agentState],
  );
  const waiting = sandboxLine(agent);
  const now = useNow();
  const working = waiting ? null : workingLine(items, agent, now);

  /*
   * A turn ending takes its asides and the working line away in one frame, which would drop
   * the answer between them by their height, and everything above it with it. They stay for
   * that frame as they were, then close at the pane's pace, fading as they go, so the answer
   * settles into place. The working line leaving on its own (a question came) does the same.
   * Each line that can leave notes where it sits after every frame (`places`); with reduced
   * motion they simply go. A thread drawn already settled (opened later, reloaded) has nothing
   * leaving: only a change seen here starts one.
   */
  const places = useRef(new Map<string, Place>());
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  const [last, setLast] = useState({ rows, working });
  if (last.rows !== rows || last.working !== working) {
    setLast({ rows, working });
    const kept = new Set(rows.map(rowKey));
    const going: Leaving[] = [];
    if (!stillMotion()) {
      let follows: string | null = null;
      for (const row of last.rows) {
        const key = rowKey(row);
        const place = places.current.get(key);
        if (kept.has(key)) follows = key;
        else if (row.aside && place) going.push({ row, label: "", follows, place });
      }
      const line = places.current.get(WORKING);
      if (last.working && !working && line) {
        going.push({ row: null, label: last.working, follows: null, place: line });
      }
    }
    // What came back (the working line again, a turn going on) is no longer leaving.
    const staying = leaving.filter((l) => (l.row ? !kept.has(rowKey(l.row)) : !working));
    if (going.length || staying.length !== leaving.length) setLeaving([...staying, ...going]);
  }
  useLayoutEffect(() => {
    const box = content.current;
    if (!box) return;
    places.current.clear();
    for (const el of box.querySelectorAll<HTMLElement>(
      ":scope > [data-aside], :scope > [data-working-box]:not([data-leaving])",
    )) {
      const key = el.dataset.aside ?? WORKING;
      const own = el.getBoundingClientRect();
      const prev = el.previousElementSibling?.getBoundingClientRect();
      places.current.set(key, {
        room: own.bottom - (prev?.bottom ?? own.top),
        above: prev ? own.top - prev.bottom : 0,
        after: !!prev,
      });
    }
  });
  const gone = useCallback(
    (l: Leaving) => setLeaving((now) => now.filter((other) => other !== l)),
    [],
  );
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
  /**
   * Whether the rail still follows the foot. The person's scroll moves the thread before its event
   * arrives, and a line streaming in between must not pull them back: away from where the rail
   * last put it, and from the foot, they have stopped following, heard or not.
   */
  const stillFollowing = useCallback(() => {
    const el = scroller.current;
    if (!following.current || !el || jumping.current) return following.current;
    const m = metricsOf(el);
    if (Math.abs(m.scrollTop - ours.current) < 2 || atFoot(m)) return true;
    following.current = false;
    dispatch({ type: "scrolled", metrics: m });
    return false;
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
   * where the first line in view sits, and after a change scrolls by however far it moved, less
   * however far the person scrolled since (their scroll's event may not have arrived yet).
   */
  const anchor = useRef<{ el: Element; top: number; scrollTop: number } | null>(null);
  const noteAnchor = useCallback(() => {
    const el = scroller.current;
    const top = el?.getBoundingClientRect().top ?? 0;
    // Never a line on its way out: what stays is what the person goes on reading.
    const line = [...(content.current?.children ?? [])].find(
      (child) => !child.hasAttribute("data-leaving") && child.getBoundingClientRect().bottom > top,
    );
    anchor.current =
      line && el
        ? { el: line, top: line.getBoundingClientRect().top, scrollTop: el.scrollTop }
        : null;
  }, []);
  const holdAnchor = useCallback(() => {
    const el = scroller.current;
    const held = anchor.current;
    if (!el || !held?.el.isConnected) return;
    const moved = held.el.getBoundingClientRect().top - held.top + (el.scrollTop - held.scrollTop);
    if (Math.abs(moved) < 0.5) return;
    el.scrollTop += moved;
    ours.current = el.scrollTop;
  }, []);

  useLayoutEffect(() => {
    if (stillFollowing()) toFoot();
    else holdAnchor();
    noteAnchor();
  });

  // Text streaming in, a picture loading, lines leaving, the rail resizing: still at the foot
  // if following, still on the same line if reading.
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (jumping.current) return;
      if (stillFollowing()) toFoot();
      else holdAnchor();
      noteAnchor();
    });
    if (content.current) observer.observe(content.current);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [stillFollowing, toFoot, holdAnchor, noteAnchor]);

  /*
   * A line asked for: the window opens back to it (with a few rows above it), and once it is
   * drawn the thread scrolls it to the middle and stops following the foot, as reading up does.
   * Declared after the effect above, so in the frame it is drawn this scroll comes last.
   */
  const revealing = useRef<{ at: number; id: string } | null>(null);
  const revealedAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!reveal || revealedAt.current === reveal.at || !rows.length) return;
    revealedAt.current = reveal.at;
    let at = rows.findIndex((row) => row.item.id === reveal.id);
    if (at < 0) at = rows.findIndex((row) => row.item.seq >= reveal.seq);
    if (at < 0) at = rows.length - 1;
    // The line, or the nearest one drawn with a place to scroll to, on either side.
    const near = [...rows.slice(at), ...rows.slice(0, at).reverse()];
    const target = near.find((row) => row.item.kind === "message" || row.item.kind === "assistant");
    // Nothing with a place to scroll to: the thread stays as it is, and the ask is done.
    if (!target) return;
    // The window opens back far enough to draw it: the nearest can sit above the line asked for.
    const from = Math.min(at, rows.indexOf(target));
    if (from < start) setFirstId(rowKey(rows[Math.max(0, from - REVEAL_ABOVE)]!));
    revealing.current = { at: reveal.at, id: target.item.id };
  });
  useLayoutEffect(() => {
    const asked = revealing.current;
    const el = scroller.current;
    if (!asked || !el) return;
    const line = content.current?.querySelector<HTMLElement>(
      `:scope > [data-item="${CSS.escape(asked.id)}"]`,
    );
    if (!line) return;
    revealing.current = null;
    const box = el.getBoundingClientRect();
    const own = line.getBoundingClientRect();
    el.scrollTop += own.top - box.top - (box.height - own.height) / 2;
    ours.current = el.scrollTop;
    following.current = atFoot(metricsOf(el));
    dispatch({ type: "scrolled", metrics: metricsOf(el) });
    noteAnchor();
    // Washed only where the line asked for is the one shown, and never with reduced motion.
    if (asked.id !== reveal?.id || stillMotion()) return;
    delete line.dataset.revealed;
    void line.offsetWidth;
    line.dataset.revealed = "";
    const done = (e: AnimationEvent) => {
      if (e.target !== line || e.animationName !== "reveal-wash-out") return;
      delete line.dataset.revealed;
      line.removeEventListener("animationend", done);
    };
    line.addEventListener("animationend", done);
  });
  useEffect(() => {
    if (reveal && revealedAt.current === reveal.at && !revealing.current) onRevealed?.(reveal.at);
  });

  // Back at the foot with a long window drawn: let the oldest go again.
  // (The ref too: a line just brought into view has stopped following before the state says so.)
  useEffect(() => {
    if (state.following && following.current && rows.length - start > WINDOW * 2) {
      setFirstId(null);
    }
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

  // Where each line on its way out is drawn: after the row it followed, if that is drawn.
  const asides = useMemo(() => {
    const first: Leaving[] = [];
    const after = new Map<string, Leaving[]>();
    for (const l of leaving) {
      if (!l.row) continue;
      if (l.follows === null) {
        if (start === 0) first.push(l);
      } else after.set(l.follows, [...(after.get(l.follows) ?? []), l]);
    }
    return { first, after };
  }, [leaving, start]);
  const line = leaving.find((l) => !l.row);
  // An aside on its way out, as it was, without the pull toward the one above (its room has it).
  const ghost = (l: Leaving) => (
    <LeavingLine key={`leaving:${rowKey(l.row!)}`} leaving={l} onGone={gone}>
      <ThreadLine {...l.row!} asideContinues={false} meId={meId} handlers={handlers} />
    </LeavingLine>
  );

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
          {asides.first.map(ghost)}
          {shown.flatMap((row) => [
            <ThreadLine key={row.item.id} {...row} meId={meId} handlers={handlers} />,
            ...(asides.after.get(row.item.id)?.map(ghost) ?? []),
          ])}
          {/* One box for the working line, live or leaving, so the slice turns on through. */}
          {working || line ? (
            <LeavingLine key="working" leaving={working ? null : line!} onGone={gone}>
              <WorkingLine label={working ?? line!.label} leaving={!working} />
            </LeavingLine>
          ) : null}
          {waiting ? <SandboxLine {...waiting} /> : null}
          {billing ? <BillingLine {...billing} /> : null}
        </div>
      </div>
      {!state.following && state.unseen > 0 ? (
        <button
          type="button"
          onClick={jump}
          aria-label={`Jump to ${state.unseen} new in the thread`}
          className="rise absolute bottom-2.5 left-1/2 flex h-7 -translate-x-1/2 cursor-default items-center gap-1 rounded-pill bg-surface pr-2.5 pl-2 font-medium text-12 text-muted shadow-bar outline-none transition-colors duration-(--dur-hover) focus-ring hover:text-ink active:bg-selected"
        >
          <Icon icon={ArrowDown01Icon} step="small" />
          {state.unseen} new
        </button>
      ) : null}
    </div>
  );
}

/**
 * A line leaving the thread: drawn where it was, in exactly the room it held (the space above
 * it included, the thread's own gap taken back), and that room closing at the pane's pace while
 * the line fades (`leave`). Gone once it has closed, or a moment after it should have, if its
 * animation never ran (a hidden window). With `leaving` null it is the working line's box while
 * the line is live: a plain box, which the line leaves in without being drawn again.
 */
function LeavingLine({
  leaving,
  onGone,
  children,
}: {
  leaving: Leaving | null;
  onGone: (l: Leaving) => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!leaving) return;
    const seconds = box.current
      ? Number.parseFloat(getComputedStyle(box.current).animationDuration) || 0
      : 0;
    const timer = setTimeout(() => onGone(leaving), seconds * 1000 + 500);
    return () => clearTimeout(timer);
  }, [leaving, onGone]);
  // The space above it goes inside the box that closes, never on it as padding: padding can't
  // close, so the box would stop short at its height and the line under it jump when it went.
  // The same two boxes live or leaving, so the line in them is never drawn again.
  if (!leaving) {
    return (
      <div ref={box} data-working-box className="shrink-0">
        <div>{children}</div>
      </div>
    );
  }
  const { room, above, after } = leaving.place;
  return (
    <div
      ref={box}
      aria-hidden
      inert
      data-leaving
      className="leave shrink-0"
      style={{ "--room": `${room}px`, marginTop: after ? -LINE_GAP : 0 } as CSSProperties}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) onGone(leaving);
      }}
    >
      <div style={{ paddingTop: above }}>{children}</div>
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
