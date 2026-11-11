import { Tooltip } from "radix-ui";
import type { ReactElement, ReactNode } from "react";

/**
 * Shares one hover delay across the tips inside it: once one has shown, the next shows straight
 * away as the pointer moves along the chrome. The app mounts one at its root.
 */
export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={300} disableHoverableContent>
      {children}
    </Tooltip.Provider>
  );
}

/**
 * A control's name, and its shortcut as key caps, on hover or keyboard focus. Dark in either
 * theme, like the canvas's. The child is the trigger and keeps its own accessible name: the tip
 * repeats it for the eye.
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
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="tip z-50 flex h-[26px] select-none items-center gap-2 whitespace-nowrap rounded-7 bg-tip pr-1.5 pl-[9px] font-sans text-12 text-tip-ink leading-4 shadow-tip"
        >
          {label}
          {keys?.length ? (
            <span className="flex gap-0.5">
              {keys.map((k) => (
                <kbd
                  key={k}
                  className="min-w-4 rounded-4 bg-tip-key px-1 text-center font-sans text-11 text-tip-key-ink leading-4"
                >
                  {k}
                </kbd>
              ))}
            </span>
          ) : null}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
