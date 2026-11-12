import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  type Layout,
  type PanelImperativeHandle,
  useGroupRef,
  usePanelRef,
} from "react-resizable-panels";
import { enterThread } from "../thread/rail.tsx";
import { cn } from "../ui/cn.ts";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui/resizable.tsx";
import { TipProvider } from "../ui/tooltip.tsx";
import {
  type DividerGrip,
  DividerGrips,
  type Lights,
  SidebarToggle,
  TrafficLights,
} from "./chrome.tsx";
import {
  fitPanes,
  MAIN_MIN,
  PANE_STEP,
  PANE_STEP_LARGE,
  PANES,
  type Pane,
  paneWidth,
} from "./panes.ts";

/** The smallest window the layout holds at: sidebar 300, rail 360 and a usable canvas. */
export const MIN_WINDOW = { width: 1100, height: 640 } as const;

export interface SidebarSlot {
  open: boolean;
  onToggle: () => void;
  content: ReactNode;
}

/** How wide the side panes open (as the person last left them), and where to keep a new width. */
export interface PaneWidths {
  sidebar: number;
  rail: number;
  onResize?: (pane: Pane, width: number) => void;
}

const BOTH: readonly Pane[] = ["sidebar", "rail"];
/** The panels' ids in the group (and on their elements); the panes' own ids stay theirs. */
const PANEL: Record<Pane, string> = { sidebar: "sidebar-pane", rail: "thread-pane" };
const MAIN_PANEL = "main-pane";
/** The custom property each pane's width is kept in on the window, for the chrome and its content. */
const WIDTH_VAR: Record<Pane, `--pane-${string}`> = {
  sidebar: "--pane-sidebar",
  rail: "--pane-rail",
};
/** What a screen reader calls each pane when it reads out its edge's width. */
const NAME: Record<Pane, string> = { sidebar: "Sidebar", rail: "Thread" };
/**
 * The gutter between a pane and the canvas, which is the edge's grab area: the sidebar's right
 * padding (8) and the rail's left (10), as the design pads them. A pane's width, as the design
 * gives it and as it's kept, takes in its gutter: its panel is that much narrower.
 */
const GUTTER: Record<Pane, number> = { sidebar: 8, rail: 10 };

/**
 * A panel's size limits, for a pane's (panes.ts). Collapsing is the toggles' (and ⌘B, ⌥⌘B): an
 * open pane's panel can't collapse, so a drag, even one that leaves the window, stops it at its
 * minimum (the library collapses any collapsible panel dragged to nothing). The window says
 * when it may.
 */
function panelLimits(pane: Pane, collapsible: boolean) {
  const { default: width, min, max } = PANES[pane];
  const gutter = GUTTER[pane];
  return {
    defaultSize: width - gutter,
    minSize: min - gutter,
    maxSize: max - gutter,
    collapsible,
    collapsedSize: 0,
  };
}

/**
 * The main window: a 38px chrome over three panes. The sidebar and the thread rail open at the
 * widths the person last dragged them to (the design's 300 and 360 at first; panes.ts has the
 * limits); the pane between them, the canvas's, takes the rest.
 *
 * - `sidebar` null is a brand-new personal workspace: no sidebar and no toggle.
 * - `chrome` is everything past the left block (CanvasChrome); nothing on the create page.
 * - `rail` is the thread rail's content, or null while it is closed.
 * - `children` fill the main pane.
 * - `badge` sits just past the sidebar toggle (or the traffic lights): the shell's update mark,
 *   when there is one.
 * - `panes`: the widths to open the panes at, and where a new one goes when an edge is moved.
 *
 * The chrome draws no lockup, in any state (the founder asked for it gone; the boards still
 * draw one). The sidebar toggle comes first at the left, just past the traffic lights, and
 * CanvasChrome ends with the thread toggle at the window's right edge.
 *
 * The panes are react-resizable-panels' (shadcn's Resizable, ui/resizable.tsx), in pixels. Each
 * edge between a pane and the canvas is a separator: the gutter there is its grab area, it
 * follows the pointer, takes focus in tab order and moves with the arrow keys, and a double-click
 * returns the pane to the design's width. Moving one edge never moves the other pane: it stops
 * where the canvas would go under 400. The toggles collapse and expand the panes through the
 * same panels, easing (`data-pane-motion`); a drag never eases. Whenever the window lays the
 * panes out itself (when it opens, on a toggle, when it's resized) each open pane takes the
 * width it was left at, or, in a window too small for both, a fair share less (panes.ts,
 * fitPanes). The chrome's blocks over the panes read the widths from `--pane-sidebar` and
 * `--pane-rail` on the window, which a drag writes in the same frame as the panels move.
 */
