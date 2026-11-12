import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { CanvasSummary } from "../model.ts";
import { settledShown } from "../status.ts";
import { cn } from "../ui/cn.ts";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { TEXT } from "../ui/ladder.ts";
import { CanvasList, CanvasListSkeleton } from "./canvas-list.tsx";
import type { RowHandlers } from "./canvas-row.tsx";

/**
 * Canvases whose pull request merged, folded into a section at the sidebar's foot: its header,
 * and under it, when it is open, the settled canvases, most recently settled first and without
 * indicators. Closed, it still shows the canvas that is open in the window if that one is
 * settled, alone under the header, so the row you are in is never out of sight. `canvases` is
 * null while they load.
 */
export function SettledTray({
  count,
  canvases,
  expanded,
  onExpandedChange,
  openId,
  ...handlers
}: RowHandlers & {
  count: number;
  canvases: CanvasSummary[] | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  openId: string | null;
}) {
  const shown = canvases ? settledShown(canvases, expanded, openId) : expanded ? null : [];
  return (
    <div className="flex min-h-0 shrink-0 flex-col">
      <button
        type="button"
        data-moves="settled"
        aria-expanded={expanded}
        aria-controls="settled"
        onClick={() => onExpandedChange(!expanded)}
        className="mt-1.5 flex h-8 shrink-0 cursor-default select-none items-center gap-2 rounded-8 pr-2 pl-2.5 text-12 text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover active:bg-press"
      >
        Settled
        <span className={cn("ml-auto", TEXT.meta)}>{count}</span>
        <Icon
          icon={ArrowRight01Icon}
          step="meta"
          className={cn(
            "text-icon-soft transition-transform duration-(--dur-pane) ease-out",
            expanded && "rotate-90",
          )}
        />
      </button>
      <FadeScroll id="settled" className={cn("max-h-[45vh]", shown?.length !== 0 && "pt-px")}>
        {shown === null ? (
          <CanvasListSkeleton rows={Math.min(count, 3)} />
        ) : shown.length ? (
          <CanvasList
            canvases={shown}
            openId={openId}
            label="Settled canvases"
            indicators={false}
            {...handlers}
          />
        ) : null}
      </FadeScroll>
    </div>
  );
}
