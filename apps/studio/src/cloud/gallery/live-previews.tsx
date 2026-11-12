/*
 * The sidebar while an agent works: the open canvas's preview moves on every few seconds, the way
 * the sandbox uploads a new one after each batch of edits, and its row hears other live updates
 * between them. `?board=sidebar-previews-updating` plays it; with `&still` it waits for
 * `window.livePreviews.patch(id, changes)`, which the browser tests drive.
 */
import { useEffect, useState } from "react";
import type { CanvasSummary } from "../model.ts";
import * as f from "./fixtures.ts";
import { CanvasChromeHarness, Harness } from "./harness.tsx";
import brand from "./previews/brand.png";
import checkout from "./previews/checkout.png";
import hero from "./previews/hero.png";
import pricing from "./previews/pricing.png";

const PICTURES = [hero, pricing, checkout, brand];
const EVERY_MS = 2500;

declare global {
  interface Window {
    livePreviews?: {
      patch(id: string, changes: Partial<CanvasSummary>): void;
      /** The whole list: a long sidebar, or a canvas that has no preview yet. */
      set(canvases: CanvasSummary[] | ((now: CanvasSummary[]) => CanvasSummary[])): void;
    };
  }
}

export function LivePreviews() {
  const [canvases, setCanvases] = useState<CanvasSummary[]>(f.teamCanvases);
  useEffect(() => {
    window.livePreviews = {
      patch: (id, changes) =>
        setCanvases((now) => now.map((d) => (d.id === id ? { ...d, ...changes } : d))),
      set: setCanvases,
    };
    if (new URLSearchParams(location.search).has("still")) return;
    let turn = 0;
    const timer = setInterval(() => {
      turn += 1;
      const src = PICTURES[turn % PICTURES.length]!;
      // A new picture, and every other beat an unrelated update: a new object, the same preview.
      setCanvases((now) =>
        now.map((d) =>
          d.id === "cnv_quieter"
            ? { ...d, preview: { light: src, dark: src }, agentState: "working" }
            : d.id === "cnv_pricing"
              ? { ...d, preview: d.preview && { ...d.preview }, needsYou: turn % 2 }
              : d,
        ),
      );
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  const open = canvases.find((d) => d.id === "cnv_quieter") ?? canvases[0] ?? f.teamCanvases[0]!;
  return (
    <Harness
      canvases={canvases}
      openId={open.id}
      chrome={(sidebarOpen) => (
        <CanvasChromeHarness
          canvas={open}
          sidebarOpen={sidebarOpen}
          contributors={f.contributors}
          railOpen={false}
        />
      )}
    >
      {null}
    </Harness>
  );
}
