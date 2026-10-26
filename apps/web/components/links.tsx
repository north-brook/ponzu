import type { MouseEventHandler, ReactNode } from "react";
import { Apple, GitHub } from "./icons";

export const REPO = "https://github.com/north-brook/ponzu";
export const RELEASES = `${REPO}/releases/latest`;
/** The newest signed build. The release workflow keeps this file name across versions. */
export const DMG = `${RELEASES}/download/Ponzu-arm64.dmg`;
/** The install steps, which start the download as they open. */
export const DOWNLOAD = "/download?start=1";
export const SDK = `${REPO}/tree/main/packages/react`;
export const CONTRIBUTING = `${REPO}/blob/main/CONTRIBUTING.md`;
export const LICENSE = `${REPO}/blob/main/LICENSE`;
export const PRIVACY = "/privacy";
/**
 * Ponzu for iPhone's public TestFlight link: the app is in TestFlight only. Null hides the link and
 * the site just says it's in beta.
 */
export const TESTFLIGHT: string | null = "https://testflight.apple.com/join/JXpn8sP5";
/** The iPhone tile on the home page. */
export const IPHONE = "/#iphone";

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

export function GitHubButton({ children }: { children: ReactNode }) {
  return (
    <a className={`${btn} bg-chip py-[15px] pr-6 pl-5 text-base text-text`} href={REPO}>
      <GitHub />
      {children}
    </a>
  );
}
