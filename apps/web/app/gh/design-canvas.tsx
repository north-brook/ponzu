"use client";

import type { Doc } from "@ponzu/core";
import { Canvas, MemorySource } from "@ponzu/react";
import "@ponzu/react/styles.css";
import { useState, useSyncExternalStore } from "react";
import { usePages } from "./pages";

const DARK = "(prefers-color-scheme: dark)";
/** Tailwind's `sm`, where the top bar's page picker takes over from the canvas's bars. */
const PHONE = "(max-width: 639.98px)";

/** Whether a media query matches, live. False on the server and in the first client render. */
function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** The system's color scheme, live. Light on the server and in the first client render. */
export function useSystemTheme(): "light" | "dark" {
  return useMedia(DARK) ? "dark" : "light";
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
  const phone = useMedia(PHONE);
  return (
    <Canvas
      source={source}
      theme={theme}
      readOnly
      footer={!phone}
      // A phone starts on the first board at full width, to scroll down from, not the page at 6%.
      initialFit={phone ? "first" : "page"}
      page={pages?.page ?? undefined}
      onPageChange={pages?.setPage}
    />
  );
}
