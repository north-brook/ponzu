import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { DesignSummary } from "../model.ts";
import { orderSettled } from "../status.ts";
import { cn } from "../ui/cn.ts";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { DesignList, DesignListSkeleton } from "./design-list.tsx";
import type { RowHandlers } from "./design-row.tsx";

/**
 * Designs whose pull request merged, folded into a tray at the sidebar's foot. Expanded, they
 * open in place above it, most recently settled first and without indicators; opening one
 * reopens it. `designs` is null while they load.
 */
export function SettledTray({
  count,
  designs,
  expanded,
  onExpandedChange,
  openId,
  ...handlers
}: RowHandlers & {
  count: number;
  designs: DesignSummary[] | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  openId: string | null;
}) {
  return (
    <div className="flex min-h-0 shrink-0 flex-col">
      {expanded ? (
        <FadeScroll id="settled" className="max-h-[45vh] border-sep border-t pt-1.5">
          {designs ? (
            <DesignList
              designs={orderSettled(designs)}
              openId={openId}
              label="Settled designs"
              indicators={false}
              {...handlers}
            />
          ) : (
            <DesignListSkeleton rows={Math.min(count, 3)} />
          )}
        </FadeScroll>
      ) : null}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="settled"
        onClick={() => onExpandedChange(!expanded)}
        className="mt-1.5 flex h-8 shrink-0 cursor-default select-none items-center gap-2 rounded-8 pr-2 pl-2.5 text-12 text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover active:bg-press"
      >
        Settled
        <span className="ml-auto font-mono text-11 text-faint">{count}</span>
        <Icon
          icon={ArrowRight01Icon}
          size={11}
          stroke={2.2}
          className={cn(
            "text-icon-soft transition-transform duration-(--dur-pane) ease-out",
            expanded && "rotate-90",
          )}
        />
      </button>
    </div>
  );
}
