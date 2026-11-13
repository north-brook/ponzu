export { type IconName, Icons } from "./icon-names.ts";

import { Edit03Icon, File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type IconName, Icons } from "./icon-names.ts";
import { ICON, type IconStep, ON_FILL } from "./ladder.ts";
import { SLICE, SLICE_STROKE } from "./slice.ts";

/**
 * A page's, a board's or a control's icon at a step of the ladder (ladder.ts): `control` unless
 * told otherwise. `onFill` draws it heavier on a solid ground. `size` and `strokeWidth` override
 * the step, for a host drawing outside the app's ladder (the web's GitHub viewer).
 */
export function Icon({
  name,
  step = "control",
  onFill = false,
  size,
  strokeWidth,
  className,
}: {
  name: IconName | string;
  step?: IconStep;
  onFill?: boolean;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const icon = Icons[name as IconName] ?? File01Icon;
  const at = ICON[step];
  return (
    <HugeiconsIcon
      icon={icon}
      size={size ?? at.size}
      strokeWidth={strokeWidth ?? (onFill ? at.stroke + ON_FILL : at.stroke)}
      className={className}
    />
  );
}

/**
 * The pencil on a comment being written: an unsent comment's pin, and a thread's while a reply to
 * it is unsent. Not one of Icons, which a page can take: the iPhone would need its image too.
 */
export function Pencil() {
  return <HugeiconsIcon icon={Edit03Icon} size={ICON.small.size} strokeWidth={ICON.small.stroke} />;
}

/** The Ponzu slice, in one color: ink, or paper on dark. `color` overrides both. */
export function Logo({
  size = 20,
  dark = false,
  color,
}: {
  size?: number;
  dark?: boolean;
  color?: string;
}) {
  const fill = color ?? (dark ? "#F4F3EF" : "#111110");
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Ponzu">
      <g fill={fill} stroke={fill} strokeWidth={SLICE_STROKE} strokeLinejoin="round">
        {SLICE.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Cursor's mark, from Simple Icons (simple-icons/simple-icons, icons/cursor.svg, CC0): drawn in
 * `currentColor`, as Cursor's own is black or white.
 */
export const CURSOR_MARK =
  "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23";

/**
 * T3 Code's mark: its "T3" wordmark, from its own repo (pingdotgg/t3code, MIT,
 * apps/web/src/components/T3Wordmark.tsx), one path rounded to hundredths, drawn in
 * `currentColor` as T3 Code draws it. Its box is made square about the letters
 * (`T3_MARK_VIEWBOX`), so it sits in a mark's square as the others do.
 */
export const T3_MARK =
  "M33.45 93V47.56H15.53V37H64.33V47.56H46.41V93H33.45ZM86.73 93.96C82.83 93.96 78.97 93.45 75.13 92.44C71.29 91.37 68.03 89.88 65.37 87.96L70.41 78.04C72.54 79.59 75.02 80.81 77.85 81.72C80.67 82.63 83.53 83.08 86.41 83.08C89.66 83.08 92.22 82.44 94.09 81.16C95.95 79.88 96.89 78.12 96.89 75.88C96.89 73.75 96.06 72.07 94.41 70.84C92.75 69.61 90.09 69 86.41 69H80.49V60.44L96.09 42.76L97.53 47.4H68.17V37H107.36V45.4L91.85 63.08L85.29 59.32H89.05C95.93 59.32 101.12 60.87 104.64 63.96C108.17 67.05 109.92 71.03 109.92 75.88C109.92 79.03 109.1 81.99 107.44 84.76C105.79 87.48 103.26 89.69 99.85 91.4C96.43 93.11 92.06 93.96 86.73 93.96Z";
export const T3_MARK_VIEWBOX = "15.53 18.28 94.39 94.39";

/**
 * Agent product marks, for presence and for the agent driving a canvas: Claude, OpenAI (Codex),
 * Cursor, T3 Code, or a plain dot for any other.
 */
export function AgentMark({ client, size = 14 }: { client?: string; size?: number }) {
  if (client === "claude") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Claude">
        <path
          fill="#D97757"
          d="m4.7 15.96 4.72-2.65.08-.23-.08-.13h-.23l-.79-.05-2.7-.07-2.34-.1-2.27-.12-.57-.12L0 11.79l.06-.35.48-.32.69.06 1.52.1 2.28.16 1.65.1 2.45.25h.39l.05-.16-.13-.1-.1-.1-2.36-1.6-2.55-1.69-1.34-.97-.72-.5-.37-.46-.16-1.01.66-.73.88.06.22.06.9.69 1.91 1.48 2.5 1.84.36.3.15-.1.02-.07-.17-.27-1.36-2.46-1.45-2.5-.65-1.04-.17-.62a3 3 0 0 1-.1-.74l.75-1.02.42-.13 1 .13.42.37.62 1.42 1 2.24 1.56 3.04.46.9.24.83.09.25h.16v-.15l.13-1.71.24-2.1.23-2.7.08-.76.37-.91.75-.49.58.28.48.69-.07.44-.28 1.85-.56 2.9-.36 1.95h.21l.24-.24.98-1.3 1.65-2.07.73-.82.85-.9.55-.43h1.03l.76 1.13-.34 1.17-1.06 1.35-.88 1.14-1.27 1.7-.79 1.36.07.11.19-.02 2.86-.61 1.55-.28 1.84-.32.83.39.09.4-.33.81-1.97.49-2.31.46-3.44.81-.04.03.05.06 1.55.15.66.04h1.62l3.02.22.79.52.47.64-.08.49-1.21.62-1.64-.39-3.82-.91-1.31-.33h-.18v.11l1.09 1.07 2 1.81 2.51 2.33.13.58-.32.45-.34-.05-2.2-1.66-.85-.75-1.93-1.62h-.13v.17l.44.65 2.34 3.52.12 1.08-.17.35-.61.21-.67-.12-1.37-1.92-1.41-2.17-1.14-1.94-.14.08-.67 7.26-.32.37-.72.28-.6-.46-.32-.74.32-1.46.38-1.9.31-1.5.28-1.88.17-.62-.01-.04-.14.02-1.42 1.95-2.16 2.92-1.71 1.83-.41.16-.71-.37.07-.66.4-.58 2.36-3 1.42-1.86.92-1.08-.01-.15h-.05l-6.28 4.08-1.12.14-.48-.45.06-.74.23-.24 1.89-1.3Z"
        />
      </svg>
    );
  }
  if (client === "openai") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="OpenAI">
        <path
          fill="currentColor"
          d="M22.28 9.82a5.99 5.99 0 0 0-.52-4.91 6.05 6.05 0 0 0-6.51-2.9A6.07 6.07 0 0 0 4.98 4.18a5.99 5.99 0 0 0-4 2.9 6.05 6.05 0 0 0 .75 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.52 2.9A5.99 5.99 0 0 0 13.26 24a6.06 6.06 0 0 0 5.77-4.21 5.99 5.99 0 0 0 4-2.9 6.06 6.06 0 0 0-.75-7.07Zm-9.02 12.61a4.48 4.48 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68v-6.74l2.02 1.17a.07.07 0 0 1 .04.05v5.58a4.5 4.5 0 0 1-4.49 4.5ZM3.6 18.3a4.47 4.47 0 0 1-.54-3.01l.14.09 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06l-4.83 2.79a4.5 4.5 0 0 1-6.14-1.65ZM2.34 7.9a4.49 4.49 0 0 1 2.37-1.97v5.68a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0l-4.83-2.79A4.5 4.5 0 0 1 2.34 7.87Zm16.6 3.86-5.83-3.39 2.01-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.66Zm2.01-3.02-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.66ZM8.31 12.86l-2.02-1.16a.08.08 0 0 1-.04-.06V6.07a4.5 4.5 0 0 1 7.38-3.45l-.14.08-4.78 2.76a.8.8 0 0 0-.39.68Zm1.1-2.36 2.6-1.5 2.61 1.5v3l-2.6 1.5-2.6-1.5Z"
        />
      </svg>
    );
  }
  if (client === "cursor") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Cursor">
        <path fill="currentColor" d={CURSOR_MARK} />
      </svg>
    );
  }
  if (client === "t3") {
    return (
      <svg width={size} height={size} viewBox={T3_MARK_VIEWBOX} aria-label="T3 Code">
        <path fill="currentColor" d={T3_MARK} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Agent">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" />
    </svg>
  );
}