/**
 * The keyboard and the thread pane. Once the pane has opened (its toggle's easing has ended, or
 * at once with reduced motion: it is `inert` until it is open), the keyboard goes into it
 * (`enterThread`), when it opened on a design that was already showing: the toggle, ⌥⌘B, the
 * View menu, or anything else that opens it while the design shows. Not when it came with a
 * design being opened, which leaves the keyboard where the person was (a row of the sidebar).
 * Closing it with the keyboard inside gives the keyboard back to where it was before, or to the
 * window, so it never sits in a pane that has gone inert.
 */
function useThreadFocus(
  open: boolean,
  canvasShowing: boolean,
  box: RefObject<HTMLElement | null>,
  motion: PaneMotion,
) {
  const was = useRef({ open, canvasShowing });
  const before = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const prev = was.current;
    was.current = { open, canvasShowing };
    const pane = box.current;
    if (!pane || prev.open === open) return;
    if (!open) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && pane.contains(active)) {
        const back = before.current;
        if (back?.isConnected && !pane.contains(back)) back.focus({ preventScroll: true });
        else active.blur();
      }
      before.current = null;
      return;
    }
    if (!prev.canvasShowing || !canvasShowing) return;
    let live = true;
    // After the toggle's own layout effect has started the easing (a microtask on).
    queueMicrotask(() =>
      motion.after(() => {
        if (!live || !was.current.open) return;
        const active = document.activeElement;
        before.current = active instanceof HTMLElement && active !== document.body ? active : null;
        enterThread(pane);
      }),
    );
    return () => {
      live = false;
    };
  }, [open, canvasShowing, box, motion]);
}

