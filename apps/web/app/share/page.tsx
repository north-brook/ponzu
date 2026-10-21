import type { Metadata } from "next";
import { ProductDemo } from "@/components/demo/product-demo";
import { Slice } from "@/components/icons";

/**
 * The share card, at exactly 1200×630. Not linked from the site: `scripts/share-image.ts` screenshots
 * it into `app/opengraph-image.png`, so the card shows the real demo in the site's own type.
 */
export const metadata: Metadata = {
  title: "Share card",
  robots: { index: false, follow: false },
};

export default function ShareCard() {
  return (
    <div
      className="relative flex h-[630px] w-[1200px] flex-col overflow-hidden bg-[#faf9f6]"
      data-share-card
    >
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 80% at 100% 0%, rgb(255 200 30 / 0.28), transparent 70%), radial-gradient(50% 60% at 0% 100%, rgb(255 200 30 / 0.12), transparent 70%)",
        }}
      />

      <div className="relative flex items-end justify-between px-[72px] pt-[60px]">
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3 font-display text-[34px] font-bold tracking-[-0.05em] text-[#111110]">
            <Slice size={40} className="[--slice:#111110]" />
            <span className="-translate-y-[0.04em] leading-none">ponzu</span>
          </div>
          <h1 className="m-0 max-w-[720px] font-display text-[60px] leading-[1.02] font-semibold tracking-[-0.035em] text-balance text-[#111110]">
            The design canvas for your coding agent.
          </h1>
        </div>
        <div className="flex flex-col items-end gap-2.5 pb-2 text-[21px] text-[#5e5b54]">
          <span>Open source · MIT</span>
          <span>Runs on your Mac</span>
          <span className="font-mono text-[18px] text-[#111110]">ponzu.design</span>
        </div>
      </div>

      {/* The real demo, held on the moment you comment on a design. It runs off the bottom edge. */}
      <div className="dm-frame-host relative mx-auto mt-[40px] w-[1056px]">
        <ProductDemo />
      </div>
    </div>
  );
}
