import type { MouseEventHandler, ReactNode } from "react";
import { Apple } from "./icons";

export const REPO = "https://github.com/north-brook/ponzu";
export const DOCS = `${REPO}#readme`;
export const RELEASES = `${REPO}/releases/latest`;
/** The newest signed build. The release workflow keeps this file name across versions. */
export const DMG = `${RELEASES}/download/Ponzu-arm64.dmg`;
/** The install steps, which start the download as they open. */
export const DOWNLOAD = "/download?start=1";
export const SDK = `${REPO}/tree/main/packages/react`;

const btn =
  "inline-flex items-center gap-[9px] whitespace-nowrap rounded-full font-semibold transition-[translate,opacity] duration-150 ease-out hover:-translate-y-px";

export function DownloadButton({
  size = "lg",
  href = DOWNLOAD,
  onClick,
  children,
}: {
  size?: "sm" | "lg";
  href?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  children: ReactNode;
}) {
  const sizing =
    size === "sm" ? "gap-[7px] py-[9px] pr-4 pl-3.5 text-sm" : "py-[15px] pr-6 pl-5 text-base";
  return (
    <a className={`${btn} ${sizing} bg-cta text-cta-ink`} href={href} onClick={onClick}>
      <Apple />
      {children}
    </a>
  );
}

export function OutlineButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className={`${btn} px-6 py-[15px] text-base text-text shadow-[inset_0_0_0_1.5px_var(--outline)]`}
      href={href}
    >
      {children}
    </a>
  );
}
