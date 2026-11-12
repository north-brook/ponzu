import type { ReactNode } from "react";
import { btn } from "./button";
import { GitHub } from "./icons";
import { IPHONE_PATH } from "./platforms";
import { CONTACT } from "./site";

export { TESTFLIGHT } from "./site";

export const REPO = "https://github.com/north-brook/ponzu";
export const RELEASES = `${REPO}/releases/latest`;
/** Every download: the Mac, Windows and Linux, and the iPhone beta. */
export const DOWNLOAD = "/download";
export const CONTRIBUTING = `${REPO}/blob/main/CONTRIBUTING.md`;
export const LICENSE = `${REPO}/blob/main/LICENSE`;
export const PRIVACY = "/privacy";
export const TERMS = "/terms";
export const SUBPROCESSORS_PAGE = "/subprocessors";
export const SECURITY = "/security";
export const CONTACT_MAIL = `mailto:${CONTACT.hello}`;
export const PRICING = "/pricing";
/** Every release's notes since Ponzu Cloud's first, both apps (app/changelog). */
export const CHANGELOG = "/changelog";
/** Ponzu for iPhone: /iphone, which forwards to the beta or the App Store (next.config.ts). */
export const IPHONE = IPHONE_PATH;

/** A link in the header or the footer: what it says, and where it goes. */
export interface SiteLink {
  label: string;
  href: string;
}

/*
 * Every link in the header and the footer, in order. A slice that adds a page adds its line here
 * (and to app/sitemap.ts), so slices built side by side each touch one line. routes.test.ts
 * checks that every one resolves.
 */

/** The header's links, after the lockup and before the Download button. GitHub gets its mark. */
export const NAV: readonly SiteLink[] = [
  { label: "Pricing", href: PRICING },
  { label: "Changelog", href: CHANGELOG },
  { label: "GitHub", href: REPO },
];

/** The footer's columns, beside the lockup. */
export const FOOTER: readonly { title: string; links: readonly SiteLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Download", href: DOWNLOAD },
      { label: "Ponzu for iPhone", href: IPHONE },
      { label: "Pricing", href: PRICING },
      { label: "Changelog", href: CHANGELOG },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Privacy", href: PRIVACY },
      { label: "Terms", href: TERMS },
      { label: "Subprocessors", href: SUBPROCESSORS_PAGE },
      { label: "Security", href: SECURITY },
      { label: "Contact", href: CONTACT_MAIL },
    ],
  },
  {
    title: "Open source",
    links: [
      { label: "GitHub", href: REPO },
      { label: "MIT License", href: LICENSE },
      { label: "Contributing", href: CONTRIBUTING },
    ],
  },
];

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
