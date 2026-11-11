import type { ReactNode } from "react";
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
 * - `rail` is the thread rail's content, or null while it is closed.
 * - `children` fill the canvas pane.
 * - `badge` sits just past the sidebar toggle (or the traffic lights): the shell's update mark,
 *   when there is one.
 *
 * The chrome draws no lockup, in any state (the founder asked for it gone; the boards still
 * draw one). The sidebar toggle comes first at the left, just past the traffic lights, and
 * DesignChrome ends with the thread toggle at the window's right edge.
 */
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
  return (
    <TipProvider>
      <div
        // The shell: the solid colour, or clear over the Mac's glass (tokens.css, --c-shell).
        className="flex h-full flex-col bg-shell text-ink"
        style={{ minWidth: MIN_WINDOW.width, minHeight: MIN_WINDOW.height }}
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
              "flex shrink-0 items-center pr-[2px] transition-[width] duration-(--dur-pane) ease-out",
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
                "shrink-0 overflow-hidden transition-[width] duration-(--dur-pane) ease-out",
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
              "relative mb-1.5 min-w-0 flex-1 overflow-hidden rounded-10 bg-canvas shadow-canvas-edge transition-[margin] duration-(--dur-pane) ease-out",
              !sidebarOpen && "ml-1.5",
              !rail && "mr-1.5",
            )}
          >
            {children}
          </main>
          {rail ? (
            <aside
              id="thread"
              aria-label="Thread"
              className="flex w-[360px] shrink-0 flex-col px-2.5 pb-2.5"
            >
              {rail}
            </aside>
          ) : null}
        </div>
      </div>
    </TipProvider>
  );
}
