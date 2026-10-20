import type { ReactNode } from "react";
import { Apple } from "./icons";

export const REPO = "https://github.com/north-brook/ponzu";
export const DOCS = `${REPO}#readme`;
export const RELEASES = `${REPO}/releases/latest`;
export const SDK = `${REPO}/tree/main/packages/react`;

const btn =
  "inline-flex items-center gap-[9px] whitespace-nowrap rounded-full font-semibold transition-[translate,opacity] duration-150 ease-out hover:-translate-y-px";

export function DownloadButton({
  size = "lg",
  children,
}: {
  size?: "sm" | "lg";
  children: ReactNode;
}) {
  const sizing =
    size === "sm" ? "gap-[7px] py-[9px] pr-4 pl-3.5 text-sm" : "py-[15px] pr-6 pl-5 text-base";
  return (
    <a className={`${btn} ${sizing} bg-cta text-cta-ink`} href={RELEASES}>
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
