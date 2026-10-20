import type { Metadata } from "next";
import { ProductDemo } from "@/components/demo/product-demo";
import { Wedge } from "@/components/icons";

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
      className="relative flex h-[630px] w-[1200px] flex-col overflow-hidden bg-[#fbfaf7]"
      data-share-card
    >
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 80% at 100% 0%, rgb(255 210 63 / 0.22), transparent 70%), radial-gradient(50% 60% at 0% 100%, rgb(244 176 18 / 0.12), transparent 70%)",
        }}
      />

      <div className="relative flex items-end justify-between px-[72px] pt-[60px]">
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3 text-[30px] font-bold tracking-[-0.03em] text-[#0e0e0e]">
            <Wedge size={44} />
            Ponzu
          </div>
          <h1 className="m-0 max-w-[720px] text-[60px] leading-[1.02] font-semibold tracking-[-0.035em] text-balance text-[#0e0e0e]">
            The design canvas for your coding agent.
          </h1>
        </div>
        <div className="flex flex-col items-end gap-2.5 pb-2 text-[21px] text-[#5a5a5a]">
          <span>Open source · MIT</span>
          <span>Runs on your Mac</span>
          <span className="font-mono text-[18px] text-[#0e0e0e]">ponzu.design</span>
        </div>
      </div>

      {/* The real demo, held on the moment you comment on a design. It runs off the bottom edge. */}
      <div className="dm-frame-host relative mx-auto mt-[40px] w-[1056px]">
        <ProductDemo />
      </div>
    </div>
  );
}
