import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";
import { Icon } from "./icon.tsx";
import { Tip } from "./tooltip.tsx";

/*
 * Every button has the same four states: hover lifts it a wash, pressed a second, keyboard focus
 * rings it, disabled fades it and takes it out of reach. A menu or popover's trigger keeps its
 * wash while open, read from aria-expanded (Radix's data-state is the tooltip's on a trigger
 * that has one); a pane toggle, which has no popup, never shows an open state.
 */
const buttonVariants = cva(
  "app-no-drag inline-flex shrink-0 cursor-default select-none items-center whitespace-nowrap outline-none transition-colors duration-(--dur-hover) focus-ring disabled:pointer-events-none disabled:opacity-35",
  {
    variants: {
      variant: {
        /** The chrome's one dark button: the next thing to do with the pull request. */
        action:
          "h-7 gap-1.5 rounded-8 bg-action pr-3 pl-2.5 font-semibold text-12 text-action-ink hover:bg-action-hover",
        /** A text control with no fill at rest: the repo chip, the model picker. */
        quiet:
          "h-7 rounded-8 font-medium text-12 text-muted hover:bg-hover active:bg-press [&[aria-haspopup][aria-expanded=true]]:bg-press",
        /** An icon alone. Size it with a class; it is square unless told otherwise. */
        icon: "justify-center rounded-7 text-muted hover:bg-hover active:bg-press [&[aria-haspopup][aria-expanded=true]]:bg-hover",
      },
    },
  },
);

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ variant, className, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant }), className)} {...props} />;
}

/** An icon button, named for assistive tech and, on hover, with its tip and shortcut. */
export function IconButton({
  label,
  keys,
  tipSide,
  className,
  ...props
}: Omit<ButtonProps, "variant" | "aria-label"> & {
  label: string;
  keys?: string[];
  tipSide?: "top" | "bottom" | "right";
}) {
  return (
    <Tip label={label} keys={keys} side={tipSide}>
      <Button variant="icon" aria-label={label} className={className} {...props} />
    </Tip>
  );
}

/**
 * The round yuzu send button. Disabled it goes quiet (a chip with a faint arrow) instead of
 * fading, so it still reads as the place to send from.
 */
export function SendButton({
  size,
  iconSize,
  className,
  ...props
}: Omit<ButtonProps, "variant"> & { size: 28 | 32; iconSize: number }) {
  return (
    <Tip label="Send" keys={["↩"]} side="top">
      <button
        type="button"
        aria-label="Send"
        className={cn(
          "app-no-drag grid shrink-0 cursor-default place-items-center rounded-pill bg-yuzu text-yuzu-ink outline-none transition-[background-color,filter] duration-(--dur-hover) focus-ring hover:brightness-[1.04] active:brightness-95 disabled:bg-chip disabled:text-faint",
          size === 32 ? "size-8" : "size-7",
          className,
        )}
        {...props}
      >
        <Icon icon={ArrowUp02Icon} size={iconSize} stroke={2.3} />
      </button>
    </Tip>
  );
}
