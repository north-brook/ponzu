/*
 * The sidebar while an agent works: the open design's preview moves on every few seconds, the way
 * the sandbox uploads a new one after each batch of edits, and its row hears other live updates
 * between them. `?board=sidebar-previews-updating` plays it; with `&still` it waits for
 * `window.livePreviews.patch(id, changes)`, which the browser tests drive.
 */
import { useEffect, useState } from "react";
import type { DesignSummary } from "../model.ts";
import * as f from "./fixtures.ts";
import { DesignChromeHarness, Harness } from "./harness.tsx";
import brand from "./previews/brand.png";
import checkout from "./previews/checkout.png";
import hero from "./previews/hero.png";
import pricing from "./previews/pricing.png";

const PICTURES = [hero, pricing, checkout, brand];
const EVERY_MS = 2500;

declare global {
  interface Window {
    livePreviews?: { patch(id: string, changes: Partial<DesignSummary>): void };
  }
}

export function LivePreviews() {
  const [designs, setDesigns] = useState(f.teamDesigns);
  useEffect(() => {
    window.livePreviews = {
      patch: (id, changes) =>
        setDesigns((now) => now.map((d) => (d.id === id ? { ...d, ...changes } : d))),
    };
    if (new URLSearchParams(location.search).has("still")) return;
    let turn = 0;
    const timer = setInterval(() => {
      turn += 1;
      const src = PICTURES[turn % PICTURES.length]!;
      // A new picture, and every other beat an unrelated update: a new object, the same preview.
      setDesigns((now) =>
        now.map((d) =>
          d.id === "dsn_quieter"
            ? { ...d, preview: { light: src, dark: src }, agentState: "working" }
            : d.id === "dsn_pricing"
              ? { ...d, preview: d.preview && { ...d.preview }, needsYou: turn % 2 }
              : d,
        ),
      );
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  const open = designs.find((d) => d.id === "dsn_quieter")!;
  return (
    <Harness
      designs={designs}
      openId={open.id}
      chrome={(sidebarOpen) => (
        <DesignChromeHarness
          design={open}
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
