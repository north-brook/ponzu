import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { enterThread } from "../thread/rail.tsx";
import { cn } from "../ui/cn.ts";
import { TipProvider } from "../ui/tooltip.tsx";
import { type Lights, SidebarToggle, TrafficLights } from "./chrome.tsx";

/** The smallest window the layout holds at: sidebar 300, rail 360 and a usable canvas. */
export const MIN_WINDOW = { width: 1100, height: 640 } as const;

export interface SidebarSlot {
  open: boolean;
  onToggle: () => void;
  content: ReactNode;
}

/**
 * The main window: a 44px chrome over three panes. The sidebar (300) and the thread rail (360)
 * keep their widths; the pane between them, the canvas's, takes the rest.
 *
 * - `sidebar` null is a brand-new personal workspace: no sidebar and no toggle.
 * - `chrome` is everything past the left block (DesignChrome); nothing on the create page.
 * - `rail` is the thread rail's content, or null while it is closed. Both panes ease open and
 *   shut on one clock (`pane-motion`), their content held still at the window's edge.
 * - `children` fill the canvas pane.
 * - `badge` sits just past the sidebar toggle (or the traffic lights): the shell's update mark,
 *   when there is one.
 *
 * The chrome draws no lockup, in any state (the founder asked for it gone; the boards still
 * draw one). The sidebar toggle comes first at the left, just past the traffic lights, and
 * DesignChrome ends with the thread toggle at the window's right edge.
 */
/**
 * `content` while it is there, and the last of it for as long as `box` takes to close after it
 * goes (its transition: none with reduced motion), so a pane closes with what it held. Only
 * while `hold`: what is leaving with the whole view (the design it showed) goes at once.
 */
function useHeldWhileClosing(
  content: ReactNode | null,
  box: RefObject<HTMLElement | null>,
  hold: boolean,
): ReactNode | null {
  const last = useRef(content);
  if (content !== null) last.current = content;
  else if (!hold) last.current = null;
  const [closed, setClosed] = useState(content === null);
  // Opening again before it had closed keeps what is there.
  if (content !== null && closed) setClosed(false);
  useEffect(() => {
    if (content !== null || !box.current) return;
    const seconds = Number.parseFloat(getComputedStyle(box.current).transitionDuration) || 0;
    const timer = setTimeout(() => {
      last.current = null;
      setClosed(true);
    }, seconds * 1000);
    return () => clearTimeout(timer);
  }, [content, box]);
  return content ?? (closed ? null : last.current);
}

/**
 * The keyboard and the thread pane. Once the pane has opened (its width's transition has ended,
 * or at once with reduced motion: it is `inert` until it is open), the keyboard goes into it
 * (`enterThread`), when it opened on a design that was already showing: the toggle, ⌘J, the
 * View menu, the pane coming back as the pull request tab closes. Not when it came with a
 * design being opened, which leaves the keyboard where the person was (a row of the sidebar).
 * Closing it with the keyboard inside gives the keyboard back to where it was before, or to the
 * window, so it never sits in a pane that has gone inert.
 */
function useThreadFocus(open: boolean, onDesign: boolean, box: RefObject<HTMLElement | null>) {
  const was = useRef({ open, onDesign });
  const before = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const prev = was.current;
    was.current = { open, onDesign };
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
    if (!prev.onDesign || !onDesign) return;
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      const active = document.activeElement;
      before.current = active instanceof HTMLElement && active !== document.body ? active : null;
      enterThread(pane);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === pane) land();
    };
    pane.addEventListener("transitionend", onEnd);
    // Should the transition not end (cut short, or none ran), a moment after it would have.
    const seconds = Number.parseFloat(getComputedStyle(pane).transitionDuration) || 0;
    const timer = setTimeout(land, seconds * 1000 + 50);
    return () => {
      pane.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
    };
  }, [open, onDesign, box]);
}

export function AppWindow({
  lights,
  sidebar,
  chrome,
  rail,
  badge,
  children,
}: {
  lights: Lights;
  sidebar: SidebarSlot | null;
  chrome?: ReactNode;
  rail: ReactNode | null;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const sidebarOpen = sidebar?.open ?? false;
  const railOpen = rail !== null;
  const railBox = useRef<HTMLElement>(null);
  const railShown = useHeldWhileClosing(rail, railBox, chrome != null);
  useThreadFocus(railOpen, chrome != null, railBox);
  return (
    <TipProvider>
      <div
        className="flex h-full flex-col bg-chrome text-ink"
        style={{ minWidth: MIN_WINDOW.width, minHeight: MIN_WINDOW.height }}
      >
        <header
          // A click on its buttons and tabs leaves focus where it was (quietPointerFocus).
          data-toolbar
          className={cn(
            "app-drag flex h-11 shrink-0 items-center gap-1",
            // 10 at either edge; on a Mac the traffic lights' own 16 on the left.
            lights === "none" ? "px-2.5" : "pr-2.5 pl-4",
          )}
        >
          <div
            className={cn(
              "pane-motion flex shrink-0 items-center pr-[2px] transition-[width]",
              // To the sidebar's edge at 300, where the divider is, less the padding and a gap.
              !sidebarOpen ? "w-auto" : lights === "none" ? "w-[286px]" : "w-[280px]",
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
        <div className="flex min-h-0 flex-1">
          {sidebar ? (
            <aside
              id="sidebar"
              aria-label="Designs"
              inert={!sidebar.open}
              className={cn(
                "pane-motion shrink-0 overflow-hidden transition-[width]",
                sidebar.open ? "w-[300px]" : "w-0",
              )}
            >
              <div className="flex h-full w-[300px] flex-col px-2 pt-[2px] pb-2.5">
                {sidebar.content}
              </div>
            </aside>
          ) : null}
          <main
            className={cn(
              "pane-motion relative mb-1.5 min-w-0 flex-1 overflow-hidden rounded-10 bg-canvas transition-[margin]",
              !sidebarOpen && "ml-1.5",
              !railOpen && "mr-1.5",
            )}
          >
            {children}
          </main>
          {/* The sidebar's mirror: the rail's content holds still at the window's edge while
              its room opens or closes, and stays until it has closed. */}
          <aside
            ref={railBox}
            id="thread"
            aria-label="Thread"
            inert={!railOpen}
            className={cn(
              "pane-motion flex shrink-0 justify-end overflow-hidden transition-[width]",
              railOpen ? "w-[360px]" : "w-0",
            )}
          >
            {railShown ? (
              <div className="flex h-full w-[360px] shrink-0 flex-col px-2.5 pb-2.5">
                {railShown}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </TipProvider>
  );
}
