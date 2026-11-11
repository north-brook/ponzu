import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

/**
 * A one-line text field, 40 tall: an edge at rest, and focused the design's soft halo with a yuzu
 * caret (never an ink ring). `invalid` turns the edge danger and keeps the halo. `leading` sits
 * before the text: an icon, or the faint "$" of an amount.
 */
export function TextField({
  invalid = false,
  mono = false,
  compact = false,
  leading,
  trailing,
  className,
  ...props
}: ComponentProps<"input"> & {
  invalid?: boolean;
  mono?: boolean;
  /** 28 tall, for a field inside a row: a secret, the cap. */
  compact?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center bg-surface transition-shadow duration-(--dur-hover)",
        compact ? "h-7 gap-1 rounded-7 px-2 [&_input]:text-12" : "h-10 gap-2.5 rounded-9 px-3",
        invalid
          ? "shadow-field-error focus-within:shadow-field-error-focus"
          : "shadow-field focus-within:shadow-field-focus",
        className,
      )}
    >
      {leading}
      <input
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          "h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-medium text-13 text-ink caret-yuzu outline-none placeholder:font-normal placeholder:text-faint read-only:text-muted",
          mono ? "font-mono" : "font-sans",
        )}
        {...props}
      />
      {trailing}
    </span>
  );
}
