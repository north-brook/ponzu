import {
  type CSSProperties,
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
import { type Layout, type PanelImperativeHandle, usePanelRef } from "react-resizable-panels";
import { cn } from "../ui/cn.ts";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui/resizable.tsx";
import { TipProvider } from "../ui/tooltip.tsx";
import { type Lights, SidebarToggle, TrafficLights } from "./chrome.tsx";
import { CANVAS_MIN, PANE_STEP, PANE_STEP_LARGE, PANES, type Pane, paneWidth } from "./panes.ts";

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

/** The panels' ids in the group (and on their elements); the panes' own ids stay theirs. */
const PANEL: Record<Pane, string> = { sidebar: "sidebar-pane", rail: "thread-pane" };
/** The custom property each pane's width is kept in on the window, for the chrome and its content. */
const WIDTH_VAR: Record<Pane, `--pane-${string}`> = {
  sidebar: "--pane-sidebar",
  rail: "--pane-rail",
};
/**
 * The gutter between a pane and the canvas, which is the edge's grab area: the sidebar's right
 * padding (8) and the rail's left (10), as the design pads them. A pane's width, as the design
 * gives it and as it's kept, takes in its gutter: its panel is that much narrower.
 */
const GUTTER: Record<Pane, number> = { sidebar: 8, rail: 10 };

/**
 * A panel's size limits, for a pane's (panes.ts). Collapsing is the toggles' (and ⌘B, ⌘J): an
 * open pane's panel can't collapse, so a drag, even one that leaves the window, stops it at its
 * minimum (the library collapses any collapsible panel dragged to nothing). usePaneToggle says
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
 * The main window: a 44px chrome over three panes. The sidebar and the thread rail open at the
 * widths the person last dragged them to (the design's 300 and 360 at first; panes.ts has the
 * limits); the pane between them, the canvas's, takes the rest.
 *
 * - `sidebar` null is a brand-new personal workspace: no sidebar and no toggle.
 * - `chrome` is everything past the left block (DesignChrome); nothing on the create page.
 * - `rail` is the thread rail's content, or null while it is closed.
 * - `children` fill the canvas pane.
 * - `badge` sits just past the sidebar toggle (or the traffic lights): the shell's update mark,
 *   when there is one.
 * - `panes`: the widths to open the panes at, and where a new one goes when an edge is moved.
 *
 * The chrome draws no lockup, in any state (the founder asked for it gone; the boards still
 * draw one). The sidebar toggle comes first at the left, just past the traffic lights, and
 * DesignChrome ends with the thread toggle at the window's right edge.
 *
 * The panes are react-resizable-panels' (shadcn's Resizable, ui/resizable.tsx), in pixels. Each
 * edge between a pane and the canvas is a separator: the gutter there is its grab area, it
 * follows the pointer, takes focus in tab order and moves with the arrow keys, and a double-click
 * returns the pane to the design's width. The toggles collapse and expand the panes through the
 * same panels, easing (`data-pane-motion`); a drag never eases. The chrome's blocks over the
 * panes read the widths from `--pane-sidebar` and `--pane-rail` on the window, which a drag
 * writes in the same frame as the panels move.
 */
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
  const sidebarOpen = sidebar?.open ?? false;
  const railOpen = rail !== null;
  const remembered: Record<Pane, number> = {
    sidebar: paneWidth("sidebar", panes?.sidebar),
    rail: paneWidth("rail", panes?.rail),
  };
  const frame = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const panels: Record<Pane, RefObject<PanelImperativeHandle | null>> = {
    sidebar: usePanelRef(),
    rail: usePanelRef(),
  };
  // Each pane's width as it stands while open: the remembered one, or less in a small window.
  const [shown, setShown] = useState(remembered);
  const motion = usePaneMotion(frame);
  // The edge the person last took hold of (pointer or keys): only its pane's width is kept.
  const held = useRef<Pane | null>(null);
  const onResize = useRef(panes?.onResize);
  onResize.current = panes?.onResize;

  // The rail's content stays while it closes, as it last was, so it slides away rather than
  // emptying first.
  const lastRail = useRef(rail);
  useEffect(() => {
    if (rail !== null) lastRail.current = rail;
  });
  const [closingRail, setClosingRail] = useState<ReactNode>(null);
  const [wasOpen, setWasOpen] = useState(railOpen);
  if (railOpen !== wasOpen) {
    setWasOpen(railOpen);
    setClosingRail(railOpen ? null : lastRail.current);
  }
  useEffect(() => {
    if (closingRail === null) return;
    const timer = setTimeout(() => setClosingRail(null), motion.ms());
    return () => clearTimeout(timer);
  }, [closingRail, motion]);

  const collapsible: Record<Pane, boolean> = {
    sidebar: usePaneToggle(
      panels.sidebar,
      sidebar ? sidebarOpen : null,
      remembered.sidebar - GUTTER.sidebar,
      motion,
    ),
    rail: usePaneToggle(panels.rail, railOpen, remembered.rail - GUTTER.rail, motion),
  };

  const widthsOf = useCallback((layout: Layout) => {
    const axis = axisSize(group.current);
    const widths: Partial<Record<Pane, number>> = {};
    for (const pane of ["sidebar", "rail"] as const) {
      const share = layout[PANEL[pane]];
      // Collapsed (or closing): the pane keeps the width it opens at.
      if (share !== undefined && axis > 0 && share > 0) {
        widths[pane] = (share / 100) * axis + GUTTER[pane];
      }
    }
    return widths;
  }, []);
  /** A pane's width as its panel stands now (the library's layout, ahead of the page's). */
  const widthNow = (pane: Pane, panel: PanelImperativeHandle) =>
    (panel.getSize().asPercentage / 100) * axisSize(group.current) + GUTTER[pane];

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
      setShown((now) => ({ ...now, ...widths }));
      const pane = held.current;
      const width = pane && widths[pane];
      if (meta.isUserInteraction && pane && width) onResize.current?.(pane, Math.round(width));
    },
    [widthsOf],
  );

  const edge = (pane: Pane, label: string, open: boolean, className: string) => (
    <ResizableHandle
      id={`${PANEL[pane]}-edge`}
      aria-label={label}
      disabled={!open}
      className={cn("app-no-drag mb-1.5", className)}
      onPointerDown={(event: PointerEvent) => {
        if (!open || event.button !== 0) return;
        held.current = pane;
        motion.stop();
        dragging(frame.current);
      }}
      onDoubleClick={() => {
        // The library has put the pane back at its default size; this keeps it.
        if (open) onResize.current?.(pane, PANES[pane].default);
      }}
      onKeyDownCapture={(event: KeyboardEvent) => {
        if (!open) return;
        held.current = pane;
        // Enter would collapse the pane behind its toggle's back: the toggles do that.
        if (event.key === "Enter") event.preventDefault();
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        // The library's step is 5% of the window, some 70px: too coarse for a pane. The edge
        // moves the way the arrow points, a little at a time.
        event.preventDefault();
        const panel = panels[pane].current;
        if (!panel) return;
        const towards = event.key === "ArrowRight" ? 1 : -1;
        const step = (event.shiftKey ? PANE_STEP_LARGE : PANE_STEP) * towards;
        const next = paneWidth(pane, widthNow(pane, panel) + (pane === "sidebar" ? step : -step));
        panel.resize(`${next - GUTTER[pane]}px`);
        // What the canvas's room let it have.
        onResize.current?.(pane, Math.round(widthNow(pane, panel)));
      }}
    />
  );

  return (
    <TipProvider>
      <div
        ref={frame}
        className="flex h-full flex-col bg-chrome text-ink"
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
          className={cn(
            "app-drag flex h-11 shrink-0 items-center gap-1",
            // 10 at either edge; on a Mac the traffic lights' own 16 on the left.
            lights === "none" ? "px-2.5" : "pr-2.5 pl-4",
          )}
        >
          <div
            className={cn(
              "pane-motion flex shrink-0 items-center pr-[2px]",
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
          {chrome}
        </header>
        <ResizablePanelGroup
          elementRef={group}
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
              groupResizeBehavior="preserve-pixel-size"
              style={{ overflow: "hidden" }}
            >
              <aside
                id="sidebar"
                aria-label="Designs"
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
            id="canvas-pane"
            minSize={CANVAS_MIN}
            className="flex flex-col"
            style={{ overflow: "visible" }}
          >
            <main
              className={cn(
                "pane-motion relative mb-1.5 min-h-0 flex-1 overflow-hidden rounded-10 bg-canvas",
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
            groupResizeBehavior="preserve-pixel-size"
            style={{ overflow: "hidden" }}
          >
            <aside
              id={railOpen ? "thread" : undefined}
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

/** The width the panels share: the group's, less the edges'. */
function axisSize(group: HTMLElement | null): number {
  if (!group) return 0;
  let size = 0;
  for (const panel of group.querySelectorAll(":scope > [data-panel]")) {
    size += panel.getBoundingClientRect().width;
  }
  return size;
}

/** Marks the window as dragging an edge until the pointer is let go (cloud.css). */
function dragging(frame: HTMLElement | null) {
  if (!frame) return;
  frame.setAttribute("data-pane-drag", "");
  const done = () => {
    frame.removeAttribute("data-pane-drag");
    window.removeEventListener("pointerup", done, true);
    window.removeEventListener("pointercancel", done, true);
    window.removeEventListener("blur", done);
  };
  window.addEventListener("pointerup", done, true);
  window.addEventListener("pointercancel", done, true);
  window.addEventListener("blur", done);
}

interface PaneMotion {
  start(): void;
  stop(): void;
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
    const stop = () => {
      clearTimeout(timer.current);
      frame.current?.removeAttribute("data-pane-motion");
    };
    return {
      ms,
      stop,
      start() {
        const el = frame.current;
        if (!el) return;
        clearTimeout(timer.current);
        el.setAttribute("data-pane-motion", "");
        // A frame past the easing, so its last step lands before the transitions go.
        timer.current = setTimeout(stop, ms() + 32);
      },
    };
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  return motion;
}

/**
 * Opens and closes a pane's panel as its toggle says: at once when the window first draws it,
 * easing after that. Open, it returns to the size remembered for it (`size`, the panel's: the
 * pane's width less its gutter). `open` null: the pane isn't there (a brand-new workspace has
 * no sidebar). Returns whether the panel may collapse now: only while it's closing or closed,
 * so that nothing but a toggle collapses it.
 */
function usePaneToggle(
  panel: RefObject<PanelImperativeHandle | null>,
  open: boolean | null,
  size: number,
  motion: PaneMotion,
): boolean {
  const [collapsible, setCollapsible] = useState(true);
  const was = useRef<boolean | null>(null);
  const sizeNow = useRef(size);
  sizeNow.current = size;
  const collapsibleNow = useRef(collapsible);
  collapsibleNow.current = collapsible;
  useLayoutEffect(() => {
    const before = was.current;
    was.current = open;
    const handle = panel.current;
    if (open === null || !handle || before === open) return;
    if (before !== null) motion.start();
    if (open) {
      // Out of collapsed while it still may be, then held open.
      handle.resize(`${sizeNow.current}px`);
      setCollapsible(false);
    } else if (collapsibleNow.current) {
      handle.collapse();
    } else {
      // The group learns the panel may collapse in the renders this sets off, which React
      // finishes before the microtask, still ahead of the frame: so it moves in the same frame
      // as the chrome.
      setCollapsible(true);
      queueMicrotask(() => {
        if (was.current === false) panel.current?.collapse();
      });
    }
  }, [panel, open, motion]);
  return collapsible;
}
