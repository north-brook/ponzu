import { LayoutLeftIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";

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
 * since macOS 26 they are 14px across and 9px apart; measured in the running app, the last one
 * ends about 74px in. The room is 60px, which with the toggle's own 8px and its icon's 6px of
 * inset puts the icon 16px past the last light: the same 16px that separates the icon from the
 * design's name beside it when the sidebar is closed, so the chrome's left end keeps one rhythm.
 * An older macOS has the smaller lights and so a little more air. The window centres them on the
 * chrome's 44px (apps/desktop/src/traffic-lights.ts).
 */
export function TrafficLights({ drawn }: { drawn: boolean }) {
  if (!drawn) return <div aria-hidden className="h-3 w-[60px] shrink-0" />;
  return (
    <div aria-hidden className="flex shrink-0 gap-2">
      {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
        <span key={color} className="size-3 rounded-pill" style={{ background: color }} />
      ))}
    </div>
  );
}

/** The chrome's hairline: one at the sidebar's edge, one at the rail's. */
export function ChromeDivider() {
  return <span aria-hidden className="h-4 w-px shrink-0 bg-sep" />;
}

export function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <IconButton
      label="Toggle sidebar"
      aria-expanded={open}
      aria-controls="sidebar"
      onClick={onToggle}
      className="size-7"
    >
      <Icon icon={LayoutLeftIcon} size={16} stroke={1.7} />
    </IconButton>
  );
}
