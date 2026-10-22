"use client";

import { useParams } from "next/navigation";
import type { CSSProperties } from "react";
import { Slice } from "@/components/icons";
import { pill, TopBar } from "../chrome";
import { folderName, parseTarget } from "../target";

/*
 * While GitHub answers: the bar as it will be (the crumbs come from the URL), a thin progress
 * line under it, and artboard skeletons on the canvas that stagger in 90ms apart with a sheen,
 * over the Pages and Controls bars. As designed in .context/github-viewer.design (States ›
 * Loading). The sheen and the stagger stop for reduced motion (.gv-* in globals.css).
 */

/** Two rows of three, each a heading bar and a grid of blocks. */
const BOARDS = [2, 3, 2, 3, 2, 3].map((cols, i) => ({
  cols,
  i,
  blocks: cols === 2 ? ["wide", "narrow"] : ["a", "b", "c"],
}));

export default function Loading() {
  const slug = useParams<{ slug: string[] }>().slug;
  const target = slug ? parseTarget(slug) : null;
  const design = target?.kind === "design";
  const crumbs = target
    ? [
        { label: target.owner },
        { label: target.ref ? `${target.repo}@${target.ref}` : target.repo },
        ...(design ? [{ label: folderName(target.path), file: true }] : []),
      ]
    : [];
  return (
    <div className="gv-loading relative flex h-dvh flex-col" aria-busy="true">
      <TopBar
        crumbs={crumbs}
        githubUrl={target ? `https://github.com/${target.owner}/${target.repo}` : undefined}
      >
        {design ? (
          // Where the button will be, inert until the design arrives.
          <span
            aria-hidden="true"
            className={`${pill} bg-cta pr-[15px] pl-3 text-[13.5px] text-cta-ink opacity-90`}
          >
            <Slice size={15} className="[--slice:var(--yuzu)] dark:[--slice:var(--cta-ink)]" />
            Open in Ponzu
          </span>
        ) : null}
      </TopBar>
      <div
        aria-hidden="true"
        className="gv-progress absolute inset-x-0 top-[51px] z-10 h-0.5 origin-left bg-yuzu"
      />
      <main className="relative flex-1 overflow-hidden bg-[var(--gv-canvas)]">
        <span className="sr-only" role="status">
          Loading the design from GitHub…
        </span>
        <div className="absolute top-1/2 left-1/2 grid w-[min(1216px,calc(100vw-48px))] -translate-x-1/2 -translate-y-[55%] grid-cols-3 gap-x-8 gap-y-12 max-md:grid-cols-1 max-md:gap-y-10">
          {BOARDS.map(({ cols, i, blocks }) => (
            <div
              key={i}
              className={`gv-board relative aspect-[384/230] ${i > 0 ? "max-md:hidden" : ""} ${i > 2 ? "max-lg:hidden" : ""}`}
              style={{ "--i": i } as CSSProperties}
            >
              <span className="absolute -top-[18px] left-0 h-2 w-16 rounded bg-[var(--gv-block)]" />
              <div className="relative size-full overflow-hidden bg-[var(--gv-surface)] shadow-[var(--gv-board-shadow)]">
                <div className="gv-sheen absolute inset-0" />
                <div className="absolute top-[18px] left-[18px] h-2 w-16 rounded bg-[var(--gv-line)]" />
                <div
                  className="absolute inset-x-[18px] top-11 bottom-[18px] grid gap-2.5"
                  style={{ gridTemplateColumns: cols === 2 ? "2fr 1fr" : "1fr 1fr 1fr" }}
                >
                  {blocks.map((b) => (
                    <div key={b} className="rounded-md bg-[var(--gv-block)]" />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="absolute inset-x-2.5 bottom-2.5 flex justify-between gap-2.5 text-[13px] max-sm:hidden">
          <div className="gv-bar flex gap-0.5 rounded-xl p-1">
            {["w-14", "w-[88px]", "w-16", "w-10"].map((w, n) => (
              <span
                key={w}
                className={`flex h-7 items-center rounded-lg px-2.5 ${n === 0 ? "bg-[var(--gv-raised)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : ""}`}
              >
                <span className={`h-2 rounded bg-[var(--gv-line)] ${w}`} />
              </span>
            ))}
          </div>
          <div className="gv-bar flex items-center gap-0.5 rounded-xl p-1">
            <span className="flex h-7 items-center px-2.5 text-[12.5px] text-[var(--gv-label)]">
              Viewing
            </span>
            <span className="grid h-7 min-w-10 place-items-center">
              <span className="h-2 w-7 rounded bg-[var(--gv-line)]" />
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
