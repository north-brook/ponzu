"use client";

import type { MouseEventHandler, ReactNode } from "react";
import { btn } from "./button";
import { phone } from "./device";
import { Apple } from "./icons";

/** Opens the handoff sheet (components/handoff.tsx), wherever it's mounted. */
export function openHandoff() {
  window.dispatchEvent(new Event("ponzu:handoff"));
}

/**
 * The Download button. On a computer it's a plain link to the install steps (or the DMG). On a
 * phone, where Ponzu doesn't run, it opens the sheet that sends the download to a computer instead.
 */
export function DownloadButton({
  size = "lg",
  href,
  onClick,
  className = "",
  children,
}: {
  size?: "sm" | "lg";
  href: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  className?: string;
  children: ReactNode;
}) {
  const sizing =
    size === "sm" ? "gap-[7px] py-[9px] pr-4 pl-3.5 text-sm" : "py-[15px] pr-6 pl-5 text-base";
  return (
    <a
      className={`${btn} ${sizing} bg-cta text-cta-ink ${className}`}
      href={href}
      onClick={(e) => {
        if (phone()) {
          e.preventDefault();
          openHandoff();
          return;
        }
        onClick?.(e);
      }}
    >
      <Apple />
      {children}
    </a>
  );
}
