import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { cn } from "../ui/cn.ts";

/*
 * Room in the chrome for something that can come after the first paint: the pull request mark,
 * the next action, a person, the design's name, the pages. What is there at the first paint is
 * simply there. What comes later comes as one movement on the panes' clock (--dur-pane,
 * --ease-out): its room opens, so its neighbours glide aside rather than jump, and it fades in,
 * rising a hair, in place at the room's still edge, a fifth of the way into the opening. Leaving
 * is the same gesture the other way: it fades and sinks, and its room closes. A change of width
 * while shown eases the room from the old width to the new; where what it shows is another thing
 * (`swap`: Merge becoming Update branch), the new one fades in as the room eases, as on arriving.
 * `placeholder` holds the room, quiet and unseen, for something expected but not yet known, so
 * that when it comes nothing moves unless its width differs, and the room closes if it doesn't.
 *
 * Written on the Web Animations API rather than a CSS transition: the room's width at rest is
 * `auto`, which a transition can't ease from or to, and only here is the width before and after
 * known. The animations are named (`arrival-room`, `arrival-content`, and `-out` leaving), so a
 * test can find and step them. Under reduced motion nothing eases or travels: the end state is
 * there at once.
 */

/** How far the content rises as it comes, in px. */
export const ARRIVAL_RISE = 2;
/** How far into the room's opening the content starts to show. */
export const ARRIVAL_CONTENT_DELAY = 0.2;

/** The panes' clock, read from the tokens. */
function paneClock(el: Element) {
  const css = getComputedStyle(el);
  const value = css.getPropertyValue("--dur-pane").trim();
  const n = Number.parseFloat(value);
  const duration = !Number.isFinite(n) ? 220 : value.endsWith("ms") ? n : n * 1000;
  return {
    duration,
    easing: css.getPropertyValue("--ease-out").trim() || "cubic-bezier(0.2, 0.8, 0.2, 1)",
  };
}

const stilled = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

type Phase = "shown" | "leaving" | "held" | "none";

/**
 * Whether the arrival something is made inside has shown: an Arrival made inside one already
 * shown (a person joining the people) arrives on its own; one made with it (the people arriving
 * together) is part of its movement, and one made with the chrome is simply there. A design
 * opened anew is a new chrome: what it has at once shows at once, never as an entrance.
 */
const Scope = createContext<{ painted: boolean }>({ painted: false });