export function AppWindow({
  lights,
  sidebar,
  chrome,
  rail,
  badge,
  panes,
  children,
}: {
  lights: Lights;
  sidebar: SidebarSlot | null;
  chrome?: ReactNode;
  rail: ReactNode | null;
  badge?: ReactNode;
  panes?: PaneWidths;
  children: ReactNode;
}) {
  const hasSidebar = sidebar !== null;
  const sidebarOpen = sidebar?.open ?? false;
  const railOpen = rail !== null;
  const remembered: Record<Pane, number> = {
    sidebar: paneWidth("sidebar", panes?.sidebar),
    rail: paneWidth("rail", panes?.rail),
  };
  // The latest of these, for the window's own layouts (they run outside a render).
  const now = useRef({ remembered, hasSidebar, open: { sidebar: sidebarOpen, rail: railOpen } });
  now.current = { remembered, hasSidebar, open: { sidebar: sidebarOpen, rail: railOpen } };
  const frame = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const groupRef = useGroupRef();
  const panels: Record<Pane, RefObject<PanelImperativeHandle | null>> = {
    sidebar: usePanelRef(),
    rail: usePanelRef(),
  };
  // Each pane's width as it stands while open: the remembered one, or less in a small window.
  const [shown, setShown] = useState(remembered);
  const motion = usePaneMotion(frame);
  const railBox = useRef<HTMLElement>(null);
  useThreadFocus(railOpen, chrome != null, railBox, motion);
  // The edge the person last took hold of (pointer or keys): only its pane's width is kept.
  const held = useRef<Pane | null>(null);
  // While one edge is dragged, the other pane, held where it is (its panel disabled): the drag
  // stops where the canvas reaches its minimum, rather than pushing on into the other pane.
  const [still, setStill] = useState<Pane | null>(null);
  const onResize = useRef(panes?.onResize);
  onResize.current = panes?.onResize;
  // The group's width, as last laid out (a ResizeObserver keeps it): read on every move of an
  // edge, so never measured then.
  const groupWidth = useRef(0);

  // The rail's content stays while it closes, as it last was, so it slides away rather than
  // emptying first. Only while there's a chrome: what leaves with the whole view (the design it
  // showed) goes at once.
  const holdRail = chrome != null;
  const lastRail = useRef(rail);
  useEffect(() => {
    if (rail !== null) lastRail.current = rail;
  });
  const [closingRail, setClosingRail] = useState<ReactNode>(null);
  const [wasOpen, setWasOpen] = useState(railOpen);
  if (railOpen !== wasOpen) {
    setWasOpen(railOpen);
    setClosingRail(railOpen || !holdRail ? null : lastRail.current);
  }
  useEffect(() => {
    if (closingRail === null) return;
    let live = true;
    const timer = setTimeout(
      () =>
        motion.after(() => {
          if (live) setClosingRail(null);
        }),
      motion.ms(),
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [closingRail, motion]);

  /** The width the panels share: the group's, less its edges'. */
  const axis = useCallback(() => {
    if (groupWidth.current <= 0 && group.current) groupWidth.current = group.current.clientWidth;
    return groupWidth.current - GUTTER.rail - (now.current.hasSidebar ? GUTTER.sidebar : 0);
  }, []);
  const present = useCallback(
    (): Pane[] => (now.current.hasSidebar ? ["sidebar", "rail"] : ["rail"]),
    [],
  );

  /**
   * The layout with `opened` panes open: each at its remembered width, or a fair share less
   * where the window hasn't room for them both beside the canvas's minimum.
   */
  const layoutFor = useCallback(
    (opened: Record<Pane, boolean>): Layout | null => {
      // Measured afresh: the window lays the panes out itself only now and then, never per move.
      if (group.current) groupWidth.current = group.current.clientWidth;
      const size = axis();
      if (size <= 0) return null;
      const wanted: Partial<Record<Pane, number>> = {};
      let room = size - MAIN_MIN;
      for (const pane of present()) {
        if (!opened[pane]) continue;
        wanted[pane] = now.current.remembered[pane];
        room += GUTTER[pane];
      }
      const widths = fitPanes(room, wanted);
      const layout: Layout = {};
      let rest = 100;
      for (const pane of present()) {
        const width = widths[pane];
        const share = width === undefined ? 0 : ((width - GUTTER[pane]) / size) * 100;
        layout[PANEL[pane]] = share;
        rest -= share;
      }
      layout[MAIN_PANEL] = rest;
      return layout;
    },
    [axis, present],
  );
  const settle = useRef(0);
  const place = useCallback(
    (opened: Record<Pane, boolean>) => {
      const layout = layoutFor(opened);
      if (layout) groupRef.current?.setLayout(layout);
      // Once more a frame on, unless a drag has begun: the group may lay itself out again as a
      // pane's panel first registers, or only then take its final width.
      cancelAnimationFrame(settle.current);
      settle.current = requestAnimationFrame(() => {
        if (frame.current?.hasAttribute("data-pane-drag")) return;
        const again = layoutFor(now.current.open);
        if (again) groupRef.current?.setLayout(again);
      });
    },
    [layoutFor, groupRef],
  );
  useEffect(() => () => cancelAnimationFrame(settle.current), []);

  // The window resized: the panes back toward the widths they were left at, as far as the
  // canvas's room allows (not during a drag, or while a toggle eases).
  useLayoutEffect(() => {
    const el = group.current;
    if (!el) return;
    groupWidth.current = el.clientWidth;
    let live = true;
    const observer = new ResizeObserver(([entry]) => {
      groupWidth.current = entry?.borderBoxSize?.[0]?.inlineSize ?? el.clientWidth;
      if (frame.current?.hasAttribute("data-pane-drag")) return;
      // While a toggle eases, once it has.
      motion.after(() => {
        if (live) place(now.current.open);
      });
    });
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [place, motion]);

  // Opens and closes the panes as their toggles say: at once when the window first draws them,
  // easing after that. A panel may collapse only while its pane is closing or closed, so that
  // nothing but a toggle collapses it.
  const [collapsible, setCollapsible] = useState<Record<Pane, boolean>>({
    sidebar: true,
    rail: true,
  });
  const collapsibleNow = useRef(collapsible);
  collapsibleNow.current = collapsible;
  const was = useRef<Record<Pane, boolean | null>>({ sidebar: null, rail: null });
  // A toggle's easing marks the window before this render reaches the page, not after: the
  // panels lay themselves out (and so restyle the page) in their own layout effects, ahead of
  // the one below, and a class that changed then would land with no easing.
  if (
    (was.current.sidebar !== null && hasSidebar && was.current.sidebar !== sidebarOpen) ||
    (was.current.rail !== null && was.current.rail !== railOpen)
  ) {
    frame.current?.setAttribute("data-pane-motion", "");
  }
  useLayoutEffect(() => {
    const before = was.current;
    const state: Record<Pane, boolean | null> = {
      sidebar: hasSidebar ? sidebarOpen : null,
      rail: railOpen,
    };
    was.current = state;
    const changed = BOTH.filter((pane) => state[pane] !== null && state[pane] !== before[pane]);
    if (changed.length === 0) return;
    if (changed.some((pane) => before[pane] !== null)) motion.start();
    const opened = { sidebar: sidebarOpen, rail: railOpen };
    const opening = changed.filter((pane) => opened[pane]);
    const closing = changed.filter((pane) => !opened[pane]);
    setCollapsible((c) => {
      const next = { ...c };
      for (const pane of opening) next[pane] = false;
      for (const pane of closing) next[pane] = true;
      return next;
    });
    if (closing.every((pane) => collapsibleNow.current[pane])) {
      place(opened);
    } else {
      // The group learns the panel may collapse in the renders this sets off, which React
      // finishes before the microtask, still ahead of the frame: so it moves in the same frame
      // as the chrome.
      queueMicrotask(() => {
        const latest = was.current;
        if (latest.sidebar === state.sidebar && latest.rail === state.rail) place(opened);
      });
    }
  }, [hasSidebar, sidebarOpen, railOpen, motion, place]);

  const widthsOf = useCallback(
    (layout: Layout) => {
      const size = axis();
      const widths: Partial<Record<Pane, number>> = {};
      for (const pane of BOTH) {
        const share = layout[PANEL[pane]];
        // Collapsed (or closing): the pane keeps the width it opens at.
        if (share !== undefined && size > 0 && share > 0) {
          widths[pane] = (share / 100) * size + GUTTER[pane];
        }
      }
      return widths;
    },
    [axis],
  );
  /** A pane's width as its panel stands now (the library's layout, ahead of the page's). */
  const widthNow = (pane: Pane) => {
    const panel = panels[pane].current;
    return panel ? panel.getSize().inPixels + GUTTER[pane] : 0;
  };

  // Every move of an edge, in the same frame as the panels: the chrome's blocks and the panes'
  // content read these.
  const onLayoutChange = useCallback(
    (layout: Layout) => {
      const el = frame.current;
      if (!el) return;
      for (const [pane, width] of Object.entries(widthsOf(layout)) as [Pane, number][]) {
        el.style.setProperty(WIDTH_VAR[pane], `${width}px`);
      }
    },
    [widthsOf],
  );
  const onLayoutChanged = useCallback(
    (layout: Layout, meta: { isUserInteraction: boolean }) => {
      const widths = widthsOf(layout);
      setShown((was) => ({ ...was, ...widths }));
      const pane = held.current;
      const width = pane && widths[pane];
      if (meta.isUserInteraction && pane && width) onResize.current?.(pane, Math.round(width));
    },
    [widthsOf],
  );

  /**
   * Puts `pane`'s edge at `width`, within its limits and short of the canvas's minimum (the other
   * pane stays as it is), and keeps what it came to (`keep`: not for each step of a drag).
   */
  const moveEdge = (pane: Pane, width: number, keep = true) => {
    const panel = panels[pane].current;
    if (!panel) return;
    const other: Pane = pane === "sidebar" ? "rail" : "sidebar";
    const otherPanel = present().includes(other)
      ? (panels[other].current?.getSize().inPixels ?? 0)
      : 0;
    const room = axis() - MAIN_MIN - otherPanel;
    const size = Math.max(
      PANES[pane].min - GUTTER[pane],
      Math.min(paneWidth(pane, width) - GUTTER[pane], room),
    );
    panel.resize(`${size}px`);
    // What the canvas's room let it have (the panel's own size reads the old one until its
    // layout lands).
    if (keep) onResize.current?.(pane, Math.round(size + GUTTER[pane]));
    return size + GUTTER[pane];
  };

  /**
   * The chrome's divider over an open pane's edge, as a handle for it (chrome.tsx): the pane
   * follows the pointer from where the press began, within the edge's own limits, and what it
   * came to is kept on release. Nothing takes focus, and the chrome doesn't drag the window.
   */
  const dividerGrip = (pane?: Pane): DividerGrip | null => {
    if (!pane || !(pane === "sidebar" ? sidebarOpen : railOpen)) return null;
    return {
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        held.current = pane;
        motion.stop();
        const grip = event.currentTarget;
        const from = widthNow(pane);
        const pressed = event.clientX;
        let came = from;
        const move = (moved: globalThis.PointerEvent) => {
          const by = moved.clientX - pressed;
          came = moveEdge(pane, from + (pane === "sidebar" ? by : -by), false) ?? came;
        };
        grip.setPointerCapture(event.pointerId);
        grip.addEventListener("pointermove", move);
        grip.setAttribute("data-held", "");
        dragging(frame.current, () => {
          grip.removeEventListener("pointermove", move);
          grip.removeAttribute("data-held");
          if (came !== from) onResize.current?.(pane, Math.round(came));
        });
      },
      onDoubleClick: () => {
        held.current = pane;
        moveEdge(pane, PANES[pane].default);
      },
    };
  };

  // Where focus was before a press on an edge took it (the library focuses the separator), to
  // give it back on release: resizing the thread mid-message leaves the cursor in the composer.
  const focusedFrom = useRef<{ el: Element | null; at: number }>({ el: null, at: -1 });

  const edge = (pane: Pane, label: string, open: boolean, className: string) => (
    <ResizableHandle
      id={`${PANEL[pane]}-edge`}
      aria-label={label}
      aria-valuetext={`${NAME[pane]}, ${Math.round(shown[pane])} pixels`}
      disabled={!open}
      disableDoubleClick
      line={pane === "sidebar" ? "end" : "start"}
      className={cn("app-no-drag mb-1.5", className)}
      // Capture: the library keeps the separator's own onFocus.
      onFocusCapture={(event: FocusEvent) => {
        focusedFrom.current = { el: event.relatedTarget, at: event.timeStamp };
      }}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (!open || event.button !== 0) return;
        held.current = pane;
        motion.stop();
        setStill(pane === "sidebar" ? "rail" : "sidebar");
        const separator = event.currentTarget;
        // Only focus this press moved here (the library focuses the separator as the press
        // begins): an edge already focused from the keyboard keeps it.
        const from = focusedFrom.current;
        const moved = Math.abs(event.timeStamp - from.at) < 100;
        dragging(frame.current, () => {
          setStill(null);
          if (!moved || document.activeElement !== separator) return;
          if (from.el instanceof HTMLElement && from.el.isConnected) {
            from.el.focus({ preventScroll: true });
          } else {
            separator.blur();
          }
        });
      }}
      onDoubleClick={() => {
        if (!open) return;
        held.current = pane;
        moveEdge(pane, PANES[pane].default);
      }}
      onKeyDownCapture={(event: KeyboardEvent) => {
        if (!open) return;
        held.current = pane;
        // Enter would collapse the pane behind its toggle's back: the toggles do that.
        if (event.key === "Enter") event.preventDefault();
        // Home and End: the pane at its narrowest and its widest, whichever side it is on (the
        // library's would move the edge to the window's ends, the other way round for the rail).
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          moveEdge(pane, event.key === "Home" ? PANES[pane].min : PANES[pane].max);
          return;
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        // The library's step is 5% of the window, some 70px: too coarse for a pane. The edge
        // moves the way the arrow points, a little at a time.
        event.preventDefault();
        const towards = event.key === "ArrowRight" ? 1 : -1;
        const step = (event.shiftKey ? PANE_STEP_LARGE : PANE_STEP) * towards;
        moveEdge(pane, widthNow(pane) + (pane === "sidebar" ? step : -step));
      }}
    />
  );

  return (
    <TipProvider>
      <div
        ref={frame}
        // The shell: the solid colour, or clear over the Mac's glass (tokens.css, --c-shell).
        className="flex h-full flex-col bg-shell text-ink"
        style={
          {
            minWidth: MIN_WINDOW.width,
            minHeight: MIN_WINDOW.height,
            [WIDTH_VAR.sidebar]: `${shown.sidebar}px`,
            [WIDTH_VAR.rail]: `${shown.rail}px`,
          } as CSSProperties
        }
      >
        <header
          // A click on its buttons and tabs leaves focus where it was (installFocusRule).
          data-toolbar
          className={cn(
            // 38 tall: its 28px controls with 5 above and below (CHROME in the shell's traffic-lights.ts).
            "app-drag flex h-[38px] shrink-0 items-center gap-1",
            // 10 at either edge; on a Mac the traffic lights' own 16 on the left.
            lights === "none" ? "px-2.5" : "pr-2.5 pl-4",
          )}
        >
          <div
            className={cn(
              "pane-motion flex shrink-0 items-center pr-[2px] transition-[width]",
              // To the sidebar's edge, where the divider is: less the header's padding (16, or 10
              // with no traffic lights) and a gap.
              !sidebarOpen
                ? "w-auto"
                : lights === "none"
                  ? "w-[calc(var(--pane-sidebar,300px)-14px)]"
                  : "w-[calc(var(--pane-sidebar,300px)-20px)]",
            )}
          >
            {lights === "none" ? null : <TrafficLights drawn={lights === "drawn"} />}
            {sidebar ? (
              // 8 past the lights (their own spacing): the icon starts 14 past the last light.
              <span className={cn("flex shrink-0", lights !== "none" && "ml-2")}>
                <SidebarToggle open={sidebar.open} onToggle={sidebar.onToggle} />
              </span>
            ) : null}
            {badge}
            <span className="flex-1" />
          </div>
          <DividerGrips value={dividerGrip}>{chrome}</DividerGrips>
        </header>
        <ResizablePanelGroup
          elementRef={group}
          groupRef={groupRef}
          orientation="horizontal"
          // The edges set the column-resize cursor themselves (the library's is ew-resize in
          // Chromium), and their grab area is exactly the gutter: never the canvas beside it.
          disableCursor
          resizeTargetMinimumSize={{ fine: 0, coarse: 0 }}
          onLayoutChange={onLayoutChange}
          onLayoutChanged={onLayoutChanged}
          className="min-h-0 flex-1"
        >
          {sidebar ? (
            <ResizablePanel
              id={PANEL.sidebar}
              panelRef={panels.sidebar}
              {...panelLimits("sidebar", collapsible.sidebar)}
              disabled={still === "sidebar"}
              groupResizeBehavior="preserve-pixel-size"
              style={{ overflow: "hidden" }}
            >
              <aside
                id="sidebar"
                aria-label="Canvases"
                inert={!sidebar.open}
                // Its width less the gutter past it (the edge), which is its right padding.
                className="flex h-full w-[calc(var(--pane-sidebar)-8px)] shrink-0 flex-col pt-[2px] pb-2.5 pl-2"
              >
                {sidebar.content}
              </aside>
            </ResizablePanel>
          ) : null}
          {sidebar ? edge("sidebar", "Resize sidebar", sidebarOpen, "w-2") : null}
          <ResizablePanel
            id={MAIN_PANEL}
            minSize={MAIN_MIN}
            className="flex flex-col"
            style={{ overflow: "visible" }}
          >
            <main
              className={cn(
                "pane-motion relative mb-1.5 min-h-0 flex-1 overflow-hidden rounded-10 bg-canvas shadow-canvas-edge transition-[margin]",
                // 6 from the window's edge where a pane is closed: the closed pane's gutter is 8
                // (sidebar) or 10 (rail), and the canvas reaches into it.
                !sidebar ? "ml-1.5" : !sidebarOpen && "-ml-0.5",
                !railOpen && "-mr-1",
              )}
            >
              {children}
            </main>
          </ResizablePanel>
          {edge("rail", "Resize thread", railOpen, "w-2.5")}
          <ResizablePanel
            id={PANEL.rail}
            panelRef={panels.rail}
            {...panelLimits("rail", collapsible.rail)}
            disabled={still === "rail"}
            groupResizeBehavior="preserve-pixel-size"
            style={{ overflow: "hidden" }}
          >
            <aside
              ref={railBox}
              id="thread"
              aria-label="Thread"
              inert={!railOpen}
              // Held to the window's right edge, so it slides in and out from there; its width
              // less the gutter before it (the edge), which is its left padding.
              className="ml-auto flex h-full w-[calc(var(--pane-rail)-10px)] flex-col pr-2.5 pb-2.5"
            >
              {rail ?? closingRail}
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </TipProvider>
  );
}

/** Marks the window as dragging an edge until the pointer is let go (cloud.css), then `after`. */
function dragging(frame: HTMLElement | null, after: () => void) {
  if (!frame) return;
  frame.setAttribute("data-pane-drag", "");
  const done = () => {
    frame.removeAttribute("data-pane-drag");
    window.removeEventListener("pointerup", done, true);
    window.removeEventListener("pointercancel", done, true);
    window.removeEventListener("blur", done);
    after();
  };
  window.addEventListener("pointerup", done, true);
  window.addEventListener("pointercancel", done, true);
  window.addEventListener("blur", done);
}

interface PaneMotion {
  start(): void;
  stop(): void;
  /** Runs `fn` once no toggle is easing: now, or when the easing ends. */
  after(fn: () => void): void;
  /** How long a pane takes to open or close: `--dur-pane`. */
  ms(): number;
}

/** `data-pane-motion` on the window for as long as a toggle's easing runs (cloud.css). */
function usePaneMotion(frame: RefObject<HTMLDivElement | null>): PaneMotion {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [motion] = useState<PaneMotion>(() => {
    const ms = () => {
      const value = frame.current
        ? getComputedStyle(frame.current).getPropertyValue("--dur-pane").trim()
        : "";
      // The build may write it in seconds (".22s").
      const parsed = Number.parseFloat(value) * (/\ds$/.test(value) ? 1000 : 1);
      return Number.isFinite(parsed) ? parsed : 220;
    };
    let waiting: (() => void)[] = [];
    const stop = () => {
      clearTimeout(timer.current);
      frame.current?.removeAttribute("data-pane-motion");
      const run = waiting;
      waiting = [];
      for (const fn of run) fn();
    };
    /** Whether a pane's easing is still under way: a busy window can start it late. */
    const easing = () =>
      (frame.current?.getAnimations({ subtree: true }) ?? []).some((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return (
          animation.playState === "running" &&
          "transitionProperty" in animation &&
          target instanceof Element &&
          target.matches("[data-panel], .pane-motion")
        );
      });
    return {
      ms,
      stop,
      start() {
        const el = frame.current;
        if (!el) return;
        clearTimeout(timer.current);
        el.setAttribute("data-pane-motion", "");
        const began = performance.now();
        const limit = ms() * 4 + 500;
        // A frame past the easing, so its last step lands before the transitions go; longer
        // while it's still running.
        const check = () => {
          if (easing() && performance.now() - began < limit) timer.current = setTimeout(check, 32);
          else stop();
        };
        timer.current = setTimeout(check, ms() + 32);
      },
      after(fn) {
        if (frame.current?.hasAttribute("data-pane-motion")) waiting.push(fn);
        else fn();
      },
    };
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  return motion;
}
