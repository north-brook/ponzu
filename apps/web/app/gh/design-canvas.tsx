"use client";

import type { Doc } from "@ponzu/core";
import { Canvas, MemorySource } from "@ponzu/react";
import "@ponzu/react/styles.css";
import { useState, useSyncExternalStore } from "react";

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
  return <Canvas source={source} theme={theme} readOnly />;
}
