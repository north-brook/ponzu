"use client";

import { appLink, parseDesignLink } from "@ponzu/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadArrow, Slice } from "@/components/icons";
import { DOWNLOAD, TESTFLIGHT } from "@/components/links";

/*
 * Hands the design in the page's #fragment to Ponzu as a ponzu://open link, which the Mac app and
 * the iPhone app both take. A browser says nothing when no app takes the link, so the page watches:
 * launching an app takes the page's focus or hides it. If neither happens in two seconds, Ponzu
 * isn't installed and the page offers it: the Mac download, or on an iPhone, word of the TestFlight
 * beta. Focus that leaves later, once the person answers the browser's prompt, still counts. Once
 * Ponzu has it the page closes itself; a browser that won't let it says the tab can go.
 */

/** How long the app has to take focus before the page offers the download. */
const WAIT = 2000;

type State = "opening" | "opened" | "missing" | "invalid";

/** The ponzu:// link for the design the fragment names, checked as the apps check it. */
function linkFromHash(hash: string): string | null {
  const raw = `ponzu://open?${hash.replace(/^#/, "")}`;
  const design = parseDesignLink(raw);
  return design
    ? appLink(design.path, { page: design.page, artboard: design.artboard, mac: design.mac })
    : null;
}

export function OpenDesign() {
  const [link, setLink] = useState<string | null>(null);
  const [state, setState] = useState<State>("opening");
  /** Stops the attempt in flight: its timer and its watch for the app taking focus. */
  const stop = useRef<() => void>(undefined);

  const open = useCallback((to: string) => {
    stop.current?.();
    setState("opening");
    const away = () => {
      end();
      setState("opened");
      window.close();
    };
    const onVisibility = () => document.hidden && away();
    const timer = setTimeout(() => {
      if (document.hasFocus()) setState("missing");
    }, WAIT);
    const end = () => {
      clearTimeout(timer);
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", onVisibility);
      stop.current = undefined;
    };
    stop.current = end;
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", onVisibility);
    window.location.href = to;
  }, []);

  // The fragment can change without a reload, when another link opens in this tab.
  useEffect(() => {
    const read = () => {
      const to = linkFromHash(window.location.hash);
      setLink(to);
      if (to) open(to);
      else {
        stop.current?.();
        setState("invalid");
      }
    };
    read();
    window.addEventListener("hashchange", read);
    return () => {
      window.removeEventListener("hashchange", read);
      stop.current?.();
    };
  }, [open]);

  const retry = link ? () => open(link) : undefined;

  if (state === "invalid") {
    return (
      <Message
        title="This link doesn't open a design."
        body="Ask your agent for the design's link again."
      />
    );
  }

  if (state === "missing" && onIPhone()) {
    return (
      <div className="flex flex-col items-center gap-8 text-center animate-swap">
        <div className="flex flex-col items-center gap-3.5">
          <h1 className={missingTitle}>Open this design in Ponzu.</h1>
          <p className={missingBody}>
            Your agent made it with Ponzu, the open source canvas for agents. Ponzu for iPhone,
            which opens the designs on your Macs, is in a TestFlight beta.
          </p>
        </div>
        <div className="flex flex-col items-center gap-3.5">
          {TESTFLIGHT ? (
            <a className={cta} href={TESTFLIGHT}>
              Join the beta
            </a>
          ) : null}
          <p className="m-0 text-sm/5 text-faint">
            Already have it?{" "}
            <button type="button" className={inlineLink} onClick={retry}>
              Open in Ponzu
            </button>
          </p>
        </div>
      </div>
    );
  }

  if (state === "missing") {
    return (
      <div className="flex flex-col items-center gap-8 text-center animate-swap">
        <div className="flex flex-col items-center gap-3.5">
          <h1 className={missingTitle}>Open this design in Ponzu.</h1>
          <p className={missingBody}>
            Your agent made it with Ponzu, the open source canvas for agents. Get the app to see it.
          </p>
        </div>
        <div className="flex flex-col items-center gap-3.5">
          <a className={cta} href={DOWNLOAD}>
            <DownloadArrow />
            Download Ponzu
          </a>
          <p className="m-0 text-sm/5 text-faint">
            Already have it?{" "}
            <button type="button" className={inlineLink} onClick={retry}>
              Open in Ponzu
            </button>
          </p>
        </div>
      </div>
    );
  }

  if (state === "opened") {
    return <Message slice title="Opened in Ponzu." body="You can close this tab." />;
  }

  return (
    <Message slice title="Opening in Ponzu…" body="If your browser asks, choose Open Ponzu." />
  );
}

/**
 * An iPhone, where the Mac download is no use. Read only once the page has given up on the app,
 * which is after hydration, so the server's render never depends on it.
 */
function onIPhone() {
  return /iPhone|iPod/.test(navigator.userAgent);
}

const missingTitle =
  "m-0 text-[clamp(32px,4.4vw,44px)] leading-[1.09] font-semibold tracking-[-0.035em] text-balance text-ink";
const missingBody = "m-0 max-w-[480px] text-[17px]/[27px] text-balance text-muted";
const cta =
  "inline-flex items-center gap-[9px] rounded-full bg-cta py-[15px] pr-6 pl-5 text-base font-semibold whitespace-nowrap text-cta-ink transition-[translate] duration-150 ease-out hover:-translate-y-px";

const inlineLink =
  "cursor-pointer text-ink underline decoration-outline underline-offset-4 hover:decoration-ink";

function Message({ slice, title, body }: { slice?: boolean; title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center gap-7 text-center animate-swap" role="status">
      {slice ? <Slice size={56} /> : null}
      <div className="flex flex-col items-center gap-2.5">
        <h1 className="m-0 text-[32px]/[38px] font-semibold tracking-[-0.03em] text-balance text-ink">
          {title}
        </h1>
        {body ? <p className="m-0 text-[15px]/6 text-muted">{body}</p> : null}
      </div>
    </div>
  );
}
