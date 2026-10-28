"use client";

import posthog from "posthog-js";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { btn } from "./button";
import { type Phone, phone } from "./device";
import { Check, Slice } from "./icons";
import { TESTFLIGHT } from "./links";

/*
 * The handoff: a phone can't run Ponzu, so its Download buttons open this sheet, which sends the
 * download to the person's computer. Sharing (AirDrop, Messages, Notes, Android's "Send to your
 * devices") or copying puts the install steps' link there; opening it on the computer starts the
 * download. Designed in .context/windows-linux.design (Phones › 1–5 and M1–M4).
 *
 * The slice is the moment: it blooms when the sheet opens and again once the link is sent. The rest
 * is the house ease and short travel (`.handoff` in globals.css).
 */

/** Where the link lands: the Mac install steps, which start the download as they open. */
const PATH = "/download?start=1&via=handoff";
const SHARE_TITLE = "Download Ponzu for Mac";
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

type State = "send" | "sent";

function track(event: string) {
  if (posthog.__loaded) posthog.capture(event);
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The sheet, mounted once in the root layout. Download buttons open it on a phone. */
export function Handoff() {
  const dialog = useRef<HTMLDialogElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const from = useRef<number | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [kind, setKind] = useState<Phone | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [state, setState] = useState<State>("send");
  const [leaving, setLeaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const open = () => {
      setKind(phone());
      setCanShare(typeof navigator.share === "function");
      setState("send");
      setCopied(false);
      setClosing(false);
      dialog.current?.showModal();
      track("handoff opened");
    };
    window.addEventListener("ponzu:handoff", open);
    return () => window.removeEventListener("ponzu:handoff", open);
  }, []);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const close = useCallback(() => {
    if (!dialog.current?.open) return;
    if (reducedMotion()) {
      dialog.current.close();
      return;
    }
    setClosing(true);
  }, []);

  /** Swaps between sending and sent: the old pane leaves, then the sheet eases to the new height. */
  const swap = useCallback((next: State) => {
    if (reducedMotion()) {
      setState(next);
      return;
    }
    setLeaving(true);
    setTimeout(() => {
      from.current = sheet.current?.offsetHeight ?? null;
      setLeaving(false);
      setState(next);
    }, 180);
  }, []);

  useLayoutEffect(() => {
    const el = sheet.current;
    if (!el || from.current === null) return;
    const to = el.offsetHeight;
    if (to !== from.current)
      el.animate([{ height: `${from.current}px` }, { height: `${to}px` }], {
        duration: 450,
        easing: EASE,
      });
    from.current = null;
  }, [state]);

  const url = () => `${location.origin}${PATH}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url());
    } catch {
      return;
    }
    track("handoff copied");
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const send = async () => {
    if (!canShare) return copy();
    try {
      await navigator.share({ title: SHARE_TITLE, url: url() });
    } catch (e) {
      // Dismissing the share sheet rejects with AbortError: stay as we were.
      if ((e as DOMException).name !== "AbortError") await copy();
      return;
    }
    track("handoff shared");
    swap("sent");
  };

  return (
    // Escape is the keyboard's way out (onCancel); the click is a tap on the scrim around the sheet.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it via onCancel
    <dialog
      ref={dialog}
      className="handoff"
      data-phone={kind ?? undefined}
      data-closing={closing || undefined}
      aria-labelledby="handoff-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onAnimationEnd={(e) => {
        if (closing && e.target === sheet.current) {
          dialog.current?.close();
          setClosing(false);
        }
      }}
    >
      <div ref={sheet} className="handoff-sheet">
        <span className="handoff-grabber" aria-hidden="true" />
        {state === "send" ? (
          <div className="handoff-pane" data-leaving={leaving || undefined}>
            <div className="handoff-rise flex items-start gap-3.5" style={{ "--k": 0 } as Style}>
              <span className="handoff-tile size-[52px] rounded-[13px]">
                <Slice size={30} className="handoff-bloom [--slice:#ffc81e]" />
              </span>
              <div className="flex flex-1 flex-col gap-1 pt-0.5">
                <h2
                  id="handoff-title"
                  className="m-0 font-display text-[22px]/[1.15] font-semibold tracking-[-0.02em] text-ink"
                >
                  Get Ponzu on your computer
                </h2>
                <p className="m-0 text-[15px]/[21px] text-muted">
                  Send yourself the link and open it there.
                </p>
              </div>
              <button type="button" className="handoff-close" aria-label="Close" onClick={close}>
                <svg viewBox="0 0 12 12" width={11} height={11} aria-hidden="true">
                  <path
                    d="M2 2l8 8M10 2l-8 8"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <div className="handoff-rise flex flex-col gap-2.5" style={{ "--k": 1 } as Style}>
              <button
                type="button"
                className={`${btn} h-[54px] justify-center bg-cta text-[17px] text-cta-ink`}
                onClick={send}
              >
                {canShare ? <ShareIcon /> : <CopyIcon />}
                {canShare ? "Send to my Mac" : "Copy link"}
              </button>
              {canShare ? (
                <button
                  type="button"
                  className="handoff-copy"
                  data-copied={copied || undefined}
                  onClick={copy}
                >
                  {copied ? (
                    <Check
                      key="check"
                      className="handoff-draw size-[1em] shrink-0 fill-none stroke-current"
                    />
                  ) : (
                    <CopyIcon />
                  )}
                  <span aria-live="polite">{copied ? "Link copied" : "Copy link"}</span>
                </button>
              ) : copied ? (
                <p className="m-0 text-center text-[15px] text-ok" aria-live="polite">
                  Link copied
                </p>
              ) : null}
            </div>
            {TESTFLIGHT && kind !== "android" ? (
              <p
                className="handoff-rise m-0 flex items-center justify-center gap-1.5 text-sm text-faint"
                style={{ "--k": 2 } as Style}
              >
                Already use Ponzu?
                <a
                  className="font-medium text-ink underline decoration-outline underline-offset-4"
                  href={TESTFLIGHT}
                >
                  Try the iPhone beta
                </a>
              </p>
            ) : null}
          </div>
        ) : (
          <div className="handoff-pane" data-leaving={leaving || undefined}>
            <div className="flex flex-col items-center gap-3.5 px-2 pt-1.5 text-center">
              <span className="handoff-mark">
                <span className="handoff-ring" aria-hidden="true" />
                <span className="handoff-tile handoff-sent-tile size-16 rounded-2xl">
                  <Slice size={38} className="handoff-bloom [--slice:#ffc81e]" />
                </span>
              </span>
              <h2
                id="handoff-title"
                className="handoff-rise m-0 font-display text-[26px]/[1.15] font-semibold tracking-[-0.02em] text-ink"
                style={{ "--k": 2 } as Style}
              >
                On its way to your Mac
              </h2>
              <p
                className="handoff-rise m-0 text-[15px]/[22px] text-muted"
                style={{ "--k": 3 } as Style}
              >
                Open it there to start the download.
              </p>
            </div>
            <div className="handoff-rise flex flex-col gap-2.5" style={{ "--k": 4 } as Style}>
              <button
                type="button"
                className={`${btn} h-[54px] justify-center gap-2 bg-cta text-[17px] text-cta-ink`}
                onClick={close}
              >
                <Check />
                Done
              </button>
              <button
                type="button"
                className="h-11 text-[15px] font-medium text-muted"
                onClick={() => swap("send")}
              >
                Send it again
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}

type Style = CSSProperties & Record<`--${string}`, number>;

function ShareIcon() {
  return (
    <svg viewBox="0 0 18 18" width={17} height={17} fill="none" aria-hidden="true">
      <path
        d="M9 11.5V2m-3.5 3.5L9 2l3.5 3.5M5 8H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 16h10a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 14 8h-1"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" aria-hidden="true">
      <rect
        x="5.5"
        y="5.5"
        width="8.5"
        height="8.5"
        rx="2"
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <path
        d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v5.5A1.5 1.5 0 0 0 3.5 10H4"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}
