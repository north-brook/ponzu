"use client";

import { AgentMark, Icon } from "@ponzu/react";
import type { ReactNode } from "react";
import "./demo/ponzu.css";

/**
 * The "Your Macs. One home screen." tile: the app's home screen (apps/studio's dashboard) as it
 * looks while an agent works, with the repo's example designs. Same parts as the app: search with
 * Open and New, the Recent tab, project chips, and cards that show where each design lives. The
 * one an agent is in gets the canvas's yuzu trace, a shimmering name and the agent's mark. Previews are the canvas
 * renders Ponzu writes to `.ponzu/preview.png` and `preview-dark.png`; the one shown follows the
 * color scheme, as in the app.
 */
const FILES = [
  { name: "Weft", src: "/home/weft", branch: "brand-refresh", ago: "now", agent: "claude" },
  { name: "Kettle", src: "/home/kettle", branch: "main", ago: "2h", machine: "MacBook Air" },
  { name: "Halon", src: "/home/halon", branch: "onboarding", ago: "1d" },
];

export function HomeScreen() {
  return (
    <div
      aria-hidden="true"
      className="home flex flex-col gap-6 rounded-[14px] p-4 shadow-[inset_0_0_0_1px_var(--well-rule)] sm:p-6"
    >
      <div className="flex items-center gap-1">
        <div className="flex h-10 flex-1 items-center gap-2.5 rounded-[10px] bg-well px-3.5 text-[14px] text-faint shadow-[0_0_0_1px_var(--home-rule)]">
          <Icon name="search" size={18} className="shrink-0" />
          <span className="flex-1">Search designs</span>
          <span className="text-xs">⌘F</span>
        </div>
        <span className="w-1.5" />
        <span className="grid size-10 place-items-center text-muted max-sm:hidden">
          <Icon name="folderOpen" size={18} />
        </span>
        <span className="grid size-10 place-items-center text-muted max-sm:hidden">
          <Icon name="add" size={18} />
        </span>
      </div>

      <div className="flex flex-col gap-3.5">
        <span className="flex items-baseline gap-[5px] text-[13px] font-medium text-ink">
          Recent <span className="text-[11px] font-normal text-faint tabular-nums">3</span>
        </span>
        <div className="flex flex-wrap gap-1.5">
          <Chip on count={3}>
            All
          </Chip>
          {FILES.map((f) => (
            <Chip key={f.name} count={1} branch>
              {f.name.toLowerCase()}
            </Chip>
          ))}
        </div>
      </div>

      <ul className="m-0 grid list-none grid-cols-1 gap-x-5 gap-y-6 p-0 sm:grid-cols-3">
        {FILES.map((file) => (
          <li key={file.name} className="flex min-w-0 flex-col gap-2.5">
            <div className="home-preview relative aspect-[16/11] overflow-hidden rounded-xl shadow-[0_0_0_1px_var(--home-rule)]">
              <picture>
                <source srcSet={`${file.src}-dark.jpg`} media="(prefers-color-scheme: dark)" />
                <img
                  alt=""
                  className="absolute inset-0 size-full object-contain"
                  draggable={false}
                  height={500}
                  loading="lazy"
                  src={`${file.src}.jpg`}
                  width={800}
                />
              </picture>
              {file.agent && <Trace />}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span
                  className={`min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink ${
                    file.agent ? "pz-shimmer" : ""
                  }`}
                >
                  {file.name}
                </span>
                {/* As in the app: while an agent edits it, its mark stands in for the time. */}
                {file.agent ? (
                  <span className="grid shrink-0 place-items-center self-center">
                    <AgentMark client={file.agent} size={13} />
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-faint tabular-nums">{file.ago}</span>
                )}
              </span>
              <span className="flex min-w-0 items-center gap-[5px] text-xs text-muted">
                <Icon name="branch" size={13} strokeWidth={1.7} className="shrink-0 text-faint" />
                <span className="truncate">{file.branch}</span>
                {file.machine && (
                  <>
                    <span className="text-faint">·</span>
                    <Icon
                      name="laptop"
                      size={13}
                      strokeWidth={1.7}
                      className="shrink-0 text-faint"
                    />
                    <span className="shrink-0">{file.machine}</span>
                  </>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Chip({
  on = false,
  branch = false,
  count,
  children,
}: {
  on?: boolean;
  branch?: boolean;
  count: number;
  children: ReactNode;
}) {
  return (
    <span
      className={`flex h-7 items-center gap-1.5 rounded-full px-[11px] text-xs whitespace-nowrap ${
        on ? "bg-ink text-ground" : "text-muted shadow-[inset_0_0_0_1px_var(--home-rule-strong)]"
      }`}
    >
      {branch && <Icon name="branch" size={13} strokeWidth={1.6} className="opacity-80" />}
      {children}
      <span className="opacity-60 tabular-nums">{count}</span>
    </span>
  );
}

/** The trace around the card of the design an agent is in: six yuzu dashes marching round it. */
function Trace() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full overflow-visible text-yuzu"
    >
      <rect
        x="0.75"
        y="0.75"
        width="calc(100% - 1.5px)"
        height="calc(100% - 1.5px)"
        rx="11.25"
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.6}
        strokeWidth={1}
      />
      <rect
        className="pz-trace"
        x="0.75"
        y="0.75"
        width="calc(100% - 1.5px)"
        height="calc(100% - 1.5px)"
        rx="11.25"
        pathLength={100}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
      />
    </svg>
  );
}
