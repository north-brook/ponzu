import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";
import { Icon } from "./icon.tsx";
import type { IconStep } from "./ladder.ts";

/**
 * A link that leaves the app, inline in a line of text or a row: muted, with the arrow out after
 * it. Hovered, it reads as a link rather than a chip: the text and arrow darken to ink and the
 * arrow leans a pixel toward where it goes. No ground, so nothing around it moves or boxes it in.
 * `tone="ink"` is one that is already the row's action (Manage on GitHub): it stays ink, and
 * only its arrow answers. `trailing` takes the arrow's place (a waiting slice).
 */
export function ExternalLink({
  tone = "muted",
  arrow = "meta",
  trailing,
  className,
  children,
  ...props
}: ComponentProps<"button"> & {
  tone?: "muted" | "ink";
  /** The arrow's step on the ladder: `meta` beside 11–12px words, `small` beside 13px. */
  arrow?: IconStep;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      data-slot="external-link"
      className={cn(
        // The margins give back the padding: the words sit where they would, and the keyboard's
        // ring gets 4px of air at the sides and 2px above and below instead of hugging them.
        "group/link -mx-1 -my-0.5 inline-flex cursor-default items-center gap-1.5 rounded-6 px-1 py-0.5 outline-none transition-colors duration-(--dur-hover) focus-ring",
        tone === "muted" ? "text-muted hover:text-ink" : "text-ink",
        className,
      )}
      {...props}
    >
      {children}
      {trailing ?? (
        <span
          aria-hidden
          className={cn(
            "flex transition-[color,translate] duration-(--dur-hover) ease-(--ease-out) group-hover/link:translate-x-px group-hover/link:-translate-y-px group-hover/link:text-ink group-disabled/link:translate-none",
            tone === "muted" ? "text-icon-soft" : "text-muted",
          )}
        >
          <Icon icon={ArrowUpRight01Icon} step={arrow} />
        </span>
      )}
    </button>
  );
}