export function Arrival({
  show,
  children,
  placeholder = null,
  anchor = "end",
  room = true,
  clip = true,
  className,
  name,
  swap,
}: {
  /** Whether it is there. Once false, what it showed stays while it leaves. */
  show: boolean;
  children: ReactNode;
  /** Drawn unseen in its place while it isn't shown, holding the room it is expected to take. */
  placeholder?: ReactNode;
  /** The room's edge that stays still: `end` in the right-hand cluster, `start` on the left. */
  anchor?: "start" | "end";
  /** False: it only fades, where nothing beside it would move (the page tabs). */
  room?: boolean;
  /** False: drawn whole while its room opens (an avatar, which overlaps the one before it). */
  clip?: boolean;
  className?: string;
  /** `data-arrival` on the room, for tests. */
  name?: string;
  /**
   * What it shows, by name (the action's kind). When this changes while it is shown (Ready
   * becoming Create PR), the new one arrives in place of the old: it fades in, rising, as the
   * room eases to its width, so no word is seen cut by a room still on its way.
   */
  swap?: string;
}) {
  const scope = useContext(Scope);
  const [within] = useState(() => ({ painted: false }));
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  // What it last showed, kept while it leaves.
  const kept = useRef<ReactNode>(null);
  const [leaving, setLeaving] = useState(false);
  if (show) {
    kept.current = children;
    if (leaving) setLeaving(false);
  } else if (kept.current !== null && !leaving) {
    setLeaving(true);
  }
  const phase: Phase = show
    ? "shown"
    : leaving && kept.current !== null
      ? "leaving"
      : placeholder != null
        ? "held"
        : "none";
  const content =
    phase === "shown"
      ? children
      : phase === "leaving"
        ? kept.current
        : phase === "held"
          ? placeholder
          : null;

  const last = useRef<{ width: number; phase: Phase; swap?: string | undefined } | null>(null);
  const roomMove = useRef<Animation | null>(null);
  const contentMove = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const room$ = outer.current;
    const content$ = inner.current;
    if (!room$ || !content$) return;
    // An arrival inside this one opening its own room (someone joining the people) is already
    // the movement: this room follows it, so it is measured as it will rest, and doesn't ease
    // itself as well (which, started from where it was, would clip what is opening inside it).
    const nested = content$
      .getAnimations({ subtree: true })
      .filter(
        (a) =>
          a.id.startsWith("arrival-room") &&
          (a.effect as KeyframeEffect | null)?.target !== room$ &&
          a.playState !== "finished",
      );
    const natural =
      content == null
        ? 0
        : content$.getBoundingClientRect().width +
          nested.reduce((sum, a) => {
            const target = (a.effect as KeyframeEffect).target as Element;
            const end = Number.parseFloat(
              String((a.effect as KeyframeEffect).getKeyframes().at(-1)?.width ?? "0"),
            );
            return sum + end - target.getBoundingClientRect().width;
          }, 0);
    // What comes inside it with it is part of its arrival; what comes after it is shown arrives
    // on its own (its pieces' layout runs before this, so they read the scope as it was).
    within.painted = phase === "shown";
    // Made after the chrome's first paint (someone joining): it arrives from nothing.
    const was = last.current ?? (scope.painted ? { width: 0, phase: "none" as Phase } : null);
    last.current = { width: natural, phase, swap };
    // The chrome's first paint: whatever is there is simply there.
    if (!was) return;
    const entering =
      phase === "shown" && (was.phase !== "shown" || (swap !== undefined && swap !== was.swap));
    const startsLeaving = phase === "leaving" && was.phase !== "leaving";
    const resized =
      (phase === "shown" || phase === "held") &&
      was.phase === phase &&
      nested.length === 0 &&
      Math.abs(natural - was.width) > 0.5;
    const unheld = phase === "none" && was.phase === "held";
    // Expected only after the first paint (the row arriving at launch): the held room opens from
    // nothing with whatever arrives beside it, rather than pushing its neighbours in one frame.
    const heldOpens = phase === "held" && (was.phase === "none" || was.phase === "leaving");
    if (!entering && !startsLeaving && !resized && !unheld && !heldOpens) return;

    // Gone: what it showed goes in the same frame as the room's last, so nothing flashes back.
    const gone = () => {
      kept.current = null;
      flushSync(() => setLeaving(false));
    };
    if (stilled()) {
      roomMove.current?.cancel();
      contentMove.current?.cancel();
      if (startsLeaving) {
        kept.current = null;
        setLeaving(false);
      }
      return;
    }
    const { duration, easing } = paneClock(room$);
    // From where the room is now: mid-movement, where the movement has it (so nothing starts
    // over); at rest, the width it had before this change.
    const moving =
      roomMove.current?.playState === "running" || roomMove.current?.playState === "paused";
    const now = moving ? room$.getBoundingClientRect().width : was.width;
    const from = ((entering && was.phase === "none") || heldOpens) && !moving ? 0 : now;
    const to = startsLeaving || unheld ? 0 : natural;
    const closing = startsLeaving || unheld;

    const opens = room && Math.abs(from - to) > 0.5;
    if (opens) {
      roomMove.current?.cancel();
      // Clipped while it opens from nothing or closes to it, so nothing spills over what is
      // beside it. Not when something arrives into a room already partly there (another action
      // than held, or in place of the one shown): hidden until a fifth in, by when the room is
      // within its gap of whole, it would only be seen cut.
      const into = entering && from > 0;
      room$.style.overflow = clip && !into ? "clip" : "";
      const move = room$.animate([{ width: `${from}px` }, { width: `${to}px` }], {
        duration,
        easing,
        fill: closing ? "forwards" : "none",
        id: closing ? "arrival-room-out" : "arrival-room",
      });
      roomMove.current = move;
      move.finished.then(
        () => {
          if (roomMove.current !== move) return;
          roomMove.current = null;
          room$.style.overflow = "";
          if (startsLeaving) gone();
          if (closing) move.cancel();
        },
        () => {
          if (roomMove.current === move) room$.style.overflow = "";
        },
      );
    } else {
      roomMove.current?.cancel();
      roomMove.current = null;
      room$.style.overflow = "";
    }

    if (entering) {
      contentMove.current?.cancel();
      contentMove.current = content$.animate(
        [
          { opacity: 0, transform: `translateY(${ARRIVAL_RISE}px)` },
          { opacity: 1, transform: "none" },
        ],
        {
          duration,
          // A fifth of the way into its room's opening; into room already held, at once.
          delay: opens ? duration * ARRIVAL_CONTENT_DELAY : 0,
          easing,
          fill: "backwards",
          id: "arrival-content",
        },
      );
    } else if (startsLeaving) {
      contentMove.current?.cancel();
      const fade = content$.animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: `translateY(${ARRIVAL_RISE}px)` },
        ],
        {
          duration: duration * (1 - ARRIVAL_CONTENT_DELAY),
          easing,
          fill: "forwards",
          id: "arrival-content-out",
        },
      );
      contentMove.current = fade;
      if (!opens) fade.finished.then(gone, () => {});
    }
  });

  return (
    <span
      ref={outer}
      data-arrival={name}
      className={cn(
        // Without a room of its own it gives way as its content does (the page tabs scroll).
        room ? "flex shrink-0 items-center" : "flex min-w-0 items-center",
        anchor === "end" ? "justify-end" : "justify-start",
        className,
      )}
    >
      <span
        ref={inner}
        aria-hidden={phase === "held" || phase === "leaving" || undefined}
        inert={phase === "held" || phase === "leaving" || undefined}
        className={cn(
          room ? "flex shrink-0 items-center" : "flex min-w-0 items-center",
          phase === "held" && "invisible",
        )}
      >
        <Scope.Provider value={within}>{content}</Scope.Provider>
      </span>
    </span>
  );
}
