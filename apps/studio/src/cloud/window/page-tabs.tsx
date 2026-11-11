import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { Icon as PageIcon } from "@ponzu/canvas/icons";
import { useLayoutEffect, useRef, useState } from "react";
import type { PageTab } from "../model.ts";
import { IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { FadeScroll, SCROLL_FADE } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";

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

  return (
    // No page is active while the pull request tab is open: an empty value.
    <Tabs
      value={activeId ?? ""}
      onValueChange={onSelect}
      className="flex min-w-0 items-center gap-0.5"
    >
      <FadeScroll axis="x" className="min-w-0" style={{ minWidth }}>
        <TabsList ref={list} aria-label="Pages" className="py-1">
          {pages.map((page) => {
            const active = page.id === activeId;
            return (
              <TabsTrigger key={page.id} value={page.id} className="scroll-mx-4">
                {page.icon ? (
                  <span className={cn("flex", active && "text-icon-strong")}>
                    <PageIcon name={page.icon} size={14} strokeWidth={1.7} />
                  </span>
                ) : null}
                <span className={cn(page.working && "shimmer")}>{page.name}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </FadeScroll>
      <IconButton label="New page" onClick={onAdd} className="size-7 text-faint">
        <Icon icon={PlusSignIcon} size={14} stroke={1.9} />
      </IconButton>
    </Tabs>
  );
}
