"use client";

import { Icon, Icons } from "@ponzu/react/icons";
import { createContext, type ReactNode, useContext, useState } from "react";

/*
 * Which page of a design shows. On a phone the canvas's own page bar gives way to a picker in
 * the top bar (PagePicker), so the two share the page here.
 */

export interface PageInfo {
  id: string;
  name: string;
  icon?: string;
}

interface Pages {
  pages: PageInfo[];
  /** Null until someone picks: the canvas's first. */
  page: string | null;
  setPage: (id: string) => void;
}

const PagesContext = createContext<Pages | null>(null);

export function PagesProvider({ pages, children }: { pages: PageInfo[]; children: ReactNode }) {
  const [page, setPage] = useState<string | null>(null);
  return <PagesContext value={{ pages, page, setPage }}>{children}</PagesContext>;
}

export function usePages(): Pages | null {
  return useContext(PagesContext);
}

/** `/ [icon Page ⌄]`: the page showing, and a menu of the others. */
export function PagePicker() {
  const ctx = usePages();
  if (!ctx || ctx.pages.length === 0) return null;
  const { pages, page, setPage } = ctx;
  const current = pages.find((p) => p.id === page) ?? pages[0]!;
  return (
    <>
      <span aria-hidden="true" className="text-outline">
        /
      </span>
      <button
        type="button"
        popoverTarget="pz-pages"
        className="-ml-0.5 inline-flex h-[30px] min-w-0 items-center gap-1.5 rounded-[9px] bg-chip pr-2 pl-[9px] text-sm font-medium text-ink"
        aria-label={`Page: ${current.name}`}
      >
        <PageGlyph icon={current.icon} />
        <span className="truncate">{current.name}</span>
        <Icon name="chevronDown" size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
      </button>
      <div
        id="pz-pages"
        popover="auto"
        className="fixed top-[58px] left-3 m-0 w-[min(260px,calc(100vw-24px))] rounded-[14px] bg-well p-1 text-[15px] text-text shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_16px_48px_rgba(0,0,0,0.16)] dark:shadow-[0_0_0_1px_var(--well-rule),0_16px_48px_rgba(0,0,0,0.6)]"
      >
        {pages.map((p) => (
          <button
            key={p.id}
            type="button"
            popoverTarget="pz-pages"
            popoverTargetAction="hide"
            aria-current={p.id === current.id ? "page" : undefined}
            className="flex h-11 w-full items-center gap-2.5 rounded-[10px] px-3 text-left aria-[current=page]:bg-chip aria-[current=page]:font-medium"
            onClick={() => setPage(p.id)}
          >
            <PageGlyph icon={p.icon} />
            <span className="truncate">{p.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function PageGlyph({ icon }: { icon?: string }) {
  // As the canvas's own tabs: a name it doesn't know is a plain board.
  const name = icon && icon in Icons ? icon : "board";
  return <Icon name={name} size={15} strokeWidth={1.5} className="shrink-0 text-muted" />;
}
