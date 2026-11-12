import type { KeyboardEvent } from "react";
import type { CanvasSummary } from "../model.ts";
import { jumpNumber } from "../ui/shortcut.ts";
import { Skeleton } from "../ui/skeleton.tsx";
import { CanvasRow, type RowHandlers } from "./canvas-row.tsx";

/**
 * Rows of canvases, one Tab stop for the whole list (the open canvas, else the first); the arrow
 * keys, Home and End move between rows and Return opens one. With `shortcuts`, these are the
 * rows ⌘1–9 open, and `hint` shows their numbers.
 */
export function CanvasList({
  canvases,
  openId,
  label,
  indicators = true,
  shortcuts = false,
  hint = false,
  onOpen,
  onAction,
  onRename,
  onIntent,
}: RowHandlers & {
  canvases: CanvasSummary[];
  openId: string | null;
  label: string;
  indicators?: boolean;
  shortcuts?: boolean;
  hint?: boolean;
}) {
  const stop = canvases.some((d) => d.id === openId) ? openId : canvases[0]?.id;

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-canvas-row]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const to =
      e.key === "ArrowDown"
        ? at + 1
        : e.key === "ArrowUp"
          ? at - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? rows.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
  };

  return (
    <ul
      aria-label={label}
      onKeyDown={onKeyDown}
      // Canvases' names: masked in a private recording (app/analytics/privacy.ts).
      data-replay="mask"
      className="m-0 flex list-none flex-col gap-px p-0"
    >
      {canvases.map((canvas, i) => {
        const shortcut = shortcuts ? jumpNumber(i, canvases.length) : undefined;
        return (
          <li key={canvas.id}>
            <CanvasRow
              canvas={canvas}
              open={canvas.id === openId}
              indicators={indicators}
              tabIndex={canvas.id === stop ? 0 : -1}
              shortcut={shortcut}
              hint={shortcut !== undefined && hint}
              onOpen={onOpen}
              onAction={onAction}
              onRename={onRename}
              onIntent={onIntent}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** Rows still on their way: a preview's tile and three lines, breathing. */
export function CanvasListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading canvases" className="flex flex-col gap-px">
      {Array.from({ length: rows }, (_, i) => {
        // Each row breathes a beat after the one above it.
        const delay = `${i * 120}ms`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else to tell them apart
          <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
            <Skeleton className="h-12 w-16 shrink-0 rounded-4" style={{ animationDelay: delay }} />
            <span className="flex flex-1 flex-col gap-[9px]">
              <Skeleton className="h-2 w-1/4 rounded-3" style={{ animationDelay: delay }} />
              <Skeleton
                className="h-2.5 rounded-3"
                style={{ width: `${72 - (i % 3) * 14}%`, animationDelay: delay }}
              />
              <Skeleton className="h-2 w-2/5 rounded-3" style={{ animationDelay: delay }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
