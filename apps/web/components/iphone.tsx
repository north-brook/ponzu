import type { CSSProperties } from "react";

/**
 * The "And in your pocket." tile: Ponzu for iPhone (apps/mobile) leaving a spoken comment. Kettle's
 * Money screen is a board on the phone's canvas with a new comment's pin on its balance, and the
 * comment sheet is in voice: the words so far, then mute, the waveform in its capsule, and send
 * (apps/mobile/components/composer.tsx). Only the bottom of the phone shows, rising from the tile's
 * edge, so the sheet sits where a thumb would be.
 */
const BARS = [
  4, 8, 14, 6, 10, 18, 12, 6, 4, 9, 16, 20, 11, 5, 8, 14, 7, 4, 10, 17, 13, 6, 9, 15, 8, 5, 12, 6,
];

export function IPhone() {
  return (
    <div
      aria-hidden="true"
      className="phone relative mt-auto h-[380px] w-[288px] shrink-0 self-center rounded-t-[48px] bg-[#0b0b0a] px-2 pt-2 shadow-[0_0_0_1px_var(--phone-bezel-rule),0_30px_80px_-24px_var(--shot-shadow)] lg:h-[420px]"
    >
      <div className="relative h-full overflow-hidden rounded-t-[40px] bg-(--phone-canvas)">
        <span className="absolute top-6 left-6 text-[10px] text-[#807c73]">6 Money</span>
        {/* biome-ignore lint/performance/noImgElement: a fixed-size board in a mock, no layout shift */}
        <img
          src="/iphone/kettle-money.webp"
          alt=""
          width={224}
          height={485}
          className="absolute top-10 left-6 w-[224px] rounded-[3px] shadow-[0_0_0_1px_var(--phone-hairline)]"
        />
        {/* A new comment's pin, on the balance. */}
        <span className="absolute top-[124px] left-[96px] grid size-[22px] place-items-center rounded-full bg-yuzu text-[15px] leading-none font-semibold text-[#111110] shadow-[0_0_0_1px_rgb(17_17_16/0.12),0_2px_6px_rgb(0_0_0/0.18)]">
          +
        </span>

        <div className="absolute inset-x-1.5 bottom-0 flex flex-col gap-3 rounded-t-[26px] bg-(--phone-sheet) px-4 pt-2.5 pb-6 shadow-[0_-8px_28px_rgb(0_0_0/0.1)]">
          <span className="mx-auto h-1 w-9 rounded-full bg-(--phone-hairline)" />
          <p className="m-0 px-0.5 text-[14px]/[20px] text-(--phone-ink)">
            Make the balance bigger and lose the card shadow. It should feel calm, not like a
            warning
            <span className="phone-caret ml-0.5 inline-block h-4 w-0.5 translate-y-[3px] bg-yuzu" />
          </p>
          <div className="flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-(--phone-glass) text-(--phone-ink)">
              <Mic />
            </span>
            <span className="flex h-8 min-w-0 flex-1 items-center justify-center gap-[3px] overflow-hidden rounded-full bg-(--phone-glass) px-3">
              {BARS.map((h, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of bar heights
                  key={i}
                  className="phone-bar w-[2px] shrink-0 rounded-full bg-(--phone-ink)"
                  style={{ height: h, "--i": i } as CSSProperties}
                />
              ))}
            </span>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-(--phone-ink) text-(--phone-sheet)">
              <ArrowUp />
            </span>
          </div>
          <span className="absolute bottom-2 left-1/2 h-1 w-24 -translate-x-1/2 rounded-full bg-(--phone-ink)" />
        </div>
      </div>
    </div>
  );
}

/** Hugeicons' Mic01, as the app draws mute. */
function Mic() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 6.5C7 4.01472 9.01472 2 11.5 2C13.9853 2 16 4.01472 16 6.5V11.5C16 13.9853 13.9853 16 11.5 16C9.01472 16 7 13.9853 7 11.5V6.5Z" />
      <path d="M11.5 19H11.0828C7.57267 19 4.57706 16.4623 4 13M11.5 19H11.9172C15.4273 19 18.4229 16.4623 19 13M11.5 19V22" />
    </svg>
  );
}

/** Hugeicons' ArrowUp02, as the app draws send. */
function ArrowUp() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5.5V19" />
      <path d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11" />
    </svg>
  );
}
