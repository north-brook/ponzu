import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../ui/cn.ts";
import { TipProvider } from "../ui/tooltip.tsx";
import { type Lights, SidebarToggle, TrafficLights } from "./chrome.tsx";

/** The smallest window the layout holds at: sidebar 300, rail 360 and a usable canvas. */
export const MIN_WINDOW = { width: 1100, height: 640 } as const;

/**
 * The side panes' widths, as the window sets them on itself in `--pane-sidebar` and
 * `--pane-rail`: the panes take their widths from these, and so does whatever in the chrome lines
 * up with a pane's edge (the left block, the rail's block with its divider), so there is one
 * number for each edge.
 */
const PANE_WIDTH = { sidebar: 300, rail: 360 } as const;

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
  return (
    <TipProvider>
      <div
        // The shell: the solid colour, or clear over the Mac's glass (tokens.css, --c-shell).
        className="flex h-full flex-col bg-shell text-ink"
        style={
          {
            minWidth: MIN_WINDOW.width,
            minHeight: MIN_WINDOW.height,
            "--pane-sidebar": `${PANE_WIDTH.sidebar}px`,
            "--pane-rail": `${PANE_WIDTH.rail}px`,
          } as CSSProperties
        }
      >
        <header
          // A click on its buttons and tabs leaves focus where it was (installFocusRule).
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
              // To the sidebar's edge, where the divider is: less the header's padding (16, or 10
              // with no traffic lights) and its 4 of gap.
              !sidebarOpen
                ? "w-auto"
                : lights === "none"
                  ? "w-[calc(var(--pane-sidebar)-14px)]"
                  : "w-[calc(var(--pane-sidebar)-20px)]",
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
                sidebar.open ? "w-(--pane-sidebar)" : "w-0",
              )}
            >
              <div className="flex h-full w-(--pane-sidebar) flex-col px-2 pt-[2px] pb-2.5">
                {sidebar.content}
              </div>
            </aside>
          ) : null}
          <main
            className={cn(
              "pane-motion relative mb-1.5 min-w-0 flex-1 overflow-hidden rounded-10 bg-canvas shadow-canvas-edge transition-[margin]",
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
              railOpen ? "w-(--pane-rail)" : "w-0",
            )}
          >
            {railShown ? (
              <div className="flex h-full w-(--pane-rail) shrink-0 flex-col px-2.5 pb-2.5">
                {railShown}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </TipProvider>
  );
}
