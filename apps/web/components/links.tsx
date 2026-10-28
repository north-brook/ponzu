import type { ReactNode } from "react";
import { btn } from "./button";
import { GitHub } from "./icons";

export const REPO = "https://github.com/north-brook/ponzu";
export const RELEASES = `${REPO}/releases/latest`;
/** Every download: the Mac, Windows and Linux, the iPhone beta and the CLI. */
export const DOWNLOAD = "/download";
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

export function GitHubButton({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={`${btn} bg-chip py-[15px] pr-6 pl-5 text-base text-text ${className}`}
      href={REPO}
    >
      <GitHub />
      {children}
    </a>
  );
}
