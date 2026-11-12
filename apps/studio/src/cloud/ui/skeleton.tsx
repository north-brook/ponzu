/*
 * shadcn/ui's skeleton, themed with our tokens: a placeholder for a line or a row that is still
 * loading. It breathes instead of sweeping, so a list of them stays calm, and holds still for
 * reduced motion. Size and round it with a class, as the mockup draws what it stands for.
 */
import type * as React from "react";
import { cn } from "./cn.ts";

function Skeleton({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="skeleton" className={cn("breathe bg-hover", className)} {...props} />;
}

export { Skeleton };
