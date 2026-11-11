import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { Icon as PageIcon } from "@ponzu/canvas/icons";
import { useLayoutEffect, useRef, useState } from "react";
import type { PageTab } from "../model.ts";
import { IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { FadeScroll, SCROLL_FADE } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { JUMP_KEY, jumpNumber, jumpTarget, useJumpShortcuts } from "../ui/shortcut.ts";
import { HintedLabel, ShortcutHint } from "../ui/shortcut-hint.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";

/**
 * The open design's pages, as tabs. The active one is raised; the one the agent is drawing on
 * shimmers. `activeId` null is the pull request tab open, with no page showing. Arrow keys move
 * between tabs and Return or Space opens one. Too many to fit scroll under a fade, keeping the
 * active tab in view and clear of the fade: the strip gets narrower than it needs for that only
 * when the chrome has no more room, and then it gives way before anything beside it does.
 * ⌃1–9 open the first eight and the last; held a moment, ⌃ shows each tab its number, over its
 * icon, or on a tab without one in place of its name, centred on the tab.
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
  /** Null for someone who can't change the design: no "+". */
  onAdd: (() => void) | null;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [minWidth, setMinWidth] = useState<number>();
  const hint = useJumpShortcuts("page", (n) => {
    const page = jumpTarget(pages, n);
    if (page && page.id !== activeId) onSelect(page.id);
    return page !== undefined;
  });

  useLayoutEffect(() => {
    const tab = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    // Room for the fades only when the tabs need to scroll: tabs that fit end where they end,
    // and the "+" follows the last at their own 2px rhythm.
    const all = list.current?.scrollWidth ?? 0;
    setMinWidth(tab ? Math.min(all, tab.offsetWidth + 2 * SCROLL_FADE) : undefined);
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, pages]);

  return (
    // No page is active while the pull request tab is open: an empty value.
    <Tabs
      value={activeId ?? ""}
      onValueChange={onSelect}
      panels={false}
      className="flex min-w-0 items-center gap-0.5"
    >
      <FadeScroll
        axis="x"
        className="min-w-0"
        // The active tab whole, clear of the fades, while the chrome has the room; past that
        // (the smallest window with a crowded cluster on the right) the strip gives way, and
        // the "+" (28 and the 2 before it) keeps its place beside it.
        style={{
          minWidth:
            minWidth === undefined
              ? undefined
              : `min(${minWidth}px, 100%${onAdd ? " - 30px" : ""})`,
        }}
      >
        <TabsList ref={list} aria-label="Pages" className="py-1">
          {pages.map((page, i) => {
            const active = page.id === activeId;
            const n = jumpNumber(i, pages.length);
            return (
              <TabsTrigger
                key={page.id}
                value={page.id}
                aria-keyshortcuts={n ? `${JUMP_KEY.page.key}+${n}` : undefined}
                // A click opens the page without taking focus, as the chrome's buttons don't
                // (installFocusRule): Radix would focus the tab itself, so the press is ours.
                onMouseDown={(e) => {
                  if (e.button !== 0 || e.ctrlKey) return;
                  e.preventDefault();
                  if (!active) onSelect(page.id);
                }}
                className="scroll-mx-4"
              >
                {page.icon ? (
                  <ShortcutHint jump="page" n={n} shown={hint}>
                    <span className="flex">
                      <PageIcon name={page.icon} step="inline" />
                    </span>
                  </ShortcutHint>
                ) : null}
                {page.icon ? (
                  <span className={cn(page.working && "shimmer")}>{page.name}</span>
                ) : (
                  <HintedLabel
                    jump="page"
                    n={n}
                    shown={hint}
                    className={cn(page.working && "shimmer")}
                  >
                    {page.name}
                  </HintedLabel>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </FadeScroll>
      {onAdd ? (
        <IconButton label="New page" onClick={onAdd} className="size-7 text-icon-soft">
          <Icon icon={PlusSignIcon} step="inline" />
        </IconButton>
      ) : null}
    </Tabs>
  );
}
