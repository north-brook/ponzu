import type { ComponentProps, ReactNode } from "react";
import { btn } from "./button";
import { DownloadButton as ClientDownloadButton } from "./download-button";
import { GitHub } from "./icons";

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

/** The Download button (components/download-button.tsx), to the install steps unless told otherwise. */
export function DownloadButton({
  href = DOWNLOAD,
  ...props
}: Omit<ComponentProps<typeof ClientDownloadButton>, "href"> & { href?: string }) {
  return <ClientDownloadButton href={href} {...props} />;
}

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

/**
 * Under the Download button on a phone, which hands the download to a computer: the other way to get
 * Ponzu there, the iPhone beta. Hidden on Android, where it can't install.
 */
export function PhonePlatforms() {
  if (!TESTFLIGHT) return null;
  return (
    <p className="phone-only ios-only m-0 -mt-2 flex items-center justify-center text-sm text-muted">
      <a className="inline-flex h-11 items-center gap-1.5 px-1" href={TESTFLIGHT}>
        <svg viewBox="0 0 14 16" width={11} height={14} fill="none" aria-hidden="true">
          <rect
            x="2.5"
            y="0.8"
            width="9"
            height="14.4"
            rx="2.2"
            stroke="currentColor"
            strokeWidth={1.6}
          />
        </svg>
        <span className="underline decoration-outline underline-offset-4">iPhone beta</span>
        <span aria-hidden="true" className="text-xs text-faint">
          ↗
        </span>
      </a>
    </p>
  );
}
