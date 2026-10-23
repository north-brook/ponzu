import Svg, { Circle, Path, Rect } from "react-native-svg";
import { SLICE, SLICE_STROKE } from "../lib/mark";

/**
 * The design's line icons, drawn on a 24-unit grid as its artboards draw
 * them. `color` is the stroke; sizes and stroke widths come from each use.
 */
type P = { size?: number; color: string; width?: number };

const line = (size: number, color: string, width: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: color,
  strokeWidth: width,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const Back = ({ size = 20, color, width = 1.8 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M14 6l-6 6 6 6" />
  </Svg>
);
export const Close = ({ size = 20, color, width = 2 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const Chevron = ({ size = 14, color, width = 2 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M7 10l5 5 5-5" />
  </Svg>
);
export const Check = ({ size = 16, color, width = 2.2 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);
export const Bell = ({ size = 20, color, width = 1.8 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
    <Path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Svg>
);
export const Search = ({ size = 18, color, width = 1.8 }: P) => (
  <Svg {...line(size, color, width)}>
    <Circle cx="11" cy="11" r="6.5" />
    <Path d="M16 16l4.5 4.5" />
  </Svg>
);
export const Branch = ({ size = 13, color, width = 1.7 }: P) => (
  <Svg {...line(size, color, width)}>
    <Circle cx="7" cy="5.5" r="2" />
    <Circle cx="7" cy="18.5" r="2" />
    <Circle cx="17" cy="8" r="2" />
    <Path d="M7 7.5v9M17 10c0 4-10 2.5-10 6.5" />
  </Svg>
);
export const Folder = ({ size = 13, color, width = 1.7 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
  </Svg>
);
export const Laptop = ({ size = 13, color, width = 1.7 }: P) => (
  <Svg {...line(size, color, width)}>
    <Rect width="15" height="10.5" x="4.5" y="5" rx="1.5" />
    <Path d="M2.5 18.5h19" />
  </Svg>
);
export const Desktop = ({ size = 13, color, width = 1.7 }: P) => (
  <Svg {...line(size, color, width)}>
    <Rect width="18" height="12.5" x="3" y="4" rx="2" />
    <Path d="M9 20.5h6M12 16.5v4" />
  </Svg>
);
export const MacIcon = ({ kind, ...p }: P & { kind: "laptop" | "desktop" }) =>
  kind === "desktop" ? <Desktop {...p} /> : <Laptop {...p} />;
export const Moon = ({ size = 12, color, width = 2 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Svg>
);
export const QR = ({ size = 20, color, width = 1.8 }: P) => (
  <Svg {...line(size, color, width)}>
    <Rect width="6.5" height="6.5" x="3.5" y="3.5" rx="1.2" />
    <Rect width="6.5" height="6.5" x="14" y="3.5" rx="1.2" />
    <Rect width="6.5" height="6.5" x="3.5" y="14" rx="1.2" />
    <Path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM14 18.5v2M18.5 14h2" />
  </Svg>
);
export const Swap = ({ size = 22, color, width = 1.8 }: P) => (
  <Svg width={size} height={(size * 10) / 22} viewBox="0 0 22 10" fill="none" stroke={color}>
    <Path
      d="M1 5h20M5 1L1 5l4 4M17 1l4 4-4 4"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);
export const Dashes = ({ size = 22, color, width = 1.8 }: P) => (
  <Svg width={size} height={(size * 10) / 22} viewBox="0 0 22 10" fill="none" stroke={color}>
    <Path d="M1 5h20" strokeWidth={width} strokeDasharray="3 3" />
  </Svg>
);
export const Refresh = ({ size = 20, color, width = 2 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />
  </Svg>
);
export const Mic = ({ size = 20, color, width = 1.8 }: P) => (
  <Svg {...line(size, color, width)}>
    <Rect width="6" height="11" x="9" y="3" rx="3" />
    <Path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </Svg>
);
export const MicOff = ({ size = 20, color, width = 1.8 }: P) => (
  <Svg {...line(size, color, width)}>
    <Rect width="6" height="11" x="9" y="3" rx="3" />
    <Path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16" />
  </Svg>
);
export const Keyboard = ({ size = 20, color, width = 1.8 }: P) => (
  <Svg {...line(size, color, width)}>
    <Rect width="19" height="12" x="2.5" y="6" rx="2" />
    <Path d="M6 9.5h.01M9.3 9.5h.01M12.6 9.5h.01M15.9 9.5h.01M18 9.5h.01M7 14.5h10" />
  </Svg>
);
export const Send = ({ size = 20, color, width = 2.4 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const FileIcon = ({ size = 16, color, width = 1.7 }: P) => (
  <Svg {...line(size, color, width)}>
    <Path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
    <Path d="M13.5 3v5.5H19" />
  </Svg>
);

/** A page's icon, by the names design.json uses (the studio's Icons). */
export function PageIcon({ name, ...p }: P & { name?: string }) {
  switch (name) {
    case "phone":
      return (
        <Svg {...line(p.size ?? 16, p.color, p.width ?? 1.7)}>
          <Rect width="11" height="19" x="6.5" y="2.5" rx="3" />
          <Path d="M10.5 5.5h3" />
        </Svg>
      );
    case "desktop":
      return <Desktop size={p.size ?? 16} color={p.color} width={p.width ?? 1.7} />;
    case "tablet":
      return (
        <Svg {...line(p.size ?? 16, p.color, p.width ?? 1.7)}>
          <Rect width="15" height="19" x="4.5" y="2.5" rx="2.5" />
          <Path d="M11 18.5h2" />
        </Svg>
      );
    case "palette":
      return (
        <Svg {...line(p.size ?? 16, p.color, p.width ?? 1.7)}>
          <Path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.9-.7-1.3-.7-2.2 0-.9.7-1.7 1.7-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" />
          <Circle cx="7.5" cy="11" r="1" />
          <Circle cx="10" cy="7" r="1" />
          <Circle cx="15" cy="7.5" r="1" />
        </Svg>
      );
    case "flow":
      return (
        <Svg {...line(p.size ?? 16, p.color, p.width ?? 1.7)}>
          <Rect width="6" height="5" x="3" y="3.5" rx="1.2" />
          <Rect width="6" height="5" x="15" y="15.5" rx="1.2" />
          <Path d="M6 8.5v4a2 2 0 0 0 2 2h7" />
        </Svg>
      );
    case "layout":
      return (
        <Svg {...line(p.size ?? 16, p.color, p.width ?? 1.7)}>
          <Rect width="17" height="17" x="3.5" y="3.5" rx="2" />
          <Path d="M3.5 9h17M9.5 9v11.5" />
        </Svg>
      );
    default:
      return (
        <Svg {...line(p.size ?? 16, p.color, p.width ?? 1.7)}>
          <Rect width="17" height="17" x="3.5" y="3.5" rx="2" />
          <Path d="M3.5 12h17M12 3.5v17" />
        </Svg>
      );
  }
}

/** The Ponzu slice, flat (no bloom): for marks, the lockup and small places. */
export function SliceMark({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      {SLICE.map((d) => (
        <Path
          key={d}
          d={d}
          fill={color}
          stroke={color}
          strokeWidth={SLICE_STROKE}
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

/** Tailscale's nine dots, as the design draws them: on #141414, a T of bright dots. */
export function TailscaleMark({ size }: { size: number }) {
  const dots: [number, number, number][] = [
    [4, 4, 0.2],
    [12, 4, 0.2],
    [20, 4, 0.2],
    [4, 12, 1],
    [12, 12, 1],
    [20, 12, 1],
    [4, 20, 0.2],
    [12, 20, 1],
    [20, 20, 0.2],
  ];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {dots.map(([cx, cy, o]) => (
        <Circle key={`${cx}${cy}`} cx={cx} cy={cy} r={2.7} fill="#ffffff" fillOpacity={o} />
      ))}
    </Svg>
  );
}

const CLAUDE =
  "m4.7 15.96 4.72-2.65.08-.23-.08-.13h-.23l-.79-.05-2.7-.07-2.34-.1-2.27-.12-.57-.12L0 11.79l.06-.35.48-.32.69.06 1.52.1 2.28.16 1.65.1 2.45.25h.39l.05-.16-.13-.1-.1-.1-2.36-1.6-2.55-1.69-1.34-.97-.72-.5-.37-.46-.16-1.01.66-.73.88.06.22.06.9.69 1.91 1.48 2.5 1.84.36.3.15-.1.02-.07-.17-.27-1.36-2.46-1.45-2.5-.65-1.04-.17-.62a3 3 0 0 1-.1-.74l.75-1.02.42-.13 1 .13.42.37.62 1.42 1 2.24 1.56 3.04.46.9.24.83.09.25h.16v-.15l.13-1.71.24-2.1.23-2.7.08-.76.37-.91.75-.49.58.28.48.69-.07.44-.28 1.85-.56 2.9-.36 1.95h.21l.24-.24.98-1.3 1.65-2.07.73-.82.85-.9.55-.43h1.03l.76 1.13-.34 1.17-1.06 1.35-.88 1.14-1.27 1.7-.79 1.36.07.11.19-.02 2.86-.61 1.55-.28 1.84-.32.83.39.09.4-.33.81-1.97.49-2.31.46-3.44.81-.04.03.05.06 1.55.15.66.04h1.62l3.02.22.79.52.47.64-.08.49-1.21.62-1.64-.39-3.82-.91-1.31-.33h-.18v.11l1.09 1.07 2 1.81 2.51 2.33.13.58-.32.45-.34-.05-2.2-1.66-.85-.75-1.93-1.62h-.13v.17l.44.65 2.34 3.52.12 1.08-.17.35-.61.21-.67-.12-1.37-1.92-1.41-2.17-1.14-1.94-.14.08-.67 7.26-.32.37-.72.28-.6-.46-.32-.74.32-1.46.38-1.9.31-1.5.28-1.88.17-.62-.01-.04-.14.02-1.42 1.95-2.16 2.92-1.71 1.83-.41.16-.71-.37.07-.66.4-.58 2.36-3 1.42-1.86.92-1.08-.01-.15h-.05l-6.28 4.08-1.12.14-.48-.45.06-.74.23-.24 1.89-1.3Z";
const OPENAI =
  "M22.28 9.82a5.99 5.99 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.99 5.99 0 0 0-4 2.9 6.05 6.05 0 0 0 .75 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.99 5.99 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5ZM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06l-4.83 2.79a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97v5.68a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87Zm16.6 3.86-5.83-3.39 2.01-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.66Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66ZM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.8.8 0 0 0-.39.68Zm1.1-2.36 2.6-1.5 2.61 1.5v3l-2.6 1.5-2.6-1.5Z";

/** An agent's product mark, as desktop's AgentMark: Claude, OpenAI, or a plain dot. */
export function AgentMark({
  client,
  size = 14,
  color,
}: {
  client?: string;
  size?: number;
  color: string;
}) {
  if (client === "claude")
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={CLAUDE} fill="#D97757" />
      </Svg>
    );
  if (client === "openai")
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={OPENAI} fill={color} />
      </Svg>
    );
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth={1.8} />
      <Circle cx="12" cy="12" r="3.5" fill={color} />
    </Svg>
  );
}
