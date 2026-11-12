import { LayoutLeftIcon } from "@hugeicons/core-free-icons";
import { createContext, type PointerEvent, useContext } from "react";
import { IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { paneHeld, useShortcut } from "../ui/shortcut.ts";
import type { Pane } from "./panes.ts";

/**
 * What sits at the chrome's left before the sidebar toggle. `native`: the Mac's own traffic
 * lights, which the window draws (apps/desktop/src/traffic-lights.ts, so the app leaves
 * their room); `drawn`: painted ones, for the browser and the gallery; `none`: Windows and
 * Linux, whose windows keep their own title bar, so the chrome starts at its edge.
 */
export type Lights = "native" | "drawn" | "none";

/**
 * The traffic lights' room at the chrome's left. Drawn (the browser and the gallery): three 12px
 * lights 8px apart, as the boards draw them, from 16px in. Native: the Mac draws its own, and
 * since macOS 26 they are 14px across and 9px apart. The room is 58px, set by eye against the
 * running app so the toggle's icon sits 14px past the last light: the same 14px that separates
 * the icon from the divider after it when the sidebar is closed, so the chrome's left end keeps
 * one rhythm. An older macOS has the smaller lights and so a little more air. The window centres
 * them on the chrome's 38px (apps/desktop/src/traffic-lights.ts).
 */
export function TrafficLights({ drawn }: { drawn: boolean }) {
  if (!drawn) return <div aria-hidden className="h-3 w-[58px] shrink-0" />;
  return (
    <div aria-hidden className="flex shrink-0 gap-2">
      {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
        <span key={color} className="size-3 rounded-pill" style={{ background: color }} />
      ))}
    </div>
  );
}

/**
 * The chrome's hairline: one before the page tabs (on the sidebar's edge while it is open, just
 * past the canvas's name while it is closed), one before the thread toggle (on the rail's edge
 * while it is open, just past the people and the next action while it is closed).
 */
export function ChromeDivider({ pane }: { pane?: Pane }) {
  const grip = useContext(DividerGrips)?.(pane) ?? null;
  return (
    <span
      aria-hidden
      data-chrome-divider
      className={cn(
        "relative h-4 w-px shrink-0 bg-sep",
        // As a pane's edge hints (ui/resizable.tsx): only once the pointer rests on it, and
        // stronger while it is held.
        grip &&
          "transition-[background-color] duration-(--dur-hover) ease-out hover:bg-dry hover:delay-(--dur-linger) has-data-held:bg-icon-soft has-data-held:delay-0",
      )}
    >
      {grip ? (
        // The handle: the chrome's height and 4 either side of the hairline, inside the 12 the
        // chrome keeps clear around it, so it never covers a control.
        <span
          data-chrome-grip={pane}
          className="app-no-drag -inset-x-1 -inset-y-[11px] absolute cursor-col-resize"
          onPointerDown={grip.onPointerDown}
          onDoubleClick={grip.onDoubleClick}
        />
      ) : null}
    </span>
  );
}

/**
 * A chrome divider standing on an open pane's edge is a handle for that edge too: a drag sizes
 * the pane as its own edge below does, and a double click returns it to the mockup's width. The
 * keyboard's way is the edge itself, which is in the tab order.
 */
export interface DividerGrip {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}

/** The window's answer for a divider: its pane's grip, or null while that pane is closed. */
export const DividerGrips = createContext<((pane?: Pane) => DividerGrip | null) | null>(null);

/**
 * Opens and closes the sidebar: ⌘B from anywhere in the window, as ⌥⌘B does the rail, except
 * while a menu or a modal is over it or its row's name is being edited (paneHeld).
 */
export function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  useShortcut("b", () => paneHeld("sidebar") || onToggle());
  return (
    <IconButton
      label="Toggle sidebar"
      keys={["⌘", "B"]}
      aria-expanded={open}
      aria-controls="sidebar"
      onClick={onToggle}
      className="size-7"
    >
      <Icon icon={LayoutLeftIcon} step="control" />
    </IconButton>
  );
}
