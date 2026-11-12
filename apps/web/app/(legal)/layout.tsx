import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer, Nav } from "@/components/chrome";
import { DraftNotice, LastUpdated } from "@/components/draft-notice";
import { legalRobots } from "@/components/legal-status";
import { Prose } from "@/components/prose";

/*
 * The legal pages (privacy, terms, subprocessors, security): each a page.mdx in this group, in
 * the site's prose column. While LEGAL_STATUS (components/site.ts) is "draft", every one is kept
 * out of search, left out of the sitemap, and opens with the draft notice. The facts behind each
 * claim, and the questions counsel will ask, are in docs/legal.md.
 */

export const metadata: Metadata = { robots: legalRobots() };

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />
      <div className="pt-[72px] max-[720px]:pt-10">
        <Prose>
          <DraftNotice />
          {children}
          <LastUpdated />
        </Prose>
      </div>
      <Footer />
    </div>
  );
}
