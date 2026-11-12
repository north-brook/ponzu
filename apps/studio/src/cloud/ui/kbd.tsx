/*
 * shadcn/ui's kbd, themed with our tokens. Two looks: `quiet`, a key named in passing as faint
 * text ("⌘," in a menu, "esc" in the search field), and `cap`, a key cap inside a tip.
 */
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "./cn.ts";

const kbdVariants = cva("font-sans text-11", {
  variants: {
    variant: {
      quiet: "shrink-0 font-normal text-faint leading-none",
      cap: "min-w-4 rounded-4 bg-tip-key px-1 text-center text-tip-key-ink leading-4",
    },
  },
  defaultVariants: { variant: "quiet" },
});

function Kbd({
  className,
  variant,
  ...props
}: React.ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>) {
  return <kbd data-slot="kbd" className={cn(kbdVariants({ variant }), className)} {...props} />;
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd data-slot="kbd-group" className={cn("flex gap-0.5", className)} {...props} />;
}

export { Kbd, KbdGroup };
