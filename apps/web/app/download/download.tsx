"use client";

import posthog from "posthog-js";
import { useEffect, useState } from "react";
import { phone } from "@/components/device";
import { Check } from "@/components/icons";
import { DMG, DownloadButton } from "@/components/links";

/**
 * The page's one action. The button is a plain link to the DMG: GitHub serves
 * it as an attachment, so the browser saves it and the page stays. On the
 * press it turns into the confirmation, and the line under it turns from what
 * the download needs into what to do once it lands.
 */
export function Download({ installer, started: initial }: { installer: string; started: boolean }) {
  const [started, setStarted] = useState(initial);

  const button = (
    <div className="flex flex-col items-center gap-3 animate-swap">
      <DownloadButton href={DMG} onClick={() => setStarted(true)}>
        Download for Mac
      </DownloadButton>
      <p className="m-0 flex items-center gap-2.5 text-sm/5 text-faint">
        <span>Apple silicon</span>
        <span aria-hidden="true" className="h-3 w-px bg-outline" />
        <span>macOS 12+</span>
      </p>
    </div>
  );
  if (!started) return button;
  // Nothing downloads on a phone (AutoStart below), so a phone keeps the button, which hands the
  // link to a computer. The device classes decide before the first paint.
  return (
    <>
      <div className="desktop-only flex flex-col items-center gap-3 animate-swap">
        <p className="m-0 flex items-center gap-2 rounded-full bg-chip py-[15px] pr-6 pl-5 text-base font-semibold text-ink">
          <Check />
          Download started
        </p>
        <p className="m-0 max-w-[440px] text-center text-sm/5 text-pretty text-faint">
          When it finishes, open <span className="text-ink">{installer}</span> from your Downloads
          folder. If nothing downloaded,{" "}
          <a
            className="text-ink underline decoration-outline underline-offset-4 hover:decoration-ink"
            href={DMG}
          >
            download it again
          </a>
          .
        </p>
      </div>
      <div className="phone-only">{button}</div>
    </>
  );
}

/**
 * Starts the download the page is already explaining, for links that ask for
 * it (`?start=1`, which every Download button on the site sends). A hidden
 * frame requests the DMG once: it is an attachment, so nothing navigates and
 * the steps stay on screen. Session storage keeps a reload or the second
 * effect pass in development from downloading it twice. A phone gets no download: it can't open
 * the disk image, and its Download button sends the link to a computer instead. The key names no
 * version: the link always serves the newest build, and the version lookup
 * can fail on one load and succeed on the next.
 */
export function AutoStart() {
  const [src, setSrc] = useState<string>();

  useEffect(() => {
    // A link sent from a phone (components/handoff.tsx) arriving: count it, then tidy the address.
    const url = new URL(location.href);
    if (url.searchParams.get("via") === "handoff") {
      if (posthog.__loaded) posthog.capture("handoff arrived");
      url.searchParams.delete("via");
      history.replaceState(history.state, "", url);
    }
    // A phone can't open the disk image: its Download button sends the link on instead.
    if (phone()) return;
    const key = "ponzu-download-started";
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage refused (private window). One request per mount is still right.
    }
    setSrc(DMG);
  }, []);

  if (!src) return null;
  return <iframe hidden src={src} tabIndex={-1} title="Ponzu download" />;
}
