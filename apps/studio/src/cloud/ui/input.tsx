/*
 * shadcn/ui's input, themed with our tokens. Here it is the text control alone: medium 13px ink
 * with a yuzu caret, a faint placeholder, muted when read-only. Its frame (the edge, the focused
 * halo) is the field's (input-group.tsx), so every field can take a leading mark.
 */
import type * as React from "react";
import { cn } from "./cn.ts";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-medium font-sans text-13 text-ink caret-yuzu outline-none placeholder:font-normal placeholder:text-faint read-only:text-muted",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
