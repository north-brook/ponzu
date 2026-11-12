import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "./cn.ts";
import { ICON, type IconStep, ON_FILL } from "./ladder.ts";

export type { IconSvgElement };

/**
 * A Hugeicons stroke icon (MIT, @hugeicons/core-free-icons) at a step of the ladder (ladder.ts):
 * `control`, `inline`, `small`, `meta` or `tick`, each a size and stroke that paint the same line.
 * `onFill` draws it a little heavier on a solid ground (the send arrow, the action button). Its
 * strokes are `currentColor`: color it with a text token on it or its parent.
 */
export function Icon({
  icon,
  step,
  onFill = false,
  className,
}: {
  icon: IconSvgElement;
  step: IconStep;
  onFill?: boolean;
  className?: string;
}) {
  const { size, stroke } = ICON[step];
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={onFill ? stroke + ON_FILL : stroke}
      aria-hidden
      className={cn("shrink-0", className)}
    />
  );
}
