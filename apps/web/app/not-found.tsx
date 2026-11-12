import type { Metadata } from "next";
import { Footer, Nav } from "@/components/chrome";

// An address the site doesn't have. Its own title, so the tab doesn't read as the home page.
export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />
      <header className="flex flex-col items-center gap-6 pt-[88px] pb-14 text-center max-[720px]:pt-14 max-[720px]:pb-10">
        <h1 className="m-0 text-[clamp(44px,6vw,72px)] leading-[1.06] font-semibold tracking-[-0.035em] text-balance text-ink">
          Nothing here.
        </h1>
        <p className="m-0 max-w-[560px] text-[19px]/[31px] text-balance text-muted">
          This address isn't a page on ponzu.design. It may have moved, or the link may be cut
          short.
        </p>
        <a
          className="inline-flex items-center rounded-full bg-cta px-6 py-[15px] text-base font-semibold text-cta-ink"
          href="/"
        >
          Go to the home page
        </a>
      </header>
      <Footer />
    </div>
  );
}
