/*
 * shadcn/ui's input-group, themed with our tokens: a one-line field's frame, 40 tall, with an
 * edge at rest and the mockup's soft halo while focused (never an ink ring). An invalid control
 * inside turns the edge danger and keeps the halo. Its addons hold what sits before or after the
 * text: an icon, the faint "$" of an amount, a button.
 *
 * Changed from shadcn's: the frame and its addons are spans, so a field can sit inside a label
 * or a row's text, and the addons take no padding of their own (the frame's gap spaces them).
 * shadcn's InputGroupButton and InputGroupTextarea aren't used yet; `bun run shadcn add
 * input-group --diff` shows them.
 */
import type * as React from "react";
import { cn } from "./cn.ts";
import { Input } from "./input.tsx";

function InputGroup({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"span"> & {
  /** `compact`: 28 tall, for a field inside a row (a secret, the cap). */
  size?: "default" | "compact";
}) {
  return (
    <span
      data-slot="input-group"
      data-size={size}
      className={cn(
        "flex shrink-0 items-center bg-surface transition-shadow duration-(--dur-hover)",
        size === "compact"
          ? "h-7 gap-1 rounded-7 px-2 [&_input]:text-12"
          : "h-10 gap-2.5 rounded-9 px-3",
        "shadow-field focus-within:shadow-field-focus",
        "has-[[data-slot=input-group-control][aria-invalid=true]]:shadow-field-error has-[[data-slot=input-group-control][aria-invalid=true]]:focus-within:shadow-field-error-focus",
        className,
      )}
      {...props}
    />
  );
}

/** What sits before or after the text. A click on it (not on a button in it) focuses the text. */
function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"span"> & { align?: "inline-start" | "inline-end" }) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the text it focuses has the keyboard
    <span
      data-slot="input-group-addon"
      data-align={align}
      className={cn("flex shrink-0 items-center", className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("flex items-center text-13 text-faint", className)} {...props} />;
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return <Input data-slot="input-group-control" className={className} {...props} />;
}

export { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText };
