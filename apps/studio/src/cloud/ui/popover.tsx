import { Popover as P } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

/*
 * A popover: a surface hung from its trigger. Radix closes it on Escape or a click outside and
 * returns focus to the trigger.
 */
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export function PopoverContent({
  width,
  className,
  ...props
}: ComponentProps<typeof P.Content> & { width: number }) {
  return (
    <P.Portal>
      <P.Content
        collisionPadding={8}
        className={cn(
          "pop z-50 flex flex-col rounded-14 bg-surface text-ink shadow-pop outline-none",
          className,
        )}
        style={{ width }}
        {...props}
      />
    </P.Portal>
  );
}
