import { LayoutLeftIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { Slice } from "../ui/marks.tsx";

/**
 * Where the Mac's traffic lights sit: three 12px lights 8px apart. In Electron the window draws
 * its own there (`trafficLightPosition: { x: 16, y: 16 }`), so the app leaves the room; `drawn`
 * paints them, for the browser and the gallery.
 */
export function TrafficLights({ drawn }: { drawn: boolean }) {
  return (
    <div aria-hidden className="mr-0.5 flex shrink-0 gap-2">
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

/** The slice and the wordmark, sharing a baseline. On every workspace, solo or team. */
export function Lockup() {
  return (
    <span className="relative -top-[1.5px] flex shrink-0 items-center gap-1.5 text-ink">
      <Slice size={16} className="relative top-[1.5px]" />
      <span className="font-bold font-display text-16 leading-none tracking-[-0.05em]">ponzu</span>
    </span>
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
