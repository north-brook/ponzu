import { ArrowUp02Icon, Mic01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../ui/icon.tsx";
import { AppleMark } from "../ui/marks.tsx";
import { QrCode } from "../ui/qr.tsx";
import kettleMoney from "./kettle-money.webp";
import { SetupCard, StepButton, StepLayout } from "./step.tsx";

/** Where the QR code sends a phone: a page that forwards to the App Store, so it never needs reprinting. */
export const IPHONE_URL = "https://ponzu.design/iphone";

/**
 * Get Ponzu on your iPhone: the last step on the Mac, a QR code to the App Store and one button
 * on. Nothing is paired; the phone signs in with the same GitHub account. Below, the phone
 * rises from the canvas's edge, leaving a spoken comment.
 */
export function IphoneStep({
  onStart,
  starting = false,
}: {
  onStart: () => void;
  starting?: boolean;
}) {
  return (
    <StepLayout
      progress={3}
      title="Get Ponzu on your iPhone"
      body="Comment on canvases and answer Ponzu's questions from your phone. You'll get a notification when a pull request is ready."
      actions={
        <StepButton onClick={onStart} busy={starting}>
          Start designing
        </StepButton>
      }
      below={<PhoneMock />}
    >
      <IphoneCard />
    </StepLayout>
  );
}

/** The QR code to the App Store, and what to do with it: the step's card, and Settings'. */
export function IphoneCard() {
  return (
    <SetupCard className="flex-row items-center gap-[18px] px-4 py-3.5">
      {/*
       * Dark on white in either theme, so any phone's camera reads it: 25 modules at 3px in a
       * quiet zone of four, the board's 100px tile to within a pixel.
       */}
      <div
        className="shrink-0 rounded-10 p-3 shadow-[0_0_0_1px_var(--c-rule)]"
        style={{ background: "#ffffff", color: "#111110" }}
      >
        <QrCode text={IPHONE_URL} module={3} label="QR code for Ponzu on the App Store" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-[7px] font-medium text-14 text-ink">
          <AppleMark size={15} />
          Scan with your iPhone
        </span>
        <span className="text-13 text-muted leading-[1.5]">
          Sign in with the same GitHub account. Every canvas is already there.
        </span>
      </div>
    </SetupCard>
  );
}

/** Heights of the waveform's bars, as the marketing site's phone draws them. */
const BARS = [
  4, 8, 14, 6, 10, 18, 12, 6, 4, 9, 16, 20, 11, 5, 8, 14, 7, 4, 10, 17, 13, 6, 9, 15, 8, 5, 12, 6,
];

/*
 * The phone is a picture of the iPhone app in its light appearance, the marketing site's "in
 * your pocket" phone (apps/web/components/iphone.tsx) at this board's size, so its colors are
 * the app's own rather than this window's.
 */
const PHONE = {
  bezel: "#0b0b0a",
  canvas: "#f4f3ef",
  sheet: "#ffffff",
  ink: "#111110",
  label: "#807c73",
  glass: "rgb(17 17 16 / 0.06)",
  hairline: "rgb(17 17 16 / 0.08)",
};

function PhoneMock() {
  return (
    <div
      aria-hidden
      // Below a window this short it would reach the button: then it isn't drawn.
      className="absolute bottom-0 left-[calc(50%-150px)] h-[290px] w-[300px] rounded-t-[50px] px-2 pt-2 shadow-[0_30px_80px_-24px_rgba(40,30,0,0.28)] [@media(max-height:759px)]:hidden"
      style={{ background: PHONE.bezel }}
    >
      <div
        className="relative h-full overflow-hidden rounded-t-[42px]"
        style={{ background: PHONE.canvas }}
      >
        <span className="absolute top-[26px] left-[26px] text-10" style={{ color: PHONE.label }}>
          6 Money
        </span>
        <img
          src={kettleMoney}
          alt=""
          width={232}
          draggable={false}
          className="absolute top-[42px] left-[26px] w-[232px] rounded-3"
          style={{ boxShadow: `0 0 0 1px ${PHONE.hairline}` }}
        />
        {/* A new comment's pin, on the balance. */}
        <span className="absolute top-[130px] left-[100px] grid size-[22px] place-items-center rounded-pill bg-yuzu font-semibold text-[15px] text-yuzu-ink leading-none shadow-[0_0_0_1px_rgba(17,17,16,0.12),0_2px_6px_rgba(0,0,0,0.18)]">
          +
        </span>
        <div
          className="absolute inset-x-1.5 bottom-0 flex flex-col gap-3 rounded-t-[26px] px-4 pt-2.5 pb-[26px] shadow-[0_-8px_28px_rgba(0,0,0,0.1)]"
          style={{ background: PHONE.sheet, color: PHONE.ink }}
        >
          <span className="mx-auto h-1 w-9 rounded-pill" style={{ background: PHONE.hairline }} />
          <p className="m-0 px-0.5 text-14 leading-5">
            Make the balance bigger and lose the card shadow. It should feel calm, not like a
            warning
            <span className="blink ml-0.5 inline-block h-4 w-0.5 translate-y-[3px] bg-yuzu" />
          </p>
          <div className="flex items-center gap-2">
            <span
              className="grid size-8 shrink-0 place-items-center rounded-pill"
              style={{ background: PHONE.glass }}
            >
              <Icon icon={Mic01Icon} step="control" />
            </span>
            <span
              className="flex h-8 min-w-0 flex-1 items-center justify-center gap-[3px] overflow-hidden rounded-pill px-3"
              style={{ background: PHONE.glass }}
            >
              {BARS.map((h, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of bar heights
                  key={i}
                  className="wave w-0.5 shrink-0 rounded-pill"
                  style={{ height: h, background: PHONE.ink, animationDelay: `${-170 * i}ms` }}
                />
              ))}
            </span>
            <span
              className="grid size-8 shrink-0 place-items-center rounded-pill"
              style={{ background: PHONE.ink, color: PHONE.sheet }}
            >
              <Icon icon={ArrowUp02Icon} step="control" onFill />
            </span>
          </div>
          <span
            className="absolute bottom-2 left-1/2 h-1 w-24 -translate-x-1/2 rounded-pill"
            style={{ background: PHONE.ink }}
          />
        </div>
      </div>
    </div>
  );
}
