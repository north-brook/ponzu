"use client";

import { appLink, parseDesignLink } from "@ponzu/core";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Apple, Slice } from "@/components/icons";
import { DOWNLOAD } from "@/components/links";

/*
 * Hands the design in the page's #fragment to the Mac app as a ponzu://open link. A browser says
 * nothing when no app takes the link, so the page watches: launching an app takes the page's focus
 * or hides it. If neither happens in two seconds, Ponzu isn't installed and the page offers the
 * download. Focus that leaves later, once the person answers the browser's prompt, still counts.
 */

/** How long the app has to take focus before the page offers the download. */
const WAIT = 2000;

type State = "opening" | "opened" | "missing" | "invalid";

/** The ponzu:// link for the design the fragment names, checked as the Mac app checks it. */
function linkFromHash(hash: string): string | null {
  const raw = `ponzu://open?${hash.replace(/^#/, "")}`;
  const design = parseDesignLink(raw);
  return design ? appLink(design.path, { artboard: design.artboard }) : null;
}

export function OpenDesign() {
  const [link, setLink] = useState<string | null>(null);
  const [state, setState] = useState<State>("opening");

  const open = useCallback((to: string) => {
    setState("opening");
    let settled = false;
    const away = () => {
      if (settled) return;
      settled = true;
      setState("opened");
      cleanup();
    };
    const onVisibility = () => document.hidden && away();
    const cleanup = () => {
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", onVisibility);
    window.location.href = to;
    setTimeout(() => {
      if (!settled && document.hasFocus()) setState("missing");
    }, WAIT);
  }, []);

  useEffect(() => {
    const to = linkFromHash(window.location.hash);
    if (!to) {
      setState("invalid");
      return;
    }
    setLink(to);
    open(to);
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

  if (state === "missing") {
    return (
      <div className="flex flex-col items-center gap-8 text-center animate-swap">
        <div className="flex flex-col items-center gap-3.5">
          <h1 className="m-0 text-[clamp(32px,4.4vw,44px)] leading-[1.09] font-semibold tracking-[-0.035em] text-balance text-ink">
            Open this design in Ponzu.
          </h1>
          <p className="m-0 max-w-[480px] text-[17px]/[27px] text-balance text-muted">
            Your agent made it with Ponzu, the design canvas for agents. Get the Mac app to see it.
          </p>
        </div>
        <div className="flex flex-col items-center gap-3.5">
          <a
            className="inline-flex items-center gap-[9px] rounded-full bg-cta py-[15px] pr-6 pl-5 text-base font-semibold whitespace-nowrap text-cta-ink transition-[translate] duration-150 ease-out hover:-translate-y-px"
            href={DOWNLOAD}
          >
            <Apple />
            Download for Mac
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
    return (
      <Message slice title="Opened in Ponzu." body="You can close this tab.">
        <span className="inline-flex flex-wrap items-center justify-center gap-x-[5px]">
          Didn't open?{" "}
          <button type="button" className={inlineLink} onClick={retry}>
            Try again
          </button>{" "}
          or{" "}
          <a className={`${inlineLink} inline-flex items-center gap-1`} href={DOWNLOAD}>
            <Apple className="size-[13px] shrink-0 -translate-y-px fill-current" />
            download for Mac
          </a>
        </span>
      </Message>
    );
  }

  return (
    <Message slice title="Opening in Ponzu…" body="If your browser asks, choose Open Ponzu." />
  );
}

const inlineLink =
  "cursor-pointer text-ink underline decoration-outline underline-offset-4 hover:decoration-ink";

function Message({
  slice,
  title,
  body,
  children,
}: {
  slice?: boolean;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-7 text-center animate-swap" role="status">
      {slice ? <Slice size={56} /> : null}
      <div className="flex flex-col items-center gap-2.5">
        <h1 className="m-0 text-[32px]/[38px] font-semibold tracking-[-0.03em] text-balance text-ink">
          {title}
        </h1>
        {body ? <p className="m-0 text-[15px]/6 text-muted">{body}</p> : null}
      </div>
      {children ? <div className="text-sm/5 text-faint">{children}</div> : null}
    </div>
  );
}
