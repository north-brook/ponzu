"use client";

import type { Doc } from "@ponzu/core";
import { Canvas, MemorySource } from "@ponzu/react";
import "@ponzu/react/styles.css";
import { useState, useSyncExternalStore } from "react";
import { usePages } from "./pages";

const DARK = "(prefers-color-scheme: dark)";

/** The system's color scheme, live. Light on the server and in the first client render. */
function useSystemTheme(): "light" | "dark" {
  return useSyncExternalStore(
    (onChange) => {
      const query = matchMedia(DARK);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => (matchMedia(DARK).matches ? "dark" : "light"),
    () => "light",
  );
}

/**
 * A design from GitHub on the real canvas, read-only. Its assets load straight
 * from raw.githubusercontent.com at the commit the server read, so they match
 * the HTML and cache for good.
 */
export function DesignCanvas({ doc, assetBase }: { doc: Doc; assetBase: string }) {
  const [source] = useState(() => new MemorySource(doc, undefined, { assetBase }));
  const theme = useSystemTheme();
  // The page is shared with the top bar's picker, which stands in for the bars on a phone.
  const pages = usePages();
  return (
    <div className="h-full max-sm:[&_[data-slot=canvas-bar]]:hidden">
      <Canvas
        source={source}
        theme={theme}
        readOnly
        footerExtra={<Viewing />}
        page={pages?.page ?? undefined}
        onPageChange={pages?.setPage}
      />
    </div>
  );
}

/** Where the studio's tools sit, a calm word that this canvas only looks. */
function Viewing() {
  return (
    <span
      className="flex h-7 items-center gap-1.5 pr-2.5 pl-2 text-[12.5px] text-[var(--pz-muted)]"
      title="Read-only. Open in Ponzu to comment and edit."
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-3.5 fill-none stroke-current"
        strokeWidth={1.6}
        strokeLinecap="round"
      >
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      Viewing
    </span>
  );
}
