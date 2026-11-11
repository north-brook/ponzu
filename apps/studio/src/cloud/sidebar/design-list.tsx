import type { KeyboardEvent } from "react";
import type { DesignSummary } from "../model.ts";
import { Skeleton } from "../ui/skeleton.tsx";
import { DesignRow, type RowHandlers } from "./design-row.tsx";

/**
 * Rows of designs, one Tab stop for the whole list (the open design, else the first); the arrow
 * keys, Home and End move between rows and Return opens one.
 */
export function DesignList({
  designs,
  openId,
  label,
  indicators = true,
  onOpen,
  onAction,
  onRename,
}: RowHandlers & {
  designs: DesignSummary[];
  openId: string | null;
  label: string;
  indicators?: boolean;
}) {
  const stop = designs.some((d) => d.id === openId) ? openId : designs[0]?.id;

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-design-row]")];
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
    <ul aria-label={label} onKeyDown={onKeyDown} className="m-0 flex list-none flex-col gap-px p-0">
      {designs.map((design) => (
        <li key={design.id}>
          <DesignRow
            design={design}
            open={design.id === openId}
            indicators={indicators}
            tabIndex={design.id === stop ? 0 : -1}
            onOpen={onOpen}
            onAction={onAction}
            onRename={onRename}
          />
        </li>
      ))}
    </ul>
  );
}

/** Rows still on their way: a preview's tile and two lines, breathing. */
export function DesignListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading designs" className="flex flex-col gap-px">
      {Array.from({ length: rows }, (_, i) => {
        // Each row breathes a beat after the one above it.
        const delay = `${i * 120}ms`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else to tell them apart
          <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
            <Skeleton className="h-9 w-14 shrink-0 rounded-4" style={{ animationDelay: delay }} />
            <span className="flex flex-1 flex-col gap-2">
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
