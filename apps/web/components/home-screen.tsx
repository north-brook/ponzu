"use client";

import { Icon, Rain } from "@ponzu/react";
import "./demo/ponzu.css";

/**
 * The "All your designs, on every Mac." tile: the app's home screen (apps/studio's dashboard) as it
 * looks while an agent works, with the repo's example designs. Same parts as the app: search with
 * Open and New; one row with the views at the left (Recent, and Archived once something is) and the
 * project menu at the right; and cards that say which project and branch each design is on. The
 * one an agent is in gets a shimmering name and yuzu rain where its time would be. Previews are the
 * canvas renders Ponzu writes to `.ponzu/preview.png` and `preview-dark.png`; the one shown follows
 * the color scheme, as in the app.
 *
 * It's sized by its own width, not the window's: three cards across when it's wide, two when it's
 * a column of the page, and one above another on a phone.
 */
const FILES = [
  { name: "Weft", src: "/home/weft", project: "weft", branch: "brand-refresh", agent: "claude" },
  { name: "Kettle", src: "/home/kettle", project: "kettle-app", branch: "main", ago: "2h" },
  // The third only shows three across or one above another; two across, it would sit alone.
  {
    name: "Halon",
    src: "/home/halon",
    project: "halon",
    branch: "onboarding",
    ago: "1d",
    wide: true,
  },
];

export function HomeScreen() {
  return (
    <div
      aria-hidden="true"
      className="home @container flex flex-col gap-6 rounded-[14px] p-4 shadow-[inset_0_0_0_1px_var(--well-rule)] sm:p-6"
    >
      <div className="flex items-center gap-1">
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] bg-well px-3.5 text-[14px] text-faint shadow-[0_0_0_1px_var(--home-rule)]">
          <Icon name="search" size={18} className="shrink-0" />
          <span className="flex-1 truncate">Search designs</span>
          <span className="text-xs">⌘F</span>
        </div>
        <span className="w-1.5" />
        <span className="grid size-10 place-items-center text-muted @max-sm:hidden">
          <Icon name="folderOpen" size={18} />
        </span>
        <span className="grid size-10 place-items-center text-muted @max-sm:hidden">
          <Icon name="add" size={18} />
        </span>
      </div>

      {/* As in the app: the views at the left, the project at the right. */}
      <div className="-mb-2.5 flex h-7 items-center justify-between gap-4 text-[13px]">
        <div className="flex min-w-0 items-center gap-[18px]">
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <Icon name="clock" size={14} />
            Recent
            <span className="text-[11px] font-normal text-faint tabular-nums">3</span>
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <Icon name="shelved" size={14} className="text-faint" />
            Archived
            <span className="text-[11px] font-normal text-faint tabular-nums">5</span>
          </span>
        </div>
        <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] pr-2 pl-2.5 whitespace-nowrap text-muted">
          <Icon name="folders" size={14} strokeWidth={1.6} />
          <span className="@max-[22rem]:hidden">All projects</span>
          <span className="text-[11px] text-faint tabular-nums">3</span>
          <Icon name="chevronDown" size={13} strokeWidth={2} className="text-faint" />
        </span>
      </div>

      <ul className="m-0 grid list-none grid-cols-1 gap-x-5 gap-y-6 p-0 @sm:grid-cols-2 @2xl:grid-cols-3">
        {FILES.map((file) => (
          <li
            key={file.name}
            className={`flex min-w-0 flex-col gap-2.5 ${file.wide ? "@sm:@max-2xl:hidden" : ""}`}
          >
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
                {/* As in the app: while an agent edits it, yuzu rain stands in for the time. */}
                {file.agent ? (
                  <Rain columns={12} className="self-center text-[17px]" />
                ) : (
                  <span className="shrink-0 text-xs text-faint tabular-nums">{file.ago}</span>
                )}
              </span>
              {/* The project, then the branch (apps/studio's WhereLine). */}
              <span className="flex min-w-0 items-center gap-[5px] text-xs text-muted">
                <Icon name="repo" size={13} strokeWidth={1.7} className="shrink-0 text-faint" />
                <span className="min-w-0 shrink-0 truncate">{file.project}</span>
                <span className="text-faint">·</span>
                <Icon name="branch" size={13} strokeWidth={1.7} className="shrink-0 text-faint" />
                <span className="min-w-0 truncate">{file.branch}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
