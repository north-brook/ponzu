import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { ChromiumRenderer, findChromium } from "./chromium.ts";

const chromium = findChromium();

// Real Chrome, filming tens of frames; allow for a busy machine.
setDefaultTimeout(60_000);

const u32 = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

describe.skipIf(!chromium)("motion loops in Chromium", () => {
  const renderer = new ChromiumRenderer({ executablePath: chromium ?? undefined });
  afterAll(() => renderer.close(), 30_000);

  const { artboard } = parseArtboardFile(
    `<section data-artboard data-id="ab_loop" data-name="Loops" style="width:600px;height:300px;padding:40px;gap:40px;flex-direction:row">
<style>
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes pulse { 50% { opacity: .2 } }
@keyframes drift { to { transform: translateX(500px) } }
.a { width: 40px; height: 40px; background: #e33; animation: spin 1s linear infinite }
.b { width: 40px; height: 40px; margin-left: 300px; background: #33e; animation: pulse 0.5s ease-in-out infinite; animation-delay: -0.1s }
.c { position: absolute; left: 20px; top: 240px; width: 20px; height: 20px; background: #3a3; animation: drift 23s linear infinite }
</style>
<div class="a" data-id="n_a"></div><div class="b" data-id="n_b"></div><p data-id="n_p">still text</p><div class="c" data-id="n_c"></div>
</section>`,
    { id: "ab_loop", name: "Loops" },
  );

  test("films each looping part in its own exact period, and leaves too-long ones still", async () => {
    const out = await renderer.loop({ artboard, tokens: "", scale: 0.5, maxPeriod: 4000 });
    // The spinner and the pulse are far apart: two regions, 1 s and 0.5 s. (Near each
    // other, they would share one 1 s video: 0.5 s divides 1 s.)
    const periods = out.regions.map((r) => r.period).sort((a, b) => a - b);
    expect(periods).toEqual([500, 1000]);
    // The 23 s drift is past the cap: still.
    expect(out.still.some((s) => s.reason === "period")).toBe(true);
    for (const r of out.regions) {
      // 30 filmed frames a second, each shown twice: 60 samples a second.
      expect(r.frames).toBe(Math.round((r.period / 1000) * 30));
      expect(r.ids.length).toBe(1);
      // A playable MP4: ftyp, then moov, whose mdhd says the loop's length exactly.
      const b = r.bytes;
      expect(String.fromCharCode(...b.subarray(4, 8))).toBe("ftyp");
      const moov = u32(b, 0);
      expect(String.fromCharCode(...b.subarray(moov + 4, moov + 8))).toBe("moov");
      const text = new TextDecoder("latin1").decode(b);
      const mdhd = text.indexOf("mdhd") - 4;
      expect(u32(b, mdhd + 24) / u32(b, mdhd + 20)).toBeCloseTo(r.period / 1000, 6);
      // Boxes cover the animated element, and stay inside the board.
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(600);
    }
  });

  test("a board without endless animation has nothing to film", async () => {
    const { artboard: still } = parseArtboardFile(
      `<section data-artboard data-id="ab_still" style="width:200px;height:100px"><p>hi</p></section>`,
      { id: "ab_still", name: "Still" },
    );
    const out = await renderer.loop({ artboard: still, tokens: "", scale: 0.5 });
    expect(out.regions).toEqual([]);
    expect(out.motion.loops).toBe(false);
  });
});
