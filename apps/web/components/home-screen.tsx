"use client";

import { Icon } from "@ponzu/react";
import Image from "next/image";
import { AgentMark } from "./agent-marks";

/**
 * The "Every design on your Macs" tile: the app's home screen (apps/studio's dashboard), with the
 * repo's example designs. Their previews are the canvas renders Ponzu writes to `.ponzu/preview.png`,
 * the same images Finder shows as the files' icons.
 */
const FILES = [
  { name: "Weft", src: "/home/weft.jpg", machine: "This Mac", laptop: false, ago: "Just now" },
  {
    name: "Kettle",
    src: "/home/kettle.jpg",
    machine: "MacBook Air",
    laptop: true,
    ago: "2 hours ago",
  },
  { name: "Halon", src: "/home/halon.jpg", machine: "This Mac", laptop: false, ago: "Yesterday" },
];

export function HomeScreen() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-4 rounded-[14px] bg-well p-4 shadow-[inset_0_0_0_1px_var(--well-rule)] sm:p-5"
    >
      <div className="flex h-10 items-center gap-2.5 rounded-[10px] bg-tile px-3.5 text-[14px] text-faint">
        <Icon name="search" size={18} className="shrink-0" />
        <span className="flex-1">Search designs</span>
        <span className="text-xs">⌘K</span>
      </div>
      <div className="flex items-baseline justify-between text-xs text-muted">
        <span>Recent</span>
        <span>3 files on 2 Macs</span>
      </div>
      <ul className="m-0 grid list-none grid-cols-1 gap-x-4 gap-y-5 p-0 sm:grid-cols-3">
        {FILES.map((file, i) => (
          <li key={file.name} className="flex min-w-0 flex-col gap-2.5">
            <div
              className={`relative aspect-[16/10] overflow-hidden rounded-xl bg-[#f3f3f1] ${
                i === 0
                  ? "shadow-[0_0_0_1.5px_var(--rind),0_6px_20px_rgba(244,176,18,0.22)]"
                  : "shadow-[0_0_0_1px_var(--well-rule)]"
              }`}
            >
              <Image
                alt=""
                className="size-full object-contain"
                draggable={false}
                height={500}
                src={file.src}
                width={800}
              />
              {i === 0 && (
                <span className="absolute top-2.5 left-2.5 flex h-6 items-center gap-1.5 rounded-full bg-white/85 pr-2.5 pl-[7px] text-xs text-[#0e0e0e] shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_2px_6px_rgba(0,0,0,0.06)] backdrop-blur-md">
                  <AgentMark agent="claude" size={13} />
                  Designing…
                </span>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
              <span className="truncate text-[13.5px] font-medium text-ink">{file.name}</span>
              <span className="flex items-center gap-[5px] text-xs text-muted">
                <span className="text-faint">
                  <Icon name={file.laptop ? "laptop" : "desktop"} size={13} strokeWidth={1.7} />
                </span>
                {file.machine}
                <span className="text-faint">·</span>
                {file.ago}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
