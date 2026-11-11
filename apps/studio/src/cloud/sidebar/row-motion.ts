import { type RefObject, useLayoutEffect, useRef } from "react";

/*
 * Rows that move, move: when the sidebar's lists change (a design settles or is reopened, the
 * order shifts, the settled section opens), each row and the settled header slides from where
 * it was to where it is, and a row that wasn't there fades in. First, last, invert, play, with
 * the browser's own animations and the panes' clock.
 *
 * Our own few lines rather than a motion library: the rows are memoized buttons inside Radix
 * triggers in two lists, and all this needs is where each was before the lists changed.
 */

/** What takes part: a design's row, or anything marked `data-moves="<key>"`. */
const MOVES = "[data-design-row], [data-moves]";

const keyOf = (el: HTMLElement) => el.dataset.designRow ?? el.dataset.moves ?? "";

/** Where something was at a commit: its box, and how far its scrolling list had scrolled. */
interface Place {
  rect: DOMRect;
  scroller: HTMLElement | null;
  scrolled: number;
}

/** The list that scrolls `el`, if one does. */
function scrollerOf(el: HTMLElement, root: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at && at !== root; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll") return at;
  }
  return null;
}

/**
 * Animates what moved inside `root` whenever `signature` changes: pass something that names
 * which rows are showing and in what order. A change that isn't a change of rows (a status, a
 * preview) leaves everything still.
 */
export function useRowMotion(root: RefObject<HTMLElement | null>, signature: string): void {
  const before = useRef<Map<string, Place> | null>(null);
  const last = useRef(signature);

  // Every commit: where everything is now, to be "before" at the next change. Rows mid-flight
  // are measured where they are heading, not where the animation has them.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const now = new Map<string, Place>();
    const nodes = [...el.querySelectorAll<HTMLElement>(MOVES)];
    for (const node of nodes) {
      for (const animation of node.getAnimations()) {
        if (animation.id === "row-motion") animation.finish();
      }
      const scroller = scrollerOf(node, el);
      now.set(keyOf(node), {
        rect: node.getBoundingClientRect(),
        scroller,
        scrolled: scroller?.scrollTop ?? 0,
      });
    }
    const was = before.current;
    const changed = last.current !== signature;
    before.current = now;
    last.current = signature;
    if (!was || !changed || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const style = getComputedStyle(el);
    const duration = Number.parseFloat(style.getPropertyValue("--dur-pane")) || 220;
    const easing = style.getPropertyValue("--ease-out").trim() || "ease-out";
    for (const node of nodes) {
      const to = now.get(keyOf(node));
      const from = was.get(keyOf(node));
      if (!to) continue;
      if (!from) {
        node.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing, id: "row-motion" });
        continue;
      }
      // Scrolling makes no commit, so the old box is where the row was when it was measured:
      // take off however far its list has scrolled since, to get where it was just now.
      const since = from.scroller?.isConnected ? from.scroller.scrollTop - from.scrolled : 0;
      const dx = from.rect.left - to.rect.left;
      const dy = from.rect.top - since - to.rect.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration,
        easing,
        id: "row-motion",
      });
    }
  });
}
