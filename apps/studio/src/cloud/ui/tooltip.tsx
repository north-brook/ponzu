/*
 * shadcn/ui's tooltip, themed with our tokens: dark in either theme, like the canvas's, with no
 * arrow. `Tip` is how the product uses it: a control's name and its shortcut as key caps, on
 * hover or keyboard focus.
 */
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn.ts";
import { Kbd, KbdGroup } from "./kbd.tsx";

/**
 * Shares one hover delay across the tips inside it: once one has shown, the next shows straight
 * away as the pointer moves along the chrome.
 */
function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 300,
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "tip z-50 flex h-[26px] select-none items-center gap-2 whitespace-nowrap rounded-7 bg-tip pr-1.5 pl-[9px] font-sans text-12 text-tip-ink leading-4 shadow-tip",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/** The app mounts one at its root (and a modal its own). */
export function TipProvider({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

/**
 * A control's name, and its shortcut as key caps, on hover or keyboard focus. The child is the
 * trigger and keeps its own accessible name: the tip repeats it for the eye.
 */
export function Tip({
  label,
  keys,
  side = "bottom",
  children,
}: {
  label: string;
  keys?: string[];
  side?: "top" | "bottom" | "right";
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {keys?.length ? (
          <KbdGroup>
            {keys.map((k) => (
              <Kbd key={k} variant="cap">
                {k}
              </Kbd>
            ))}
          </KbdGroup>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
