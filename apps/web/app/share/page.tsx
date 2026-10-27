import type { Metadata } from "next";
import Image from "next/image";
import { Slice } from "@/components/icons";

/**
 * The share card, at exactly 1200×630. Not linked from the site: `scripts/share-image.ts` screenshots
 * it into `app/opengraph-image.jpg` and `app/twitter-image.jpg`, so the card is set in the site's
 * own type.
 *
 * Designed in .context/share.design (Directions › AD3c): the canvas at night, the lockup at the top
 * left and the headline low, under real boards from the example designs receding on a tilted plane.
 * Every board is dark, so nothing outshouts the yuzu slice. The bottom 96px stay empty, because X
 * stamps the domain in the bottom left.
 */
export const metadata: Metadata = {
  title: "Share card",
  robots: { index: false, follow: false },
};

/**
 * Boards from examples/*.design, exported 1200px wide into /public/share, in grid order, served as
 * they are. Heights are at the plane's doubled size (below).
 */
const BOARDS = [
  { src: "/share/kettle-voice.jpg", height: 480 },
  { src: "/share/halon-mark.jpg", height: 500 },
  { src: "/share/weft-applications.jpg", height: 500 },
  { src: "/share/halon-landing.jpg", height: 500 },
  { src: "/share/weft-rules.jpg", height: 500 },
];

export default function ShareCard() {
  return (
    <div
      className="relative flex h-[630px] w-[1200px] flex-col overflow-hidden px-[72px] pt-[56px] pb-[96px] text-[#f4f3ef]"
      style={{
        background:
          "radial-gradient(circle, rgb(255 255 255 / 0.09) 1.2px, transparent 1.4px) 0 0 / 24px 24px, #0e0e0d",
      }}
      data-share-card
    >
      {/*
        The canvas, tilted away: three 400px boards a row, rising to the right and off the edges.
        Chrome rasterizes a layer in perspective at its own size, so the plane is laid out at twice
        that and halved inside the transform, or the boards come out soft in the 2× screenshot.
      */}
      <div
        aria-hidden="true"
        className="absolute top-[150px] left-[560px] grid w-[2600px] grid-cols-[repeat(3,800px)] items-start gap-[72px]"
        style={{
          transform: "perspective(1600px) rotateX(38deg) rotateZ(-24deg) scale(0.5)",
          transformOrigin: "0 0",
        }}
      >
        {BOARDS.map((board) => (
          <Image
            key={board.src}
            alt=""
            src={board.src}
            width={800}
            height={board.height}
            loading="eager"
            unoptimized
            className="rounded-[8px] shadow-[0_0_0_2px_rgb(255_255_255/0.1),0_48px_80px_rgb(0_0_0/0.6)]"
          />
        ))}
      </div>

      <div className="relative flex items-center gap-[14px] font-display text-[44px] font-bold tracking-[-0.05em]">
        <Slice size={52} className="[--slice:#ffc81e]" />
        <span className="-translate-y-[0.04em] leading-none">ponzu</span>
      </div>
      <h1 className="relative m-0 mt-auto w-[580px] font-display text-[80px] leading-none font-semibold tracking-[-0.035em]">
        The design canvas for your coding agent.
      </h1>
    </div>
  );
}
