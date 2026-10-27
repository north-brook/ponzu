import { Icon } from "@ponzu/react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import type { Script } from "./script";

/**
 * The use cases above the demo, white on its ink stage: a column for each, its name and the
 * prompt it plays. A rule along the top of each fills as its story plays and stays full once it's
 * done, so the bar reads as a timeline of all five. Narrow, the names scroll in a row and the
 * playing tab's prompt sits under them.
 */
export function TabBar({
  tabs,
  active,
  progress,
  onPick,
  controls,
}: {
  tabs: Script[];
  active: number;
  /** How far through the active tab's story we are, from 0 to 1. */
  progress: number;
  onPick: (i: number) => void;
  /** The id of the demo the tabs play. */
  controls: string;
}) {
  const row = useRef<HTMLDivElement>(null);

  // Narrow, keep the playing tab in view as the bar advances, without scrolling the page.
  useEffect(() => {
    const el = row.current;
    const tab = el?.children[active] as HTMLElement | undefined;
    if (!el || !tab || el.scrollWidth <= el.clientWidth) return;
    el.scrollTo({ left: tab.offsetLeft - 16, behavior: "smooth" });
  }, [active]);

  // As a tablist: arrows move between tabs and play the one they land on.
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (active + step + tabs.length) % tabs.length;
    onPick(next);
    (row.current?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={row}
        role="tablist"
        aria-label="What your agent can make"
        onKeyDown={onKeyDown}
        className="grid grid-cols-5 gap-6 max-[960px]:gap-4 max-[720px]:-mx-4 max-[720px]:flex max-[720px]:snap-x max-[720px]:gap-5 max-[720px]:overflow-x-auto max-[720px]:px-4 max-[720px]:[scrollbar-width:none]"
      >
        {tabs.map((tab, i) => {
          const on = i === active;
          const fill = i < active ? 1 : on ? progress : 0;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={controls}
              tabIndex={on ? 0 : -1}
              onClick={() => onPick(i)}
              className="group relative flex min-w-0 cursor-pointer snap-start flex-col gap-2 pt-3.5 text-left outline-none focus-visible:after:absolute focus-visible:after:-inset-x-2 focus-visible:after:-top-2 focus-visible:after:-bottom-2 focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-white/70 max-[720px]:shrink-0"
            >
              <i aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-white/16" />
              <i
                aria-hidden
                className="absolute inset-x-0 top-0 h-0.5 origin-left bg-white"
                style={{ scale: `${fill} 1` }}
              />
              <span
                className={`flex items-center gap-2 font-display text-[19px] leading-6 font-semibold tracking-[-0.02em] whitespace-nowrap transition-colors max-[720px]:text-[17px] ${
                  on ? "text-white" : "text-white/50 group-hover:text-white/80"
                }`}
              >
                <Icon name={tab.icon} size={17} strokeWidth={1.8} />
                {tab.name}
              </span>
              <span
                className={`text-[13.5px]/5 text-pretty transition-colors max-[720px]:hidden ${
                  on ? "text-white/72" : "text-white/38 group-hover:text-white/55"
                }`}
              >
                {tab.prompt}
              </span>
            </button>
          );
        })}
      </div>
      <p aria-hidden className="m-0 hidden text-[13.5px]/5 text-white/72 max-[720px]:block">
        {tabs[active]?.prompt}
      </p>
    </div>
  );
}
