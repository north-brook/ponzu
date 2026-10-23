import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  Clock01Icon,
  ComputerIcon,
  File01Icon,
  Folder01Icon,
  GitBranchIcon,
  KeyboardIcon,
  LaptopIcon,
  Mic01Icon,
  MicOff01Icon,
  Moon02Icon,
  Notification01Icon,
  QrCodeIcon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import { Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { SLICE, SLICE_STROKE } from "../lib/mark";
import { pageIcon } from "../lib/page-icons";

/**
 * The app's icons: Hugeicons, the set the brand and desktop draw with
 * (packages/react/src/icons.tsx), by desktop's names where the concept is
 * the same. `color` is the stroke; sizes and stroke widths come from each
 * use. The Ponzu slice, Tailscale's dots and the agents' marks are brand
 * marks, drawn as their owners draw them, at the end of this file.
 */
type P = { size?: number; color: string; width?: number };

/** The Hugeicons each icon below draws; desktop's `Icons` names in comments. */
export const ICONS = {
  back: ArrowLeft01Icon,
  /** close */
  close: Cancel01Icon,
  /** chevronDown */
  chevron: ArrowDown01Icon,
  /** check */
  check: Tick02Icon,
  bell: Notification01Icon,
  clock: Clock01Icon,
  search: Search01Icon,
  branch: GitBranchIcon,
  folder: Folder01Icon,
  laptop: LaptopIcon,
  desktop: ComputerIcon,
  moon: Moon02Icon,
  qr: QrCodeIcon,
  refresh: RefreshIcon,
  mic: Mic01Icon,
  micOff: MicOff01Icon,
  keyboard: KeyboardIcon,
  send: ArrowUp02Icon,
  file: File01Icon,
} as const satisfies Record<string, IconSvgElement>;

function icon(svg: IconSvgElement, size: number, width: number) {
  return ({ size: s = size, color, width: w = width }: P) => (
    <HugeiconsIcon icon={svg} size={s} color={color} strokeWidth={w} />
  );
}

export const Back = icon(ICONS.back, 20, 1.8);
export const Close = icon(ICONS.close, 20, 2);
export const Chevron = icon(ICONS.chevron, 14, 2);
export const Check = icon(ICONS.check, 16, 2.2);
export const Bell = icon(ICONS.bell, 20, 1.8);
export const Clock = icon(ICONS.clock, 14, 1.7);
export const Search = icon(ICONS.search, 18, 1.8);
export const Branch = icon(ICONS.branch, 13, 1.7);
export const Folder = icon(ICONS.folder, 13, 1.7);
export const Laptop = icon(ICONS.laptop, 13, 1.7);
export const Desktop = icon(ICONS.desktop, 13, 1.7);
export const MacIcon = ({ kind, ...p }: P & { kind: "laptop" | "desktop" }) =>
  kind === "desktop" ? <Desktop {...p} /> : <Laptop {...p} />;
export const Moon = icon(ICONS.moon, 12, 2);
export const QR = icon(ICONS.qr, 20, 1.8);
export const Refresh = icon(ICONS.refresh, 20, 2);
export const Mic = icon(ICONS.mic, 20, 1.8);
export const MicOff = icon(ICONS.micOff, 20, 1.8);
export const Keyboard = icon(ICONS.keyboard, 20, 1.8);
export const Send = icon(ICONS.send, 20, 2.4);
export const FileIcon = icon(ICONS.file, 16, 1.7);

/** A page's icon, by the names design.json uses (lib/page-icons.ts): the same glyph as its menu's. */
export function PageIcon({ name, size = 16, color, width = 1.7 }: P & { name?: string }) {
  return <HugeiconsIcon icon={pageIcon(name)} size={size} color={color} strokeWidth={width} />;
}

/**
 * The connector between the marks on Connect and Tailscale: arrows both
 * ways, 22×10. A line drawing of the design's, not an icon.
 */
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
/** The broken connector to a Mac that isn't answering. */
export const Dashes = ({ size = 22, color, width = 1.8 }: P) => (
  <Svg width={size} height={(size * 10) / 22} viewBox="0 0 22 10" fill="none" stroke={color}>
    <Path d="M1 5h20" strokeWidth={width} strokeDasharray="3 3" />
  </Svg>
);

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

/**
 * An agent as its comments show it, as desktop's Avatar: a known agent's
 * mark on its own at the avatar's size, with no circle behind it; any
 * other agent's initials on the soft circle.
 */
export function AgentAvatar({
  name,
  client,
  size = 28,
  color,
  soft,
}: {
  name: string;
  client?: string;
  size?: number;
  color: string;
  /** The soft circle behind an unknown agent's initials. */
  soft: string;
}) {
  if (client === "claude" || client === "openai")
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <AgentMark client={client} size={size} color={color} />
      </View>
    );
  const initials = name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        backgroundColor: soft,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: size * 0.42, color }}>
        {initials}
      </Text>
    </View>
  );
}
