import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { Icon as PageIcon } from "@ponzu/canvas/icons";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import type { PageTab } from "../model.ts";
import { IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { SCROLL_FADE, ScrollArea } from "../ui/scroll-area.tsx";

/**
 * The open design's pages, as tabs. The active one is raised; the one the agent is drawing on
 * shimmers. `activeId` null is the pull request tab open, with no page showing. Arrow keys move
 * between tabs and Return or Space opens one. Too many to fit scroll under a fade, keeping the
 * active tab in view and clear of the fade: the strip never gets narrower than it needs for that.
 */
export function PageTabs({
  pages,
  activeId,
  onSelect,
  onAdd,
}: {
  pages: PageTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [minWidth, setMinWidth] = useState<number>();

  useLayoutEffect(() => {
    const tab = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    setMinWidth(tab ? tab.offsetWidth + 2 * SCROLL_FADE : undefined);
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, pages]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = [...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    const next = tabs[at + (e.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  // The tab you reach with Tab is the active one, or the first while none is.
  const focusable = activeId ?? pages[0]?.id;

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <ScrollArea axis="x" className="min-w-0" style={{ minWidth }}>
        <div
          ref={list}
          role="tablist"
          aria-label="Pages"
          onKeyDown={onKeyDown}
          className="flex items-center gap-0.5 py-1"
        >
          {pages.map((page) => {
            const active = page.id === activeId;
            return (
              <button
                key={page.id}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={page.id === focusable ? 0 : -1}
                onClick={() => onSelect(page.id)}
                className={cn(
                  "app-no-drag flex h-7 shrink-0 scroll-mx-4 cursor-default select-none items-center gap-1.5 whitespace-nowrap rounded-7 px-2.5 text-13 outline-none transition-colors duration-(--dur-hover) focus-ring",
                  active
                    ? "bg-raised font-medium text-ink shadow-raised"
                    : "text-muted hover:bg-hover active:bg-press",
                )}
              >
                {page.icon ? (
                  <span className={cn("flex", active && "text-icon-strong")}>
                    <PageIcon name={page.icon} size={14} strokeWidth={1.7} />
                  </span>
                ) : null}
                <span className={cn(page.working && "shimmer")}>{page.name}</span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
      <IconButton label="New page" onClick={onAdd} className="size-7 text-faint">
        <Icon icon={PlusSignIcon} size={14} stroke={1.9} />
      </IconButton>
    </div>
  );
}
