"use client";

import { useState } from "react";
import { Slice } from "@/components/icons";

/*
 * "Open in Ponzu for Mac": hands the design to the Mac app as a ponzu://open link. A browser says
 * nothing when no app takes the link, so the button watches: launching an app takes the page's
 * focus or hides it, and if neither happens in about a second and a half, Ponzu isn't installed.
 */

/** How long the app has to take focus before the page says it isn't there. */
const WAIT = 1500;

export function OpenAppButton({ link }: { link: string }) {
  const [missing, setMissing] = useState(false);

  const open = () => {
    setMissing(false);
    let left = false;
    const away = () => {
      left = true;
    };
    const onVisibility = () => document.hidden && away();
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", onVisibility);
    window.location.href = link;
    setTimeout(() => {
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", onVisibility);
      if (!left && document.hasFocus()) setMissing(true);
    }, WAIT);
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-cta text-sm font-semibold text-cta-ink transition-[translate] duration-150 ease-out hover:-translate-y-px"
        onClick={open}
      >
        <Slice size={16} className="[--slice:currentColor]" />
        Open in Ponzu
      </button>
      {missing ? (
        <p className="m-0 text-center text-[12.5px] text-muted" role="status">
          Ponzu isn't installed.{" "}
          <a className="font-medium text-text hover:text-ink" href="/download">
            Download Ponzu →
          </a>
        </p>
      ) : null}
    </div>
  );
}
