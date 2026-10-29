"use client";

import { useEffect } from "react";
import { Footer, Nav } from "@/components/chrome";
import { reportError } from "@/components/report-error";

// A page that threw while rendering. The root layout's own errors land in global-error.tsx.
export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => reportError(error, "page"), [error]);

  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />
      <header className="flex flex-col items-center gap-6 pt-[88px] pb-14 text-center max-[720px]:pt-14 max-[720px]:pb-10">
        <h1 className="m-0 text-[clamp(44px,6vw,72px)] leading-[1.06] font-semibold tracking-[-0.035em] text-balance text-ink">
          Something broke.
        </h1>
        <p className="m-0 max-w-[560px] text-[19px]/[31px] text-balance text-muted">
          This page hit an error. Trying again often gets past it.
        </p>
        <button
          type="button"
          className="cursor-pointer rounded-full bg-cta px-6 py-[15px] text-base font-semibold text-cta-ink"
          onClick={retry}
        >
          Try again
        </button>
      </header>
      <Footer />
    </div>
  );
}
