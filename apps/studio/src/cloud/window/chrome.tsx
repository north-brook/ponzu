import { LayoutLeftIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";

/**
 * What sits at the chrome's left before the sidebar toggle. `native`: the Mac's own traffic
 * lights, which the window draws (`trafficLightPosition: { x: 16, y: 16 }`, so the app leaves
 * their room); `drawn`: painted ones, for the browser and the gallery; `none`: Windows and
 * Linux, whose windows keep their own title bar, so the chrome starts at its edge.
 */
export type Lights = "native" | "drawn" | "none";

/**
 * Where the Mac's traffic lights sit: three 12px lights 8px apart, from 16px in, centred on the
 * chrome's 44px (16 down, 12 tall). The room ends 68px in.
 */
export function TrafficLights({ drawn }: { drawn: boolean }) {
  return (
    <div aria-hidden className="flex shrink-0 gap-2">
      {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
        <span
          key={color}
          className="size-3 rounded-pill"
          style={{ background: drawn ? color : undefined }}
        />
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
