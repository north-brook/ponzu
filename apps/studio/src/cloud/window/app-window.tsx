import type { ReactNode } from "react";
import { cn } from "../ui/cn.ts";
import { TipProvider } from "../ui/tooltip.tsx";
import { Lockup, SidebarToggle, TrafficLights } from "./chrome.tsx";

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
 * - `badge` sits just past the lockup: the shell's update mark, when there is one.
 */
export function AppWindow({
  lights,
  sidebar,
  chrome,
  rail,
  badge,
  children,
}: {
  lights: "native" | "drawn";
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
        className="flex h-full flex-col bg-chrome text-ink"
        style={{ minWidth: MIN_WINDOW.width, minHeight: MIN_WINDOW.height }}
      >
        <header className="app-drag flex h-11 shrink-0 items-center gap-1 pr-2.5 pl-4">
          <div
            className={cn(
              "flex shrink-0 items-center gap-2 pr-[2px] transition-[width] duration-(--dur-pane) ease-out",
              sidebarOpen ? "w-[280px]" : "w-auto",
            )}
          >
            <TrafficLights drawn={lights === "drawn"} />
            <Lockup />
            {badge}
            <span className="flex-1" />
            {sidebar ? <SidebarToggle open={sidebar.open} onToggle={sidebar.onToggle} /> : null}
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
              "relative mb-1.5 min-w-0 flex-1 overflow-hidden rounded-10 bg-canvas transition-[margin] duration-(--dur-pane) ease-out",
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
