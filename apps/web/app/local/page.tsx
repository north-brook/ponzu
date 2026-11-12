import type { Metadata } from "next";
import { DownloadArrow } from "@/components/icons";
import { DOWNLOAD } from "@/components/links";
import { RetiredLanding } from "@/components/retired";

/*
 * Ponzu 1's agents linked to a design on the person's Mac as
 * https://ponzu.design/local#mac=<name>&file=<path>, and before that /open#… (next.config.ts
 * redirects it here, with its fragment). Ponzu now runs in the cloud, so the page has nothing to
 * hand on: it says what the link was and offers the app. The fragment is never read.
 */

export const metadata: Metadata = {
  // The layout adds " · Ponzu".
  title: "Ponzu 1 link",
  description: "This link opened a design in Ponzu 1.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <RetiredLanding
      title="This link opened a design on a Mac running Ponzu 1."
      body="Ponzu now runs in the cloud. Designs from Ponzu 1 are still folders on that Mac."
      action={{ href: DOWNLOAD, label: "Download Ponzu", icon: <DownloadArrow /> }}
    />
  );
}
