"use client";

import { HANDOFF_WAIT_MS } from "@ponzu/core/handoff";
import { useCallback, useEffect, useRef, useState } from "react";
import { appOf } from "@/app/canvases/[id]/app-link";
import {
  handoffCta as cta,
  handoffBody as missingBody,
  handoffTitle as missingTitle,
} from "./handoff-page";
import { DownloadArrow, Slice } from "./icons";
import { DOWNLOAD, TESTFLIGHT } from "./links";

/*
 * Hands a canvas, or Settings, to the app: the canvas link page (app/canvases/[id]) and the
 * settings page (app/settings), which emails link to, know the app's link from their address and
 * pass it as `to`, and `what` says which of the two the page's words are about. A browser says nothing when no app takes the link, so the page
 * watches: launching an app takes the page's focus or hides it. If neither happens in two seconds,
 * Ponzu isn't installed and the page offers it: the Mac download, or on an iPhone, word of the
 * TestFlight beta. Focus that leaves later, once the person answers the browser's prompt, still
 * counts. Once Ponzu has it the page closes itself; a browser that won't let it says the tab can
 * go.
 *
 * The API's GitHub setup page and the Mac app's sign-in page are this same handoff, as one
 * document that a host can serve as a string (@ponzu/core/handoff); this page shares its wait and
 * the apps' names, and draws the rest with the site's own components.
 *
 * Ponzu 1's /local page read its link from the #fragment through this component too. That page
 * is now a retired landing (app/local/page.tsx), so only `to` is left.
 */

/** How long the app has to take focus before the page offers the download. */
const WAIT = HANDOFF_WAIT_MS;

type State = "opening" | "opened" | "missing" | "invalid";

/** What a link opens, in the words the page uses for it once the app hasn't taken it. */
const WORDS = {
  canvas: {
    missing: (app: string) => `Open this canvas in ${app}.`,
    lead: "This is a canvas in Ponzu.",
    get: "Get the app to see it.",
  },
  settings: {
    missing: (app: string) => `Open Settings in ${app}.`,
    lead: "This link opens Settings in Ponzu.",
    get: "Get the app, then open the link again.",
  },
} as const;

/**
 * `to` is the app's link, or null when the page's path can't name a canvas (a settings link always
 * has one: every part of it is optional).
 */
export function OpenInApp({
  to,
  what = "canvas",
}: {
  to: string | null;
  what?: keyof typeof WORDS;
}) {
  const words = WORDS[what];
  const [state, setState] = useState<State>(to ? "opening" : "invalid");
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

  useEffect(() => {
    if (to) open(to);
    else setState("invalid");
    return () => stop.current?.();
  }, [open, to]);

  const retry = to ? () => open(to) : undefined;

  if (state === "invalid") {
    return (
      <Message title="This link doesn't open a canvas." body="Ask for the canvas's link again." />
    );
  }

  // `to` is known on the server too, so the first render already names the right app.
  const app = appOf(to);

  // A link for Ponzu Dev that nothing took: no download of an app it isn't, only the way again.
  if (state === "missing" && !app.release) {
    return (
      <div className="flex flex-col items-center gap-8 text-center animate-swap">
        <div className="flex flex-col items-center gap-3.5">
          <h1 className={missingTitle}>{words.missing(app.name)}</h1>
          <p className={missingBody}>
            {app.name} didn't open. On a Mac with it installed, open it and try again.
          </p>
        </div>
        <button type="button" className={cta} onClick={retry}>
          <Slice size={18} className="[--slice:currentColor]" />
          Open in {app.name}
        </button>
      </div>
    );
  }

  if (state === "missing" && onIPhone()) {
    return (
      <div className="flex flex-col items-center gap-8 text-center animate-swap">
        <div className="flex flex-col items-center gap-3.5">
          <h1 className={missingTitle}>{words.missing("Ponzu")}</h1>
          <p className={missingBody}>{words.lead} Ponzu for iPhone is in a TestFlight beta.</p>
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
          <h1 className={missingTitle}>{words.missing("Ponzu")}</h1>
          <p className={missingBody}>
            {words.lead} {words.get}
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
    return <Message slice title={`Opened in ${app.name}.`} body="You can close this tab." />;
  }

  return (
    <Message
      slice
      title={`Opening in ${app.name}…`}
      body={`If your browser asks, choose Open ${app.name}.`}
    />
  );
}

/**
 * An iPhone, where the Mac download is no use. Read only once the page has given up on the app,
 * which is after hydration, so the server's render never depends on it.
 */
function onIPhone() {
  return /iPhone|iPod/.test(navigator.userAgent);
}

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
