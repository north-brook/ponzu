/*
 * shadcn/ui's button, with the design's variants in place of shadcn's. Every button has the same
 * four states: hover lifts it a wash, pressed a second, keyboard focus rings it, disabled fades
 * it and takes it out of reach. A menu or popover's trigger keeps its wash while open, read from
 * aria-expanded (Radix's data-state is the tooltip's on a trigger that has one); a pane toggle,
 * which has no popup, never shows an open state. Most are sized by the caller, as the design
 * sizes each one; `size` names the ones that repeat.
 */
import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "./cn.ts";
import { Icon } from "./icon.tsx";
import { Tip } from "./tooltip.tsx";

const buttonVariants = cva(
  "app-no-drag inline-flex shrink-0 cursor-default select-none items-center whitespace-nowrap outline-none transition-colors duration-(--dur-hover) focus-ring disabled:pointer-events-none disabled:opacity-35",
  {
    variants: {
      variant: {
        /** The chrome's one dark button: the next thing to do with the pull request. */
        action:
          "h-7 gap-1.5 rounded-8 bg-action pr-3 pl-2.5 font-semibold text-12 text-action-ink hover:bg-action-hover active:bg-action-press",
        /** A text control with no fill at rest: the repo chip, the model picker. */
        quiet:
          "h-7 rounded-8 font-medium text-12 text-muted hover:bg-hover active:bg-press [&[aria-haspopup][aria-expanded=true]]:bg-press",
        /** A step's or a dialog's one dark button: Continue, Connect. Size it with a class. */
        primary:
          "justify-center gap-1.5 rounded-8 bg-action font-medium text-action-ink hover:bg-action-hover active:bg-action-press",
        /** A white button lifted off its row: Set up, Sign out, Rebuild. Size it with a class. */
        raised:
          "justify-center gap-1.5 rounded-8 bg-raised font-medium text-12 text-ink shadow-button hover:bg-raised-hover active:bg-chip",
        /** What can't be undone: Delete account, Disconnect. Size it with a class. */
        danger:
          "justify-center gap-1.5 rounded-8 bg-danger font-medium text-danger-ink hover:brightness-[1.06] active:brightness-95",
        /** An icon alone. Size it with a class; it is square unless told otherwise. */
        icon: "justify-center rounded-7 text-muted hover:bg-hover active:bg-press [&[aria-haspopup][aria-expanded=true]]:bg-hover",
      },
      size: {
        /** As the variant and the caller's class draw it. */
        default: "",
        /** A dialog's button: 36 tall, sharing the row's width. */
        dialog: "h-9 flex-1 px-3.5 text-12",
      },
    },
    defaultVariants: { size: "default" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Draws the button's look on its one child (a link, a Radix trigger) instead of a button. */
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? undefined}
      type={asChild ? type : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
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
 * fading, so it still reads as the place to send from. It stays in reach (aria-disabled, not
 * disabled), so its tip still says that Return sends.
 */
export function SendButton({
  size,
  disabled,
  onClick,
  className,
  ...props
}: Omit<ButtonProps, "variant" | "size" | "asChild"> & { size: 28 | 32 }) {
  return (
    <Tip label="Send" keys={["↩"]} side="top">
      <button
        type="button"
        aria-label="Send"
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onClick}
        className={cn(
          "app-no-drag grid shrink-0 cursor-default place-items-center rounded-pill bg-yuzu text-yuzu-ink outline-none transition-[background-color,filter] duration-(--dur-hover) focus-ring not-aria-disabled:hover:brightness-[1.04] not-aria-disabled:active:brightness-95 aria-disabled:bg-chip aria-disabled:text-faint",
          size === 32 ? "size-8" : "size-7",
          className,
        )}
        {...props}
      >
        <Icon icon={ArrowUp02Icon} step={size === 32 ? "control" : "inline"} onFill />
      </button>
    </Tip>
  );
}

export { Button, buttonVariants };
