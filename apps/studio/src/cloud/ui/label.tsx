/*
 * shadcn/ui's label, themed with our tokens: a field's name above it, medium 12px muted
 * ("Monthly spend cap").
 */
import { Label as LabelPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "./cn.ts";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn("px-0.5 pt-2 font-medium text-12 text-muted", className)}
      {...props}
    />
  );
}

export { Label };
