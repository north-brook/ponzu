import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "./cn.ts";

export type { IconSvgElement };

/**
 * A Hugeicons stroke icon (MIT, @hugeicons/core-free-icons) at the size and stroke the design
 * gives it. Its strokes are `currentColor`: color it with a text token on it or its parent.
 */
export function Icon({
  icon,
  size,
  stroke,
  className,
}: {
  icon: IconSvgElement;
  size: number;
  stroke: number;
  className?: string;
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={stroke}
      aria-hidden
      className={cn("shrink-0", className)}
    />
  );
}
