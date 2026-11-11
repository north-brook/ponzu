/*
 * shadcn/ui's switch, themed with our tokens: an on/off setting that saves as it is flipped, 34
 * by 20, the knob sliding 14px.
 */
import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "./cn.ts";

function Switch({
  label,
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  /** Its name for assistive tech: the row's title. */
  label: string;
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      aria-label={label}
      className={cn(
        "relative h-5 w-[34px] shrink-0 cursor-default rounded-pill outline-none transition-colors duration-(--dur-pop) ease-out focus-ring disabled:opacity-35 data-[state=checked]:bg-action data-[state=unchecked]:bg-switch-off",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="absolute top-0.5 left-0.5 block size-4 rounded-pill bg-knob shadow-knob transition-transform duration-(--dur-pop) ease-out data-[state=checked]:translate-x-[14px]"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
